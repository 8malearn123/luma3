/**
 * Acquisition source («كيف عرفتِ عنا؟»). Shared by the server (inference and
 * storage) and the UI (labels, filters, the fallback question).
 */
export const ACQUISITION_SOURCES = [
  'referral', 'marketplace', 'campaign', 'instagram', 'tiktok', 'snapchat', 'google', 'x', 'whatsapp',
  'website', 'friend', 'walk_by', 'direct', 'other',
] as const;
export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number];

/** Answers offered when the source cannot be inferred (like the old app's question). */
export const HEARD_FROM = ['instagram', 'tiktok', 'snapchat', 'google', 'x', 'whatsapp', 'friend', 'walk_by', 'marketplace', 'other'] as const;
export type HeardFrom = (typeof HEARD_FROM)[number];

export type Attribution = { referrerHost?: string | null; utm?: { source?: string; medium?: string; campaign?: string } | null };

const SOCIAL: Array<[AcquisitionSource, RegExp]> = [
  ['instagram', /(^|\.)(instagram\.com|ig\.me|instagr\.am)$|^instagram$|^ig$/],
  ['tiktok', /(^|\.)tiktok\.com$|^tiktok$/],
  ['snapchat', /(^|\.)(snapchat\.com|snap\.com)$|^snapchat$|^snap$/],
  ['google', /(^|\.)google\.[a-z.]+$|^google$|(^|\.)g\.page$|^maps\.app\.goo\.gl$/],
  ['x', /(^|\.)(twitter\.com|x\.com|t\.co)$|^twitter$|^x$/],
  ['whatsapp', /(^|\.)(whatsapp\.com|wa\.me)$|^whatsapp$/],
];

function social(v: string | null | undefined): AcquisitionSource | null {
  if (!v) return null;
  const s = v.toLowerCase().trim();
  for (const [k, re] of SOCIAL) if (re.test(s)) return k;
  return null;
}

/**
 * Classifies one first-touch attribution. Order matters: explicit LUMA links
 * (referral, marketplace) first, then campaigns, then social/search platforms
 * by UTM source or referrer host, then any other website. Nothing at all → 'direct'.
 *
 * Link conventions: referral links carry `utm_medium=referral`; Souq LUMA
 * (marketplace) links carry `utm_medium=marketplace` or `utm_source=luma_marketplace`;
 * campaign links carry `utm_campaign`.
 */
export function classifyAttribution(a: Attribution): AcquisitionSource {
  const src = a.utm?.source?.toLowerCase().trim() ?? '';
  const med = a.utm?.medium?.toLowerCase().trim() ?? '';
  if (med === 'referral' || src === 'referral' || src === 'luma_referral') return 'referral';
  if (med === 'marketplace' || src === 'luma_marketplace' || src === 'marketplace') return 'marketplace';
  if (a.utm?.campaign) return 'campaign';
  const bySource = social(src);
  if (bySource) return bySource;
  const byHost = social(a.referrerHost);
  if (byHost) return byHost;
  if (a.referrerHost) return 'website';
  if (src) return 'other';
  return 'direct';
}
