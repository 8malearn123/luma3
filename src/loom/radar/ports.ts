import { L } from '../util/text';
import { parseJsonItems } from './parse';
import { RadarFetchError, type ProviderStatus, type RadarFetcher, type RawSignal, type SignalApiProvider } from './types';

/**
 * Host-injected ports. The radar fetches nothing until the host registers an
 * SSRF-safe fetcher (LUMA: src/server/loom-host/radar.ts). Without one, every
 * fetch fails honestly with `fetcher_unavailable`.
 */
let fetcher: RadarFetcher | null = null;
export function setRadarFetcher(f: RadarFetcher | null) { fetcher = f; }
export function radarFetcher(): RadarFetcher {
  return fetcher ?? {
    fetch: async () => { throw new RadarFetchError('fetcher_unavailable'); },
    assertPublic: async () => { throw new RadarFetchError('fetcher_unavailable'); },
  };
}

/**
 * API providers. Each adapter is configured by the platform operator with an
 * https endpoint (environment) that returns the documented JSON item format
 * ({ items: [{ title, url, published_at, region?, summary?, metrics? }] }).
 * Without configuration the adapter reports «غير متصل» (not_configured) and
 * the analysis continues on internal data. Metrics are kept only when the
 * provider supplies them; nothing is estimated.
 */
function endpointProvider(id: string, envVar: string, label: { ar: string; en: string }): SignalApiProvider {
  const endpoint = () => { const v = process.env[envVar]; return v && /^https:\/\//.test(v) ? v : null; };
  return {
    id, label: L(label.ar, label.en),
    status: (): ProviderStatus => (endpoint() ? { state: 'connected' } : { state: 'disconnected', reason: 'not_configured' }),
    async fetch(query, f): Promise<RawSignal[]> {
      const base = endpoint();
      if (!base) throw new RadarFetchError('not_configured');
      const u = new URL(base);
      const q = typeof query.q === 'string' ? query.q.slice(0, 120) : '';
      if (q) u.searchParams.set('q', q);
      if (typeof query.region === 'string') u.searchParams.set('region', query.region.slice(0, 40));
      const res = await f.fetch(u.toString(), 'json');
      return parseJsonItems(res.text, u.toString());
    },
  };
}

const providers = new Map<string, SignalApiProvider>([
  ['search_interest', endpointProvider('search_interest', 'LOOM_RADAR_SEARCH_INTEREST_URL', { ar: 'اهتمام البحث', en: 'Search interest' })],
  ['social_trends', endpointProvider('social_trends', 'LOOM_RADAR_SOCIAL_TRENDS_URL', { ar: 'رصد الشبكات الاجتماعية', en: 'Social trends' })],
]);
export function registerApiProvider(p: SignalApiProvider) { providers.set(p.id, p); }
export function apiProvider(id: string): SignalApiProvider | null { return providers.get(id) ?? null; }
export function apiProviders(): SignalApiProvider[] { return [...providers.values()]; }
export function providerStatus(id: string): ProviderStatus { return providers.get(id)?.status() ?? { state: 'disconnected', reason: 'unknown_provider' }; }
