import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';

type Handler = (req: NextRequest, seg: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** A cookie-jar client that calls App Router handlers in-process. */
export class TestClient {
  cookies = new Map<string, string>();
  ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  async call<T = any>(handler: Handler, opts: {
    method?: string; path?: string; params?: Record<string, string>; body?: unknown; query?: Record<string, string>;
    headers?: Record<string, string>; csrf?: boolean; idempotencyKey?: string | true;
  } = {}): Promise<{ status: number; body: T; headers: Headers }> {
    const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
    const url = new URL(`http://localhost:3000${opts.path ?? '/api/test'}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers = new Headers(opts.headers);
    headers.set('x-forwarded-for', this.ip);
    if (method !== 'GET' && opts.csrf !== false) headers.set('x-luma-csrf', '1');
    if (opts.idempotencyKey) headers.set('idempotency-key', opts.idempotencyKey === true ? `test-${randomUUID()}` : opts.idempotencyKey);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (opts.body !== undefined) headers.set('content-type', 'application/json');
    const req = new NextRequest(url, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair!.split('=');
      const value = rest.join('=');
      if (!value || /max-age=0/i.test(c)) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
    const text = await res.text();
    let body: any = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { status: res.status, body, headers: res.headers };
  }
}
