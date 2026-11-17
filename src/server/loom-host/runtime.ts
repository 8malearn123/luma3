import { configureLoomRuntime, LoomHttpError, type LoomHttp } from '@/loom';
import { safeFetch, SafeFetchError, type SafeFetchOptions } from '../domains/marketing/safe-fetch';
import { decryptSecret, encryptSecret } from '../domains/platform/totp';

/**
 * Wires Loom's host ports in LUMA (imported once by src/server/boot.ts):
 *  - HTTP: every outbound Loom request (REST connector pulls, healthchecks,
 *    outgoing webhooks) goes through the SSRF-safe fetcher (https only,
 *    public addresses only incl. DNS-rebinding checks, size/time limits).
 *  - Secrets: AES-256-GCM with the key derived from AUTH_SECRET (as MFA and
 *    Instagram tokens); stored encrypted, never returned by any API.
 */
export function lumaLoomHttp(base: Pick<SafeFetchOptions, 'transport' | 'resolver'> = {}): LoomHttp {
  return async (req) => {
    try {
      const r = await safeFetch(req.url, {
        ...base, method: req.method, body: req.body, headers: req.headers, accept: req.accept ?? /^application\/json\b/i,
        timeoutMs: req.timeoutMs, maxBytes: req.maxBytes, userAgent: 'LUMA-Loom/1.0',
      });
      return { status: r.status, contentType: r.contentType, text: r.text };
    } catch (e) {
      if (e instanceof SafeFetchError) {
        const status = /HTTP (\d{3})/.exec(e.message)?.[1];
        throw new LoomHttpError(e.code, e.message, status ? Number(status) : undefined);
      }
      throw e;
    }
  };
}

export function configureLumaLoomRuntime(base: Pick<SafeFetchOptions, 'transport' | 'resolver'> = {}) {
  configureLoomRuntime({ http: lumaLoomHttp(base), secrets: { seal: encryptSecret, open: decryptSecret } });
}

configureLumaLoomRuntime();
