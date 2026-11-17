/**
 * Host ports of Loom (host-agnostic core, §4.1). Loom performs outbound HTTP
 * and secret sealing only through these ports; the host wires them once per
 * process (LUMA: src/server/loom-host/runtime.ts → the SSRF-safe fetcher and
 * AES-256-GCM secrets). An extracted Loom service wires its own.
 * Until configured, every call fails closed.
 */
export type LoomHttpRequest = {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Accepted response content types (default: JSON). */
  accept?: RegExp;
  timeoutMs?: number;
  maxBytes?: number;
};
export type LoomHttpResponse = { status: number; contentType: string; text: string };

/** Transport failures and non-2xx responses. `code` mirrors the host fetcher (blocked_address, http_error, timeout…). */
export class LoomHttpError extends Error {
  constructor(public code: string, message?: string, public status?: number) { super(message ?? code); }
}

export type LoomHttp = (req: LoomHttpRequest) => Promise<LoomHttpResponse>;
export type LoomSecrets = { seal(plain: string): string; open(sealed: string): string };

type Runtime = { http: LoomHttp; secrets: LoomSecrets };
const g = globalThis as unknown as { __loomRuntime?: Partial<Runtime> };

export function configureLoomRuntime(r: Partial<Runtime>) {
  g.__loomRuntime = { ...(g.__loomRuntime ?? {}), ...r };
}

export function loomHttp(): LoomHttp {
  const h = g.__loomRuntime?.http;
  if (!h) return async () => { throw new LoomHttpError('http_not_configured', 'Loom has no outbound HTTP port configured'); };
  return h;
}

export function loomSecrets(): LoomSecrets {
  const s = g.__loomRuntime?.secrets;
  if (!s) throw new Error('Loom has no secrets port configured');
  return s;
}
