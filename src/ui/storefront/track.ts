import type { StorefrontMode } from '@/shared/builder/storefront';
import { storefrontSessionId } from '../analytics/track';

/**
 * Storefront analytics hook (client). Posts pseudonymous events to
 * /api/v1/s/{slug}/events. Fires on the PUBLISHED storefront only — never in
 * previews or the builder canvas (previews do not count as marketing visits).
 * The endpoint is owned by the analytics domain; failures (including 404
 * before it exists) are ignored silently.
 */

export type TrackEventType = 'page_view' | 'service_view' | 'product_view' | 'booking_start' | 'checkout_start' | 'availability_empty' | 'waitlist_join';


export function trackingEnabled(mode: StorefrontMode): boolean {
  return mode === 'published';
}

function uuid() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** One pseudonymous session id shared with the analytics client (see ui/analytics/track.ts). */
export function sessionId(): string {
  return storefrontSessionId();
}

function utmFrom(search: string) {
  const q = new URLSearchParams(search);
  const utm: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign', 'content', 'term']) {
    const v = q.get(`utm_${k}`);
    if (v) utm[k] = v.slice(0, 100);
  }
  return Object.keys(utm).length ? utm : undefined;
}

function referrerHost(): string | undefined {
  try {
    if (!document.referrer) return undefined;
    const h = new URL(document.referrer).host;
    return h && h !== window.location.host ? h : undefined;
  } catch {
    return undefined;
  }
}

export function track(slug: string, type: TrackEventType, entityId?: string | null) {
  if (typeof window === 'undefined') return;
  const body = JSON.stringify({
    event_id: uuid(),
    session_id: sessionId(),
    type,
    ...(entityId ? { entity_id: entityId } : {}),
    path: window.location.pathname.slice(0, 300),
    occurred_at: new Date().toISOString(),
    ...(referrerHost() ? { referrer: referrerHost() } : {}),
    ...(utmFrom(window.location.search) ? { utm: utmFrom(window.location.search) } : {}),
  });
  const url = `/api/v1/s/${encodeURIComponent(slug)}/events`;
  try {
    // sendBeacon cannot set the CSRF header, so fetch keepalive is used.
    void fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'x-luma-csrf': '1' }, body, credentials: 'same-origin' }).catch(() => {});
  } catch {
    /* analytics must never break the page */
  }
}
