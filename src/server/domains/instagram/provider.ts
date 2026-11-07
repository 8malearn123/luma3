import { env } from '../../env';

/**
 * Instagram integration behind a provider interface. Only the official API is
 * used (the Instagram API with Instagram Login, graph.instagram.com) — never
 * scraping. Without Meta app credentials the provider reports itself as not
 * configured and the storefront degrades to the profile-link card.
 */
export type InstagramPost = {
  id: string;
  permalink: string;
  media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  /** Image to show (the thumbnail for videos). Never sent to the browser; served through the media proxy. */
  image_url: string;
  caption: string | null;
  timestamp: string;
};

export type InstagramAccount = { igUserId: string; username: string; expiresAt: Date | null };

export interface InstagramProvider {
  readonly name: 'graph';
  isConfigured(): boolean;
  /** Validates an access token and returns the professional account it belongs to. */
  fetchAccount(accessToken: string): Promise<InstagramAccount>;
  fetchRecentMedia(input: { igUserId: string; accessToken: string; limit: number }): Promise<InstagramPost[]>;
}

export class InstagramProviderError extends Error {
  constructor(message: string, readonly code: 'not_configured' | 'invalid_token' | 'upstream' = 'upstream') { super(message); }
}

/** Hosts Instagram serves media from. Anything else is dropped. */
export const INSTAGRAM_MEDIA_HOSTS = [/\.cdninstagram\.com$/, /\.fbcdn\.net$/];
export function isInstagramMediaUrl(raw: string) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && INSTAGRAM_MEDIA_HOSTS.some((r) => r.test(u.hostname));
  } catch { return false; }
}
export function isInstagramPermalink(raw: string) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname === 'www.instagram.com' || u.hostname === 'instagram.com');
  } catch { return false; }
}

const GRAPH = 'https://graph.instagram.com';

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new InstagramProviderError(msg, res.status === 400 || res.status === 401 ? 'invalid_token' : 'upstream');
  }
  return body;
}

export const graphProvider: InstagramProvider = {
  name: 'graph',
  isConfigured: () => !!env().INSTAGRAM_APP_ID && !!env().INSTAGRAM_APP_SECRET,
  async fetchAccount(accessToken) {
    if (!this.isConfigured()) throw new InstagramProviderError('Instagram is not configured on this platform', 'not_configured');
    const me = await getJson(`${GRAPH}/me?fields=user_id,username&access_token=${encodeURIComponent(accessToken)}`);
    if (!me?.user_id || !me?.username) throw new InstagramProviderError('Unexpected account response', 'invalid_token');
    return { igUserId: String(me.user_id), username: String(me.username), expiresAt: null };
  },
  async fetchRecentMedia({ igUserId, accessToken, limit }) {
    if (!this.isConfigured()) throw new InstagramProviderError('Instagram is not configured on this platform', 'not_configured');
    const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
    const body = await getJson(`${GRAPH}/${encodeURIComponent(igUserId)}/media?fields=${fields}&limit=${Math.min(24, limit)}&access_token=${encodeURIComponent(accessToken)}`);
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows.map((m: Record<string, unknown>) => ({
      id: String(m.id), permalink: String(m.permalink ?? ''), media_type: (m.media_type as InstagramPost['media_type']) ?? 'IMAGE',
      image_url: String((m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url) ?? ''), caption: typeof m.caption === 'string' ? m.caption : null,
      timestamp: String(m.timestamp ?? ''),
    }));
  },
};

let current: InstagramProvider = graphProvider;
export function instagramProvider(): InstagramProvider {
  return current;
}
/** Tests only: substitute a fake provider (null restores the Graph provider). */
export function setInstagramProviderForTests(p: InstagramProvider | null) {
  current = p ?? graphProvider;
}
