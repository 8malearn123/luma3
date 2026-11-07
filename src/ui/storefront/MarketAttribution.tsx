'use client';

import { useEffect } from 'react';
import { storefrontSessionId } from '../analytics/track';

/**
 * سوق لوما attribution: when the storefront was opened from /discover
 * (?via=luma_market), records a marketplace visit for this tab's pseudonymous
 * analytics session. Bookings placed in the same session are then tagged as
 * marketplace bookings server-side. The marker is removed from the address bar.
 */
export function MarketAttribution({ slug }: { slug: string }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('via') !== 'luma_market') return;
    const sid = storefrontSessionId();
    void fetch(`/api/v1/s/${encodeURIComponent(slug)}/market-visit`, {
      method: 'POST', keepalive: true, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-luma-csrf': '1', 'x-luma-session': sid }, body: '{}',
    }).catch(() => undefined);
    url.searchParams.delete('via');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [slug]);
  return null;
}
