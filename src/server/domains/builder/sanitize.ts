import sanitizeHtml from 'sanitize-html';
import type { PageBlock } from '@/shared/builder/blocks';

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ' };

/**
 * Server-side text sanitisation for block content. Blocks never carry HTML:
 * every string is stripped of markup (including script/style contents) and
 * control characters. React escapes on render as a second layer, so decoding
 * the basic entities back keeps "A & B" readable without enabling markup.
 */
export function sanitizeText(s: string): string {
  if (!/[<>&\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) return s;
  const stripped = sanitizeHtml(s, { allowedTags: [], allowedAttributes: {}, disallowedTagsMode: 'discard', nonTextTags: ['script', 'style', 'textarea', 'noscript', 'iframe', 'object'] });
  return stripped.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

const URL_KEYS = new Set(['url', 'href']);

function deep(v: unknown, key = ''): unknown {
  if (typeof v === 'string') return URL_KEYS.has(key) ? v : sanitizeText(v);
  if (Array.isArray(v)) return v.map((x) => deep(x));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = deep(x, k);
    return out;
  }
  return v;
}

/** Sanitises every text value in the block props (URLs are validated by the registry instead). */
export function sanitizeBlocks(blocks: PageBlock[]): PageBlock[] {
  return blocks.map((b) => ({ ...b, props: deep(b.props) as Record<string, unknown>, ...(b.children ? { children: sanitizeBlocks(b.children) } : {}) }));
}
