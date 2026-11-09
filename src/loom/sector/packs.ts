import { MetricSet } from '../metrics/registry';
import { type QualityLevel, type QualityReport } from '../quality/gate';
import { beautyPack, registeredSectorPacks, registerSectorPack, sectorPack } from './beauty';
import { restaurantPack, retailPack } from './retail';
import type { SectorPack } from './types';

/**
 * Sector pack registry (§16). Importing this module registers every pack
 * (beauty, retail, restaurant skeleton) and the retail detectors. Which pack
 * a business uses is stored in loom.businesses.sector_pack (LUMA tenants
 * default to the connector's sector) and must be enabled by the platform
 * owner (loom_settings platform.enabled_sector_packs).
 */
registerSectorPack(retailPack);
registerSectorPack(restaurantPack);

export { beautyPack, retailPack, restaurantPack, sectorPack, registeredSectorPacks };

/** Applies the pack's metric overrides (a stricter min_sample withholds the value). */
export function applyMetricOverrides(metrics: MetricSet, pack: SectorPack): MetricSet {
  const o = pack.metrics?.overrides;
  if (!o) return metrics;
  return new MetricSet(metrics.values.map((v) => (o[v.key] && v.status === 'ok' && v.n < o[v.key]!.min_sample ? { ...v, status: 'insufficient_sample' as const, value: null } : v)));
}

/**
 * Applies the pack's quality model: `overall` is decided by sales plus the
 * pack's capacity notion (retail: inventory instead of staff schedules).
 */
export function applyPackQuality(q: QualityReport, pack: SectorPack): QualityReport {
  const core = pack.quality?.core;
  if (!core || (core.length === 2 && core.includes('sales') && core.includes('capacity'))) return q;
  const levels = core.map((d) => q.domains[d].level);
  const overall: QualityLevel = levels.every((l) => l === 'insufficient') ? 'insufficient'
    : levels.some((l) => l !== 'ok') || q.domains.economics.level !== 'ok' ? 'limited' : 'ok';
  return { ...q, overall };
}

/** Vocabulary of a pack in one language (UI labels). */
export function packVocabulary(id: string, locale: 'ar' | 'en') {
  const p = sectorPack(id);
  return Object.fromEntries(Object.entries(p.vocabulary).map(([k, v]) => [k, v[locale] || v.ar]));
}
