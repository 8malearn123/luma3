'use client';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, any>, public requestId?: string) {
    super(message);
  }
}

export function newIdempotencyKey() {
  return `idem-${crypto.randomUUID()}`;
}

/**
 * Fetch wrapper for /api/v1. Sends the CSRF header on every mutation, parses
 * the standard envelope and throws ApiError with the server's stable code.
 */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal; form?: FormData } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['x-luma-csrf'] = '1';
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined), signal: opts.signal, credentials: 'same-origin' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network_error', 'Network error');
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? 'internal_error', e?.message ?? res.statusText, e?.details, e?.request_id);
  }
  return (json?.data ?? json) as T;
}

export const tenantApi = (slug: string) => (path: string) => `/api/v1/t/${slug}${path}`;
