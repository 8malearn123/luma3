/** Manual service badges (owner-chosen; never computed). Presets are translated; 'custom' carries its own text. */
export const SERVICE_BADGES = ['popular', 'new', 'offer', 'custom'] as const;
export type ServiceBadgeKind = (typeof SERVICE_BADGES)[number];
export type ServiceBadge = { kind: ServiceBadgeKind; text_ar: string | null; text_en: string | null };

export const BADGE_PRESET_LABELS: Record<Exclude<ServiceBadgeKind, 'custom'>, { ar: string; en: string }> = {
  popular: { ar: 'الأكثر طلباً', en: 'Most popular' },
  new: { ar: 'جديد', en: 'New' },
  offer: { ar: 'عرض خاص', en: 'Special offer' },
};

/** Badge from a service row's columns, or null when none / an incomplete custom badge. */
export function badgeOf(row: { badge_kind?: string | null; badge_text_ar?: string | null; badge_text_en?: string | null }): ServiceBadge | null {
  const kind = row.badge_kind as ServiceBadgeKind | null | undefined;
  if (!kind || !(SERVICE_BADGES as readonly string[]).includes(kind)) return null;
  if (kind === 'custom' && !row.badge_text_ar && !row.badge_text_en) return null;
  return { kind, text_ar: kind === 'custom' ? row.badge_text_ar ?? null : null, text_en: kind === 'custom' ? row.badge_text_en ?? null : null };
}

export function badgeLabel(b: ServiceBadge, locale: 'ar' | 'en'): string {
  if (b.kind === 'custom') return (locale === 'ar' ? b.text_ar || b.text_en : b.text_en || b.text_ar) ?? '';
  return BADGE_PRESET_LABELS[b.kind][locale];
}
