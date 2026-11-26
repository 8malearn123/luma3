import { describe, expect, it } from 'vitest';
import { LumaConnector } from '@/loom';
import { buildCapacityWindows } from '@/loom/connectors/luma/capacity';
import { freshnessOf, isConsistent, LUMA_STATUS_MAP, netOf, normalizeStatus, splitNet } from '@/loom/connectors/luma/normalize';
import { convertQty } from '@/loom/util/units';
import { localToMs } from '@/loom/util/time';

describe('LUMA connector normalisation (§5.2)', () => {
  it('maps every LUMA booking status to exactly one canonical status; only completed is a sale', () => {
    const expected: Record<string, string> = {
      draft: 'requested', held: 'requested', pending_approval: 'requested', pending_payment: 'requested', confirmed: 'confirmed', checked_in: 'confirmed', in_service: 'confirmed',
      completed: 'fulfilled', expired: 'expired', no_show: 'no_show',
    };
    for (const [src, can] of Object.entries(expected)) expect(normalizeStatus('booking', src, null)).toBe(can);
    expect(normalizeStatus('booking', 'cancelled', 'customer')).toBe('cancelled_customer');
    expect(normalizeStatus('booking', 'cancelled', 'business')).toBe('cancelled_business');
    expect(normalizeStatus('booking', 'cancelled', 'system')).toBe('cancelled_business');
    expect(Object.keys(LUMA_STATUS_MAP.booking).sort()).toEqual([...Object.keys(expected), 'cancelled'].sort());
  });

  it('maps order statuses (a paid order is a sale)', () => {
    expect(['draft', 'pending_payment'].map((s) => normalizeStatus('order', s, null))).toEqual(['requested', 'requested']);
    expect(['paid', 'preparing', 'ready', 'collected'].map((s) => normalizeStatus('order', s, null))).toEqual(Array(4).fill('fulfilled'));
    expect(normalizeStatus('order', 'cancelled', 'customer')).toBe('cancelled_customer');
  });

  it('net = total − tax − refunds, split across lines exactly', () => {
    expect(netOf({ total_minor: 11500, tax_minor: 1500, refunded_minor: 2000 })).toBe(8000);
    expect(netOf({ total_minor: 100, tax_minor: 0, refunded_minor: 500 })).toBe(0);
    const parts = splitNet(1001, [500, 300, 200]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1001);
    expect(parts).toEqual([500, 300, 201]);
  });

  it('flags inconsistent transactions', () => {
    expect(isConsistent({ subtotal_minor: 1000, total_minor: 1000, refunded_minor: 0, status: 'fulfilled' }, [600, 400])).toBe(true);
    expect(isConsistent({ subtotal_minor: 1000, total_minor: 1000, refunded_minor: 0, status: 'fulfilled' }, [600])).toBe(false);
    expect(isConsistent({ subtotal_minor: 1000, total_minor: 1000, refunded_minor: 1200, status: 'fulfilled' }, [1000])).toBe(false);
    expect(isConsistent({ subtotal_minor: 1000, total_minor: 1000, refunded_minor: 0, status: 'fulfilled' }, [])).toBe(false);
  });

  it('builds capacity windows: hours − breaks − blocks − approved leave, bookings marked booked', () => {
    const tz = 'Asia/Riyadh', d = '2026-11-10', wd = 2; // Tuesday
    const at = (h: string) => localToMs(d, h, tz);
    const w = buildCapacityWindows({
      hours: [{ resource_id: 's', weekday: wd, start_time: '10:00:00', end_time: '18:00:00', effective_from: null, effective_to: null, timezone: tz }],
      breaks: [{ resource_id: 's', weekday: wd, on_date: null, start_time: '13:00', end_time: '14:00' }],
      overrides: [], leave: [{ resource_id: 's', start: at('16:00'), end: at('18:00') }], blocks: [],
      booked: [{ resource_id: 's', start: at('10:00'), end: at('11:00') }],
    }, ['s'], tz, d, d);
    const mins = (state: string) => w.filter((x) => x.state === state).reduce((m, x) => m + (x.end - x.start) / 60_000, 0);
    expect(mins('booked')).toBe(60);
    expect(mins('blocked')).toBe(60);
    expect(mins('leave')).toBe(120);
    expect(mins('free')).toBe(240);
    const off = buildCapacityWindows({ hours: [{ resource_id: 's', weekday: wd, start_time: '10:00', end_time: '18:00', effective_from: null, effective_to: null, timezone: tz }], breaks: [], overrides: [{ resource_id: 's', on_date: d, kind: 'off', start_time: null, end_time: null, timezone: tz }], leave: [], blocks: [], booked: [] }, ['s'], tz, d, d);
    expect(off).toEqual([]);
  });

  it('converts inventory units only within a dimension', () => {
    expect(convertQty(0.5, 'l', 'ml')).toBe(500);
    expect(convertQty(250, 'g', 'kg')).toBe(0.25);
    expect(convertQty(1, 'piece', 'ml')).toBeNull();
  });

  it('labels signal freshness; > 45 days is stale (T7)', () => {
    const now = Date.UTC(2026, 10, 9);
    expect(freshnessOf(now - 10 * 86_400_000, now)).toBe('fresh');
    expect(freshnessOf(now - 30 * 86_400_000, now)).toBe('aging');
    expect(freshnessOf(now - 46 * 86_400_000, now)).toBe('stale');
    expect(freshnessOf(null, now)).toBe('unknown');
  });

  it('publishes a manifest with the revenue basis and the status map', () => {
    const m = new LumaConnector().describe();
    expect(m.kind).toBe('luma');
    expect(m.revenue_basis).toMatch(/before tax/);
    expect(m.entities.map((e) => e.entity)).toContain('capacity_windows');
    expect(m.status_map.booking!.completed).toBe('fulfilled');
  });
});
