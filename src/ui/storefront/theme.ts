import type { CSSProperties } from 'react';
import { FONTS, RADIUS_PX, type Brand } from '@/shared/builder/theme';

/**
 * Maps a business's theme tokens (brand_settings) onto the `--sf-*` CSS
 * variables consumed by the `sf-*` Tailwind tokens in globals.css. LUMA's own
 * palette is never applied to storefronts.
 */
export function themeStyle(brand: Brand): CSSProperties {
  const c = brand.colors;
  const density = { compact: 0.75, comfortable: 1, spacious: 1.3 }[brand.density] * brand.spacing_scale;
  return {
    '--sf-primary': c.primary, '--sf-on-primary': c.on_primary, '--sf-secondary': c.secondary, '--sf-accent': c.accent,
    '--sf-background': c.background, '--sf-surface': c.surface, '--sf-text': c.text, '--sf-muted': c.muted, '--sf-border': c.border,
    '--sf-font-heading': FONTS[brand.fonts.heading]?.css ?? FONTS.ibm_plex_arabic.css,
    '--sf-font-body': FONTS[brand.fonts.body]?.css ?? FONTS.ibm_plex_arabic.css,
    '--sf-radius': RADIUS_PX[brand.radius],
    '--sf-space': String(Math.round(density * 100) / 100),
  } as CSSProperties;
}

/** Google Fonts stylesheet for the two selected fonts (CSP allows fonts.googleapis.com). */
export function fontHref(brand: Brand) {
  const keys = [...new Set([brand.fonts.heading, brand.fonts.body])];
  const fam = keys.map((k) => FONTS[k]).filter(Boolean).map((f) => `family=${encodeURIComponent(f.family).replace(/%20/g, '+')}:wght@${f.weights}`);
  return `https://fonts.googleapis.com/css2?${fam.join('&')}&display=swap`;
}

/** Button appearance follows the owner's button_style; behaviour/size stay LUMA's. */
export function btnClass(brand: Brand, variant: 'primary' | 'secondary' | 'outline' = 'primary', size: 'md' | 'lg' | 'sm' = 'md') {
  const sz = size === 'lg' ? 'min-h-12 px-6 text-base' : size === 'sm' ? 'min-h-9 px-3 text-sm' : 'min-h-11 px-5 text-sm';
  const baseCls = `inline-flex items-center justify-center gap-2 rounded-sf font-semibold transition-[filter,background-color] hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 ${sz}`;
  const style = variant === 'outline' ? 'outline' : brand.button_style;
  if (variant === 'secondary') return `${baseCls} bg-sf-secondary/15 text-sf-text border border-sf-secondary/30`;
  if (style === 'outline') return `${baseCls} border-2 border-sf-primary text-sf-primary bg-transparent`;
  if (style === 'soft') return `${baseCls} bg-sf-primary/12 text-sf-primary`;
  return `${baseCls} bg-sf-primary text-sf-on-primary`;
}

export function cardClass(brand: Brand) {
  if (brand.card_style === 'flat') return 'rounded-sf bg-sf-surface';
  if (brand.card_style === 'elevated') return 'rounded-sf bg-sf-surface shadow-[0_6px_24px_-12px_rgba(0,0,0,0.25)]';
  return 'rounded-sf bg-sf-surface border border-sf-border';
}

/** Vertical rhythm scaled by density (bounded, so layouts never break). */
export const sectionClass = 'px-4 @2xl:px-6 py-[calc(var(--sf-space)*2.25rem)] @2xl:py-[calc(var(--sf-space)*3rem)]';
export const containerClass = 'mx-auto w-full max-w-6xl';
export const headingClass = 'font-sf-heading text-sf-text';

export const ASPECT: Record<string, string> = { '16:9': '16 / 9', '3:1': '3 / 1', '4:3': '4 / 3', '1:1': '1 / 1', '3:4': '3 / 4' };
export const FOCAL: Record<string, string> = { center: 'center', top: 'top', bottom: 'bottom', start: 'left', end: 'right' };
