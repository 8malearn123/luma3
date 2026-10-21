'use client';

/**
 * Storefront analytics client util (for storefront pages; called by the
 * storefront/booking UI). Privacy by design:
 *  - session id: random, pseudonymous, kept in sessionStorage; rotates after 30
 *    idle minutes and when the tab closes. A reload (or iframe refresh) keeps it,
 *    so it is never counted as a new customer. No fingerprinting, no cookies.
 *  - referrer: sent as given; the server keeps the host only.
 *  - conversions (booking_confirmed / order_paid) are recorded server-side only;
 *    pass `storefrontSessionId()` to booking/checkout requests (header
 *    `x-luma-session`) so the server can link them via recordServerEvent.
 */

export type ClientEventType = 'page_view' | 'service_view' | 'product_view' | 'booking_start' | 'checkout_start' | 'availability_empty' | 'waitlist_join';

const KEY = 'luma_sid';
const IDLE_MS = 30 * 60_000;

export function storefrontSessionId(): string {
  try {
    const raw = sessionStorage.getItem(KEY);
    const now = Date.now();
    if (raw) {
      const [id, at] = raw.split('.');
      if (id && at && now - Number(at) < IDLE_MS) { sessionStorage.setItem(KEY, `${id}.${now}`); return id; }
    }
    const id = crypto.randomUUID().replace(/-/g, '');
    sessionStorage.setItem(KEY, `${id}.${now}`);
    return id;
  } catch {
    return crypto.randomUUID().replace(/-/g, ''); // storage blocked: a per-page id
  }
}

function utmFromLocation(): Record<string, string> | undefined {
  const p = new URLSearchParams(window.location.search);
  const out: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign', 'content', 'term']) {
    const v = p.get(`utm_${k}`);
    if (v) out[k] = v.slice(0, 100).replace(/[^\p{L}\p{N} _.\-+]/gu, '');
  }
  return Object.keys(out).length ? out : undefined;
}

/** Fire-and-forget; analytics never blocks or breaks the storefront. */
export function trackEvent(slug: string, type: ClientEventType, opts: { entityId?: string } = {}) {
  if (typeof window === 'undefined') return;
  const body = {
    event_id: crypto.randomUUID(),
    session_id: storefrontSessionId(),
    type,
    ...(opts.entityId ? { entity_id: opts.entityId } : {}),
    path: window.location.pathname.slice(0, 300),
    occurred_at: new Date().toISOString(),
    ...(document.referrer ? { referrer: document.referrer.slice(0, 300) } : {}),
    ...(utmFromLocation() ? { utm: utmFromLocation() } : {}),
  };
  void fetch(`/api/v1/s/${encodeURIComponent(slug)}/events`, {
    method: 'POST', keepalive: true, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'x-luma-csrf': '1' },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}
