/** Colour-scheme preference for LUMA's internal surfaces (DESIGN_GUIDE §11). */
export type ThemePref = 'system' | 'light' | 'dark';
export const THEME_COOKIE = 'luma_theme';

export function parseThemePref(v: string | undefined | null): ThemePref {
  return v === 'light' || v === 'dark' ? v : 'system';
}

/** Persists the choice (cookie, so the server renders it without a flash) and applies it now. */
export function applyThemePref(pref: ThemePref) {
  document.cookie = pref === 'system'
    ? `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`
    : `${THEME_COOKIE}=${pref}; path=/; max-age=31536000; samesite=lax`;
  if (pref === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
}

export function currentThemePref(): ThemePref {
  if (typeof document === 'undefined') return 'system';
  return parseThemePref(document.documentElement.dataset.theme);
}
