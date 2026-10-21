import { lookup as dnsLookup } from 'node:dns';
import { promises as dns } from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';

/**
 * Outbound fetch for trend sources and user-provided links, hardened against SSRF:
 *  - https only, default port, no credentials in the URL, no internal host names;
 *  - every resolved address must be public (blocks private, loopback, link-local,
 *    CGNAT, multicast, reserved, cloud metadata 169.254.169.254 / fd00:ec2::254,
 *    IPv4-mapped/translated IPv6 forms);
 *  - redirects are followed manually (max 3) and each hop is re-validated;
 *  - the default transport re-checks the address at connect time (DNS rebinding);
 *  - total time limit, byte limit and content-type allowlist.
 * Tests inject `resolver` and `transport`, so no network is needed.
 */

export type FetchResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array> | null };
export type Transport = (url: URL, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<FetchResponse>;
export type Resolver = (host: string) => Promise<string[]>;

export class SafeFetchError extends Error {
  constructor(public code: 'invalid_url' | 'blocked_address' | 'too_many_redirects' | 'too_large' | 'timeout' | 'bad_content_type' | 'http_error' | 'network_error', message?: string) {
    super(message ?? code);
  }
}

function v4ToInt(ip: string) {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
function blockedV4(ip: string) {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
}

/** Expands an IPv6 address to 8 16-bit groups (handles :: and embedded IPv4). */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToInt(v4[1]!);
    s = s.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  if (tail === undefined && h.length !== 8) return null;
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return blockedV4(ip);
  if (kind !== 6) return true;
  const g = expandV6(ip);
  if (!g) return true;
  const embedded = () => `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return blockedV4(embedded()) || g[5] === 0; // ::ffff:a.b.c.d / ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return blockedV4(embedded()); // NAT64
  if (g[0] === 0x2002) return blockedV4(`${g[1]! >> 8}.${g[1]! & 0xff}.${g[2]! >> 8}.${g[2]! & 0xff}`); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 (incl. fd00:ec2::254)
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1]! < 0x0200) return true; // 2001::/23 special-purpose (Teredo, ORCHID…)
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only
  return false;
}

const BAD_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

export function checkUrl(raw: string | URL): URL {
  let u: URL;
  try { u = typeof raw === 'string' ? new URL(raw) : raw; } catch { throw new SafeFetchError('invalid_url'); }
  if (u.protocol !== 'https:') throw new SafeFetchError('invalid_url', 'Only https URLs are allowed');
  if (u.username || u.password) throw new SafeFetchError('invalid_url', 'Credentials in URLs are not allowed');
  if (u.port && u.port !== '443') throw new SafeFetchError('invalid_url', 'Only the default https port is allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || BAD_HOST.test(host)) throw new SafeFetchError('blocked_address', 'Internal host names are not allowed');
  if (isIP(host) && isBlockedIp(host)) throw new SafeFetchError('blocked_address');
  return u;
}

export const defaultResolver: Resolver = async (host) => {
  if (isIP(host)) return [host];
  const r = await dns.lookup(host, { all: true, verbatim: true });
  return r.map((x) => x.address);
};

/** Node https transport whose DNS lookup refuses non-public addresses at connect time. */
export const defaultTransport: Transport = (url, init) => new Promise((resolve, reject) => {
  const req = https.request(url, {
    method: 'GET', headers: init.headers, signal: init.signal,
    lookup: (hostname, options, cb) => {
      dnsLookup(hostname, options, (err, address, family) => {
        if (err) return (cb as (e: Error | null, a: string, f: number) => void)(err, '', 0);
        const list = Array.isArray(address) ? address.map((a: { address: string }) => a.address) : [address as string];
        if (list.some((a) => isBlockedIp(a))) return (cb as (e: Error | null, a: string, f: number) => void)(new SafeFetchError('blocked_address'), '', 0);
        (cb as (e: Error | null, a: unknown, f?: number) => void)(null, address, family);
      });
    },
  }, (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }));
  req.on('error', reject);
  req.end();
});

export type SafeFetchOptions = {
  transport?: Transport;
  resolver?: Resolver;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: RegExp;
};

const header = (h: FetchResponse['headers'], k: string) => {
  const v = h[k] ?? h[k.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<{ url: string; status: number; contentType: string; text: string }> {
  const transport = opts.transport ?? defaultTransport;
  const resolver = opts.resolver ?? defaultResolver;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const accept = opts.accept ?? /^(application\/(rss\+xml|atom\+xml|xml|json|feed\+json)|text\/(xml|html|plain))\b/i;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    let url = checkUrl(rawUrl);
    for (let hop = 0; ; hop++) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      let addrs: string[];
      try { addrs = await resolver(host); } catch { throw new SafeFetchError('network_error', 'DNS resolution failed'); }
      if (!addrs.length || addrs.some((a) => isBlockedIp(a))) throw new SafeFetchError('blocked_address');
      let res: FetchResponse;
      try {
        res = await transport(url, { signal: controller.signal, headers: { 'user-agent': 'LUMA-TrendRadar/1.0 (+https://luma.example)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/html;q=0.8, */*;q=0.1' } });
      } catch (e) {
        if (e instanceof SafeFetchError) throw e;
        if (controller.signal.aborted) throw new SafeFetchError('timeout');
        throw new SafeFetchError('network_error', (e as Error).message);
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = header(res.headers, 'location');
        if (!loc) throw new SafeFetchError('http_error', 'Redirect without location');
        if (hop + 1 > maxRedirects) throw new SafeFetchError('too_many_redirects');
        url = checkUrl(new URL(loc, url));
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new SafeFetchError('http_error', `HTTP ${res.status}`);
      const ct = header(res.headers, 'content-type') ?? '';
      if (!accept.test(ct)) throw new SafeFetchError('bad_content_type', ct || 'missing content-type');
      const len = Number(header(res.headers, 'content-length') ?? 'NaN');
      if (Number.isFinite(len) && len > maxBytes) throw new SafeFetchError('too_large');
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        try {
          for await (const chunk of res.body) {
            total += chunk.byteLength;
            if (total > maxBytes) { controller.abort(); throw new SafeFetchError('too_large'); }
            chunks.push(chunk);
          }
        } catch (e) {
          if (e instanceof SafeFetchError) throw e;
          throw new SafeFetchError(controller.signal.aborted ? 'timeout' : 'network_error');
        }
      }
      return { url: url.toString(), status: res.status, contentType: ct, text: Buffer.concat(chunks).toString('utf8') };
    }
  } finally {
    clearTimeout(timer);
  }
}
