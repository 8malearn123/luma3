import { RadarFetchError, setRadarFetcher, type RadarFetcher, type RadarFetchKind } from '@/loom';
import { checkUrl, defaultResolver, isBlockedIp, safeFetch, SafeFetchError, type SafeFetchOptions } from '../domains/marketing/safe-fetch';

/**
 * LUMA's outbound port for the Loom radar: every fetch (RSS, links, API
 * providers, official calendars) goes through the existing SSRF-safe fetcher
 * (https only, public addresses, re-validated redirects, size/time limits,
 * content-type allowlist per kind). Registered on import; tests replace the
 * transport/resolver with `lumaRadarFetcher({ transport, resolver })`.
 */
const ACCEPT: Record<RadarFetchKind, RegExp> = {
  feed: /^(application\/(rss\+xml|atom\+xml|xml|json|feed\+json)|text\/(xml|html|plain))\b/i,
  html: /^(text\/html|application\/xhtml\+xml)\b/i,
  calendar: /^(text\/calendar|application\/(json|ics)|text\/plain)\b/i,
  json: /^application\/(json|feed\+json)\b/i,
};

export function lumaRadarFetcher(opts: SafeFetchOptions = {}): RadarFetcher {
  return {
    async fetch(url, kind) {
      try { return await safeFetch(url, { ...opts, accept: ACCEPT[kind], maxBytes: kind === 'calendar' ? 2_000_000 : 1_000_000 }); } catch (e) {
        if (e instanceof SafeFetchError) throw new RadarFetchError(e.code, e.message);
        throw new RadarFetchError('network_error', (e as Error).message);
      }
    },
    async assertPublic(raw) {
      try {
        const u = checkUrl(raw);
        const addrs = await (opts.resolver ?? defaultResolver)(u.hostname.replace(/^\[|\]$/g, '')).catch(() => [] as string[]);
        if (addrs.some((a) => isBlockedIp(a))) throw new SafeFetchError('blocked_address');
      } catch (e) {
        throw new RadarFetchError(e instanceof SafeFetchError ? e.code : 'invalid_url');
      }
    },
  };
}

setRadarFetcher(lumaRadarFetcher());
