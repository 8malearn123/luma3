'use client';

import { ArrowLeft, ArrowRight } from 'lucide-react';

type Nav = { canGoBack?: boolean };

/**
 * Smart back arrow for storefront and booking pages: goes back in the tab's
 * history when the previous entry is on this site (so the customer returns to
 * exactly where she was), otherwise — opened from Instagram, a shared link or a
 * new tab — it goes to the storefront home instead of leaving the site.
 */
export function canGoBackSameOrigin(w: { navigation?: Nav; history: { length: number }; location: { origin: string } }, referrer: string): boolean {
  // Navigation API: entries() holds only same-origin entries, so canGoBack means "a page of this site is behind me".
  if (w.navigation && typeof w.navigation.canGoBack === 'boolean') return w.navigation.canGoBack;
  if (w.history.length <= 1 || !referrer) return false;
  try { return new URL(referrer).origin === w.location.origin; } catch { return false; }
}

export function BackArrow({ fallbackHref, label, dir }: { fallbackHref: string; label: string; dir: 'rtl' | 'ltr' }) {
  const Icon = dir === 'rtl' ? ArrowRight : ArrowLeft;
  return (
    <a href={fallbackHref} aria-label={label} title={label}
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-sf-border text-sf-text hover:bg-sf-surface"
      onClick={(e) => {
        if (canGoBackSameOrigin(window as unknown as Parameters<typeof canGoBackSameOrigin>[0], document.referrer)) { e.preventDefault(); window.history.back(); }
      }}>
      <Icon className="size-4" aria-hidden />
    </a>
  );
}
