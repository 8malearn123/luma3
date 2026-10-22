import { randomUUID } from 'node:crypto';
import '../boot';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { env } from '../env';
import { resolveSession, requireStepUp, SESSION_COOKIE, type SessionUser } from '../auth/service';
import { platformCapabilities, type Capability, type PlatformCapability } from '../auth/capabilities';
import {
  requireCapability, requireFeature, requireWritable, resolveTenantAccess, type TenantAccess,
} from '../tenancy/access';
import type { AuditActor } from '../infra/audit';
import { enforce } from '../infra/rate-limit';
import { AppError, Errors, fromPgError } from './errors';
import type { PlanFeatureKey } from '@/shared/plans';

type AuthMode = 'public' | 'optional' | 'user' | 'tenant' | 'platform';

export type RouteContext<I, A extends AuthMode> = {
  req: NextRequest;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  locale: 'ar' | 'en';
  params: Record<string, string>;
  input: I;
  idempotencyKey: string | null;
  user: A extends 'public' ? null : A extends 'optional' ? SessionUser | null : SessionUser;
  tenant: A extends 'tenant' ? TenantAccess : null;
  actor: AuditActor;
  /** Lets handlers set cookies/headers on the eventual response. */
  responseInit: { headers: Headers; cookies: Array<{ name: string; value: string; options: CookieOptions }> };
};

export type CookieOptions = { httpOnly?: boolean; secure?: boolean; sameSite?: 'lax' | 'strict'; path?: string; maxAge?: number; expires?: Date };

type Result = Response | { data: unknown; status?: number; meta?: Record<string, unknown> };

type Def<S extends z.ZodTypeAny | undefined, A extends AuthMode> = {
  auth: A;
  /** Tenant routes: any one of these capabilities is required. */
  capability?: Capability | readonly Capability[];
  /** Plan feature gate (server-side). */
  feature?: PlanFeatureKey;
  platformCapability?: PlatformCapability;
  /** Body schema for POST/PUT/PATCH/DELETE, query schema for GET. */
  input?: S;
  rateLimit?: { scope: 'ip' | 'user'; limit: number; windowSec: number; name: string };
  /** 'required': an Idempotency-Key header must be present. */
  idempotency?: 'required' | 'optional';
  /** Mutations on tenant routes are blocked in read-only workspaces unless allowed. */
  allowReadOnly?: boolean;
  stepUp?: boolean;
  /** Requires a verified email or phone (bookings, business creation). */
  requireVerified?: boolean;
  handler: (ctx: RouteContext<S extends z.ZodTypeAny ? z.infer<S> : undefined, A>) => Promise<Result>;
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Client IP for rate limiting. Entries left of our own proxies are client-supplied
 * and spoofable, so we take the entry appended by the outermost trusted proxy:
 * with TRUSTED_PROXY_HOPS=n, the n-th address from the right.
 */
export function clientIp(req: Pick<NextRequest, 'headers'>, hops = env().TRUSTED_PROXY_HOPS): string | null {
  const chain = (req.headers.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const ip = (hops > 0 ? chain[chain.length - hops] : undefined) ?? req.headers.get('x-real-ip') ?? null;
  return ip && /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : null;
}

export function pickLocale(req: NextRequest, user?: SessionUser | null): 'ar' | 'en' {
  const c = req.cookies.get('luma_locale')?.value;
  if (c === 'ar' || c === 'en') return c;
  if (user) return user.locale;
  return req.headers.get('accept-language')?.toLowerCase().startsWith('en') ? 'en' : 'ar';
}

/**
 * CSRF defence for cookie-authenticated mutations: SameSite=Lax cookies plus a
 * custom header (which cross-site forms cannot send without a CORS preflight we
 * never grant) and, when present, an Origin that matches this deployment.
 */
function checkCsrf(req: NextRequest) {
  if (!MUTATING.has(req.method)) return;
  if (req.headers.get('x-luma-csrf') !== '1') throw Errors.forbidden('Missing CSRF header', { reason: 'csrf' });
  const origin = req.headers.get('origin');
  if (origin) {
    const allowed = new Set([new URL(env().APP_URL).origin, req.nextUrl.origin]);
    if (!allowed.has(origin)) throw Errors.forbidden('Cross-origin request rejected', { reason: 'csrf' });
  }
}

async function readInput(req: NextRequest, schema: z.ZodTypeAny | undefined) {
  if (!schema) return undefined;
  let raw: unknown;
  if (req.method === 'GET' || req.method === 'HEAD') {
    raw = Object.fromEntries(req.nextUrl.searchParams.entries());
  } else {
    const text = await req.text();
    if (text.length > 1_000_000) throw Errors.invalid('payload_too_large');
    try {
      raw = text ? JSON.parse(text) : {};
    } catch {
      throw Errors.invalid('invalid_json', 'Request body must be valid JSON');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })));
  }
  return parsed.data;
}

export function errorResponse(err: unknown, requestId: string): NextResponse {
  let appErr: AppError;
  if (err instanceof AppError) appErr = err;
  else {
    const mapped = fromPgError(err);
    if (mapped) appErr = mapped;
    else {
      console.error(`[${requestId}]`, err);
      appErr = new AppError(500, 'internal_error', 'Something went wrong');
    }
  }
  const res = NextResponse.json(
    { error: { code: appErr.code, message: appErr.message, details: appErr.details ?? undefined, request_id: requestId } },
    { status: appErr.status },
  );
  const retry = appErr.details?.retry_after_sec;
  if (appErr.status === 429 && typeof retry === 'number') res.headers.set('Retry-After', String(retry));
  res.headers.set('x-request-id', requestId);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export function route<S extends z.ZodTypeAny | undefined = undefined, A extends AuthMode = AuthMode>(def: Def<S, A>) {
  return async (req: NextRequest, segment: { params: Promise<Record<string, string | string[]>> }) => {
    const requestId = req.headers.get('x-request-id')?.slice(0, 64) || randomUUID();
    try {
      checkCsrf(req);
      const ip = clientIp(req);
      const userAgent = req.headers.get('user-agent');
      const rawParams = (await segment?.params) ?? {};
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawParams)) params[k] = Array.isArray(v) ? v.join('/') : v;

      let user: SessionUser | null = null;
      if (def.auth !== 'public') {
        user = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
        if (!user && def.auth !== 'optional') throw Errors.unauthenticated();
      }
      if (def.requireVerified && user && !user.emailVerified && !user.phoneVerified) {
        throw Errors.forbidden('Verify your email or phone first', { reason: 'unverified' });
      }
      if (def.stepUp && user) requireStepUp(user);

      if (def.rateLimit) {
        const who = def.rateLimit.scope === 'user' && user ? `u:${user.userId}` : `ip:${ip ?? 'unknown'}`;
        await enforce(`rl:${def.rateLimit.name}:${who}`, def.rateLimit.limit, def.rateLimit.windowSec);
      }

      let tenant: TenantAccess | null = null;
      if (def.auth === 'tenant') {
        const slug = params.tenantSlug;
        if (!slug || !user) throw Errors.notFound('business');
        tenant = await resolveTenantAccess(user, slug);
        if (def.capability) requireCapability(tenant, def.capability);
        if (def.feature) requireFeature(tenant, def.feature);
        if (MUTATING.has(req.method) && !def.allowReadOnly) requireWritable(tenant);
      }
      if (def.auth === 'platform') {
        if (!user) throw Errors.unauthenticated();
        const caps = platformCapabilities(user.platformRoles);
        if (caps.size === 0 || (def.platformCapability && !caps.has(def.platformCapability))) throw Errors.notFound();
      }

      const idempotencyKey = req.headers.get('idempotency-key');
      if (def.idempotency === 'required' && !idempotencyKey) {
        throw Errors.invalid('idempotency_key_required', 'An Idempotency-Key header is required for this operation');
      }

      const input = await readInput(req, def.input);
      const actor: AuditActor = {
        userId: user?.userId ?? null,
        kind: !user ? 'anonymous' : tenant?.role === 'support' ? 'support' : def.auth === 'platform' ? 'platform' : tenant ? 'user' : 'customer',
        supportGrantId: tenant?.supportGrantId ?? null,
        requestId,
        ip,
      };
      const responseInit = { headers: new Headers(), cookies: [] as RouteContext<unknown, A>['responseInit']['cookies'] };
      const ctx = {
        req, requestId, ip, userAgent, locale: pickLocale(req, user), params, input, idempotencyKey,
        user, tenant, actor, responseInit,
      } as unknown as RouteContext<S extends z.ZodTypeAny ? z.infer<S> : undefined, A>;

      const result = await def.handler(ctx);
      let res: Response;
      if (result instanceof Response) res = result;
      else {
        res = NextResponse.json({ data: result.data, ...(result.meta ? { meta: result.meta } : {}) }, { status: result.status ?? 200 });
      }
      res.headers.set('x-request-id', requestId);
      if (!res.headers.has('Cache-Control')) res.headers.set('Cache-Control', 'no-store');
      responseInit.headers.forEach((v, k) => res.headers.set(k, v));
      if (responseInit.cookies.length && res instanceof NextResponse) {
        for (const c of responseInit.cookies) res.cookies.set(c.name, c.value, c.options);
      }
      return res;
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

// ── Shared input helpers ─────────────────────────────────────────────────────
export const zUuid = z.string().uuid();
export const zPage = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

/** Opaque keyset cursor: base64url JSON of the last row's sort keys. */
export function encodeCursor(v: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}
export function decodeCursor<T>(c: string | undefined): T | null {
  if (!c) return null;
  try {
    return JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as T;
  } catch {
    throw Errors.invalid('invalid_cursor');
  }
}

export function sessionCookie(token: string, expires: Date): { name: string; value: string; options: CookieOptions } {
  return {
    name: SESSION_COOKIE,
    value: token,
    options: { httpOnly: true, secure: env().isDeployed, sameSite: 'lax', path: '/', expires },
  };
}

export function clearSessionCookie() {
  return { name: SESSION_COOKIE, value: '', options: { httpOnly: true, secure: env().isDeployed, sameSite: 'lax' as const, path: '/', maxAge: 0 } };
}
