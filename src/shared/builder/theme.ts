import { z } from 'zod';

/**
 * Storefront theme tokens (owned by each business, stored once in
 * brand_settings). LUMA's own dashboard palette is NOT applied to storefronts.
 */
export const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #RRGGBB colour');

export const COLOR_TOKENS = ['primary', 'on_primary', 'secondary', 'accent', 'background', 'surface', 'text', 'muted', 'border'] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export const zColors = z.object({
  primary: hex, on_primary: hex, secondary: hex, accent: hex, background: hex, surface: hex, text: hex, muted: hex, border: hex,
});
export type ThemeColors = z.infer<typeof zColors>;

/** Supported fonts (all Arabic-capable; loaded from Google Fonts). */
export const FONTS = {
  ibm_plex_arabic: { family: 'IBM Plex Sans Arabic', css: "'IBM Plex Sans Arabic', system-ui, sans-serif", weights: '400;500;600;700', style: 'sans' },
  tajawal: { family: 'Tajawal', css: "'Tajawal', system-ui, sans-serif", weights: '400;500;700', style: 'sans' },
  cairo: { family: 'Cairo', css: "'Cairo', system-ui, sans-serif", weights: '400;600;700', style: 'sans' },
  almarai: { family: 'Almarai', css: "'Almarai', system-ui, sans-serif", weights: '400;700', style: 'sans' },
  readex_pro: { family: 'Readex Pro', css: "'Readex Pro', system-ui, sans-serif", weights: '400;500;600', style: 'sans' },
  noto_kufi: { family: 'Noto Kufi Arabic', css: "'Noto Kufi Arabic', system-ui, sans-serif", weights: '400;600;700', style: 'sans' },
  el_messiri: { family: 'El Messiri', css: "'El Messiri', serif", weights: '400;600;700', style: 'display' },
  reem_kufi: { family: 'Reem Kufi', css: "'Reem Kufi', sans-serif", weights: '400;600', style: 'display' },
  amiri: { family: 'Amiri', css: "'Amiri', serif", weights: '400;700', style: 'serif' },
  noto_naskh: { family: 'Noto Naskh Arabic', css: "'Noto Naskh Arabic', serif", weights: '400;600;700', style: 'serif' },
  markazi: { family: 'Markazi Text', css: "'Markazi Text', serif", weights: '400;600', style: 'serif' },
} as const;
export type FontKey = keyof typeof FONTS;
export const zFontKey = z.enum(Object.keys(FONTS) as [FontKey, ...FontKey[]]);

export const zBrand = z.object({
  colors: zColors,
  fonts: z.object({ heading: zFontKey, body: zFontKey }),
  radius: z.enum(['none', 'sm', 'md', 'lg', 'pill']),
  button_style: z.enum(['solid', 'outline', 'soft']),
  card_style: z.enum(['flat', 'bordered', 'elevated']),
  density: z.enum(['compact', 'comfortable', 'spacious']),
  spacing_scale: z.number().min(0.75).max(1.5),
  logo_asset_id: z.string().uuid().nullable(),
  wordmark_text: z.string().max(60).nullable(),
  tagline_ar: z.string().max(140).nullable(),
  tagline_en: z.string().max(140).nullable(),
});
export type Brand = z.infer<typeof zBrand>;

/** Neutral starting theme for a new business — deliberately not LUMA's purple. */
export const NEUTRAL_BRAND: Brand = {
  colors: {
    primary: '#2F2A26', on_primary: '#FFFFFF', secondary: '#8C7B6B', accent: '#B9975B',
    background: '#FBF9F6', surface: '#FFFFFF', text: '#1F1B18', muted: '#6E655D', border: '#E7E0D8',
  },
  fonts: { heading: 'el_messiri', body: 'ibm_plex_arabic' },
  radius: 'md', button_style: 'solid', card_style: 'bordered', density: 'comfortable', spacing_scale: 1,
  logo_asset_id: null, wordmark_text: null, tagline_ar: null, tagline_en: null,
};

// ── Colour utilities (WCAG contrast, palette generation) ────────────────────
export function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex([r, g, b]: [number, number, number]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
function lum(h: string) {
  const [r, g, b] = hexToRgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a: string, b: string) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

export function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s, l];
}
export function hslToHex(h: number, s: number, l: number) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return rgbToHex([l * 255, l * 255, l * 255]);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return rgbToHex([f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255]);
}

/** Readable text colour on a background. */
export function onColor(bg: string) {
  return contrastRatio(bg, '#FFFFFF') >= contrastRatio(bg, '#1A1A1A') ? '#FFFFFF' : '#1A1A1A';
}

export type ContrastWarning = { pair: [ColorToken, ColorToken]; ratio: number; min: number };

/** Accessibility warnings shown in the builder (never silently "fixed"). */
export function contrastWarnings(c: ThemeColors): ContrastWarning[] {
  const checks: Array<[ColorToken, ColorToken, number]> = [
    ['text', 'background', 4.5], ['text', 'surface', 4.5], ['on_primary', 'primary', 4.5], ['muted', 'background', 3],
  ];
  return checks
    .map(([a, b, min]) => ({ pair: [a, b] as [ColorToken, ColorToken], ratio: Math.round(contrastRatio(c[a], c[b]) * 100) / 100, min }))
    .filter((w) => w.ratio < w.min);
}

/**
 * Deterministic palette from one or more seed colours (from the owner's choice
 * or extracted from an uploaded logo). Produces suggestions only — the owner
 * must accept before they apply.
 */
export function paletteFromSeeds(seeds: string[], mood: 'soft' | 'bold' | 'classic' = 'classic', excluded: string[] = []): ThemeColors {
  const base = seeds[0] ?? '#8C7B6B';
  const [h, s] = rgbToHsl(hexToRgb(base));
  const sat = mood === 'bold' ? Math.min(0.75, s + 0.1) : mood === 'soft' ? Math.min(0.35, s) : Math.min(0.55, s);
  const primary = hslToHex(h, sat, mood === 'soft' ? 0.42 : 0.32);
  const secondarySeed = seeds[1] ? rgbToHsl(hexToRgb(seeds[1])) : [h + 25, sat * 0.6, 0.55];
  const secondary = hslToHex(secondarySeed[0]!, Math.min(0.5, secondarySeed[1]!), 0.55);
  const accent = hslToHex(h + (mood === 'bold' ? 160 : 35), Math.min(0.6, sat + 0.1), 0.58);
  const palette: ThemeColors = {
    primary,
    on_primary: onColor(primary),
    secondary,
    accent,
    background: hslToHex(h, Math.min(0.35, sat * 0.5), 0.975),
    surface: '#FFFFFF',
    text: hslToHex(h, Math.min(0.25, sat * 0.4), 0.12),
    muted: hslToHex(h, Math.min(0.15, sat * 0.3), 0.42),
    border: hslToHex(h, Math.min(0.2, sat * 0.3), 0.89),
  };
  // Respect excluded colours: nudge any token that is perceptually too close.
  for (const ex of excluded.filter((e) => /^#[0-9a-fA-F]{6}$/.test(e))) {
    for (const k of ['primary', 'secondary', 'accent'] as const) {
      if (colorDistance(palette[k], ex) < 40) {
        const [hh, ss, ll] = rgbToHsl(hexToRgb(palette[k]));
        palette[k] = hslToHex(hh + 40, ss, ll);
      }
    }
  }
  palette.on_primary = onColor(palette.primary);
  return palette;
}

export function colorDistance(a: string, b: string) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

export const RADIUS_PX: Record<Brand['radius'], string> = { none: '0px', sm: '4px', md: '10px', lg: '18px', pill: '999px' };
