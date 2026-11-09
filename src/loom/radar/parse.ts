import type { RawSignal } from './types';

/**
 * Parsers for third-party content (RSS/Atom, HTML meta, iCalendar, JSON).
 * Everything returned here is untrusted text: tags and scripts are stripped,
 * lengths are bounded, and nothing is ever interpreted.
 */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
export const cleanText = (s: string | undefined | null, max: number) => {
  if (!s) return null;
  const t = decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};
const tag = (block: string, name: string) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)?.[1];
const attr = (block: string, el: string, a: string) => new RegExp(`<${el}\\b[^>]*\\b${a}=["']([^"']+)["']`, 'i').exec(block)?.[1];
const date = (raw: string | null | undefined) => { if (!raw) return null; const d = new Date(raw); return Number.isFinite(d.getTime()) ? d : null; };

/** Resolves a link against the source URL; only https links are kept. */
export function httpsLink(link: string | null | undefined, base: string): string | null {
  if (!link) return null;
  try { const u = new URL(link, base); return u.protocol === 'https:' ? u.toString().slice(0, 500) : null; } catch { return null; }
}

export function parseFeed(xml: string, base: string): RawSignal[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  return blocks.slice(0, 50).flatMap((b) => {
    const title = cleanText(tag(b, 'title'), 300);
    if (!title) return [];
    const link = cleanText(tag(b, 'link'), 500) ?? attr(b, 'link', 'href') ?? null;
    return [{
      url: httpsLink(link, base), untrusted_title: title, untrusted_summary: cleanText(tag(b, 'description') ?? tag(b, 'summary') ?? tag(b, 'content'), 600),
      published_at: date(cleanText(tag(b, 'pubDate') ?? tag(b, 'published') ?? tag(b, 'updated') ?? tag(b, 'dc:date'), 60)), region: null, reach_metrics: null,
    }];
  });
}

export function parseHtml(html: string): RawSignal[] {
  const title = cleanText(attr(html, 'meta property="og:title"', 'content') ?? tag(html, 'title'), 300);
  if (!title) return [];
  const desc = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1];
  const pub = /<meta[^>]+(?:property|name)=["'](?:article:published_time|date|pubdate)["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1];
  return [{ url: null, untrusted_title: title, untrusted_summary: cleanText(desc, 600), published_at: date(pub), region: null, reach_metrics: null }];
}

/** Numbers a JSON API supplied for an item: kept only if finite and non-negative. Nothing is derived. */
export function sourceMetrics(m: unknown): Record<string, number> | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m as Record<string, unknown>).slice(0, 10)) {
    if (/^[a-z][a-z0-9_]{0,39}$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Documented JSON format for API adapters: { items: [{ title, url, published_at, region?, summary?, metrics? }] }. */
export function parseJsonItems(text: string, base: string): RawSignal[] {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return []; }
  const items = (j && typeof j === 'object' && Array.isArray((j as { items?: unknown }).items)) ? (j as { items: unknown[] }).items : [];
  return items.slice(0, 50).flatMap((x) => {
    if (!x || typeof x !== 'object') return [];
    const o = x as Record<string, unknown>;
    const title = cleanText(typeof o.title === 'string' ? o.title : null, 300);
    if (!title) return [];
    return [{
      url: httpsLink(typeof o.url === 'string' ? o.url : null, base), untrusted_title: title,
      untrusted_summary: cleanText(typeof o.summary === 'string' ? o.summary : null, 600),
      published_at: date(typeof o.published_at === 'string' ? o.published_at : null),
      region: typeof o.region === 'string' && /^[A-Za-z:_ -]{2,40}$/.test(o.region) ? o.region : null,
      reach_metrics: sourceMetrics(o.metrics),
    }];
  });
}

// ── Calendars ────────────────────────────────────────────────────────────────
export type ParsedCalendarEvent = { uid: string | null; untrusted_title: string; untrusted_description: string | null; starts_on: string; ends_on: string; region: string | null; kind: string | null };

const isoDay = (v: string | undefined | null): string | null => {
  if (!v) return null;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return Number.isFinite(d.getTime()) && d.getUTCDate() === +m[3]! ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const minusDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const unescapeIcs = (s: string) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');

/** RFC 5545 VEVENTs (all-day or timed; DTEND is exclusive for all-day events). */
export function parseIcs(text: string): ParsedCalendarEvent[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];
  return blocks.slice(0, 500).flatMap((b) => {
    const prop = (name: string) => new RegExp(`^${name}(?:;([^:\\r\\n]*))?:(.*)$`, 'mi').exec(b);
    const start = prop('DTSTART');
    const end = prop('DTEND');
    const s = isoDay(start?.[2]);
    if (!s) return [];
    let e = isoDay(end?.[2]) ?? s;
    const allDay = /VALUE=DATE(?!-)/i.test(start?.[1] ?? '') || /^\d{8}$/.test((start?.[2] ?? '').trim());
    if (end && allDay && e > s) e = minusDay(e);
    if (e < s) e = s;
    const title = cleanText(unescapeIcs(prop('SUMMARY')?.[2] ?? ''), 300);
    if (!title) return [];
    return [{
      uid: cleanText(prop('UID')?.[2], 200), untrusted_title: title, untrusted_description: cleanText(unescapeIcs(prop('DESCRIPTION')?.[2] ?? ''), 600),
      starts_on: s, ends_on: e, region: null, kind: cleanText(prop('CATEGORIES')?.[2], 60),
    }];
  });
}

/** JSON calendar: { events: [{ uid?, title, starts_on, ends_on?, region?, kind? }] }. */
export function parseJsonCalendar(text: string): ParsedCalendarEvent[] {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return []; }
  const list = j && typeof j === 'object' && Array.isArray((j as { events?: unknown }).events) ? (j as { events: unknown[] }).events : [];
  return list.slice(0, 500).flatMap((x) => {
    if (!x || typeof x !== 'object') return [];
    const o = x as Record<string, unknown>;
    const title = cleanText(typeof o.title === 'string' ? o.title : null, 300);
    const s = isoDay(typeof o.starts_on === 'string' ? o.starts_on : null);
    if (!title || !s) return [];
    const e0 = isoDay(typeof o.ends_on === 'string' ? o.ends_on : null) ?? s;
    return [{
      uid: typeof o.uid === 'string' ? o.uid.slice(0, 200) : null, untrusted_title: title,
      untrusted_description: cleanText(typeof o.description === 'string' ? o.description : null, 600), starts_on: s, ends_on: e0 < s ? s : e0,
      region: typeof o.region === 'string' ? o.region.slice(0, 40) : null, kind: typeof o.kind === 'string' ? o.kind.slice(0, 40) : null,
    }];
  });
}

export function parseCalendar(text: string, contentType: string): ParsedCalendarEvent[] {
  if (/calendar/i.test(contentType) || /^\s*BEGIN:VCALENDAR/i.test(text)) return parseIcs(text);
  return parseJsonCalendar(text);
}
