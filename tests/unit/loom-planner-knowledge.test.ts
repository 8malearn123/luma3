import { describe, expect, it } from 'vitest';
import { beautyPack, DETECTORS, isStale, knowledgeLibrary, rankUnits } from '@/loom';

/** §9 knowledge library: curated, sector-scoped, covers every beauty detector and intervention. */
describe('knowledge library', () => {
  const lib = knowledgeLibrary();
  const beauty = lib.filter((u) => u.applies_to.sectors.includes('beauty'));

  it('has at least 15 beauty units, each with guidance, when-not-to-use, measurement, examples, source and review date', () => {
    expect(beauty.length).toBeGreaterThanOrEqual(15);
    for (const u of beauty) {
      expect(u.guidance.ar && u.guidance.en).toBeTruthy();
      expect(u.when_not_to_use.ar).toBeTruthy();
      expect(u.measurement.primary).toBeTruthy();
      expect(u.examples.good.length && u.examples.bad.length).toBeTruthy();
      expect(u.source.reviewed_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('covers every beauty detector (and capacity_prerequisite) and every intervention in the pack', () => {
    const detectors = [...beautyPack.detectors.map((d) => d.id), 'capacity_prerequisite'];
    for (const d of detectors) expect(beauty.some((u) => u.applies_to.detectors.includes(d)), d).toBe(true);
    for (const id of Object.keys(beautyPack.catalog)) expect(beauty.some((u) => u.applies_to.interventions.includes(id)), id).toBe(true);
    expect(DETECTORS.length).toBeGreaterThan(0);
  });

  it('retrieval never crosses sectors, however similar the words', () => {
    const q = { sector: 'beauty', detector: 'slow_mover_bundle', intervention: 'restock', text: 'restock fast-moving items before a campaign', limit: 10 };
    const r = rankUnits(lib, q, '2026-11-09');
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.unit.applies_to.sectors.includes('beauty'))).toBe(true);
    expect(r.map((x) => x.unit.id)).not.toContain('pb.retail.restock_fast_movers');
    const retail = rankUnits(lib, { ...q, sector: 'retail' }, '2026-11-09');
    expect(retail.map((x) => x.unit.id)).toEqual(['pb.retail.restock_fast_movers']);
    expect(rankUnits(lib, { sector: 'restaurant', detector: 'quiet_capacity' }, '2026-11-09')).toEqual([]);
  });

  it('ranks the intervention-specific unit first and flags units older than 12 months', () => {
    const r = rankUnits(lib, { sector: 'beauty', detector: 'lapsed_cohort', intervention: 'reminder_due', channels: ['whatsapp'] }, '2026-11-09');
    expect(r[0]!.unit.id).toBe('pb.reactivation.due_reminder');
    expect(isStale(r[0]!.unit, '2026-11-09')).toBe(false);
    expect(isStale(r[0]!.unit, '2027-11-02')).toBe(true);
  });
});
