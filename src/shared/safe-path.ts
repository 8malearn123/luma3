/**
 * Returns `p` only if it is a same-origin path under `prefix`, otherwise `fallback`.
 * Rejects protocol-relative ("//host"), backslash variants ("/\host" — browsers
 * treat "\" as "/"), control characters, and anything that resolves off-origin.
 */
export function safeInternalPath(p: string | null | undefined, fallback: string, prefix = '/'): string {
  if (!p || p.length > 2000 || !p.startsWith('/') || p.startsWith('//') || p.includes('\\') || /[\u0000-\u001f\u007f]/.test(p)) return fallback;
  try {
    if (new URL(p, 'http://internal.invalid').origin !== 'http://internal.invalid') return fallback;
  } catch {
    return fallback;
  }
  if (prefix === '/') return p;
  return p === prefix || p.startsWith(`${prefix}/`) || p.startsWith(`${prefix}?`) ? p : fallback;
}
