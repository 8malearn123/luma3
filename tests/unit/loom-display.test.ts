import { describe, expect, it } from 'vitest';
import { grainLabel, metricDisplay, metricLabel, metricUnit, moneyText, splitMetricKey } from '@/loom';
import { itemName } from '@/loom/detectors/v1';
import { humanDiff } from '@/server/domains/marketing/plans';
import type { PlanContent } from '@/shared/schemas/marketing';

/** LUMA-AUDIT-023/024/039: owner-facing labels, units and names. */
describe('Loom display helpers', () => {
  const names = new Map([['i1', { ar: 'شامبو مرطب', en: 'Moisturising shampoo' }], ['o1', { ar: 'قص وتصفيف', en: 'Cut & style' }]]);

  it('splits grain suffixes and names the subject instead of printing ids', () => {
    expect(splitMetricKey('inventory.weekly_usage@item:i1')).toEqual({ base: 'inventory.weekly_usage', grain: 'item:i1' });
    expect(metricLabel('inventory.weekly_usage@item:i1', names, 'en')).toBe('Weekly usage — Moisturising shampoo');
    expect(metricLabel('inventory.weekly_usage@item:i1', names, 'ar')).toContain('شامبو مرطب');
    expect(metricLabel('sales.completed_count@offering:unknown-id', names, 'en')).not.toContain('unknown-id');
    expect(grainLabel('slot:1.evening', names, 'en')).toBe('Monday evening');
    expect(grainLabel('business', names, 'en')).toBeNull();
  });

  it('knows units from the metrics registry (money is in minor units)', () => {
    expect(metricUnit('sales.completed_net')).toBe('minor');
    expect(metricUnit('capacity.occupancy@slot:1.evening')).toBe('ratio');
    expect(metricUnit('capacity.free_minutes_next14')).toBe('minutes');
    expect(metricDisplay('sales.completed_net', names, 'ar').label).toBe('المبيعات المكتملة (صافي)');
  });

  it('formats rule-text money in the business currency', () => {
    const m = moneyText(9739, 'SAR');
    expect(m.en).toMatch(/97\.39/);
    expect(m.en).not.toContain('9739');
    expect(m.ar).toMatch(/97[.,٫]39/);
  });

  it('uses the linked product’s bilingual name for a sellable inventory item', () => {
    const offering = { name: { ar: 'زيت أرغان', en: 'Argan oil' } } as never;
    expect(itemName({ name: 'زيت أرغان' }, offering)).toEqual({ ar: 'زيت أرغان', en: 'Argan oil' });
    expect(itemName({ name: 'مادة' }, undefined)).toEqual({ ar: 'مادة', en: 'مادة' });
  });
});

describe('plan version comparison', () => {
  const base: PlanContent = {
    goal: 'هدف', baseline: [{ metric_key: 'sales.completed_net', label: 'صافي', value: 1676505 }],
    initiatives: [{ id: 'la_1', title: 'ملء الفترات الهادئة', description: 'وصف', evidence_refs: ['ev_1'] }],
    activities: [{ id: 'la_1', title: 'ملء الفترات الهادئة', initiative_id: 'la_1', date_from: '2026-11-01', date_to: '2026-11-07', channel: 'in_app', content_idea: null, owner: null, capacity_note: null, monthly_goal_ref: null, status: 'planned' }],
    dates: { start: '2026-11-01', end: '2026-11-30' }, owner: '', budget: { amount_minor: 10000, status: 'within_budget', assumptions: '' }, metrics: [], monthly_goals: [], experimental: false, limitations: '',
  } as PlanContent;

  it('reports item titles and plain values, never JSON objects or internal refs', () => {
    const next = structuredClone(base);
    next.activities[0]!.date_to = '2026-11-10';
    next.budget.amount_minor = 20000;
    next.initiatives[0]!.evidence_refs = ['ev_2'];
    next.initiatives.push({ id: 'loom_x', title: 'مبادرة جديدة', description: '', evidence_refs: [] });
    const d = humanDiff(base, next);
    expect(d).toContainEqual(expect.objectContaining({ section: 'activity', item: 'ملء الفترات الهادئة', field: 'date_to', before: '2026-11-07', after: '2026-11-10', value_kind: 'date' }));
    expect(d).toContainEqual(expect.objectContaining({ section: 'budget', field: 'amount_minor', before: 10000, after: 20000, value_kind: 'money' }));
    expect(d).toContainEqual(expect.objectContaining({ section: 'initiative', kind: 'added', item: 'مبادرة جديدة', after: 'مبادرة جديدة' }));
    expect(d.some((c) => c.field === 'evidence_refs')).toBe(false);
    for (const c of d) {
      expect(typeof c.before === 'object' && c.before !== null).toBe(false);
      expect(typeof c.after === 'object' && c.after !== null).toBe(false);
    }
  });
});
