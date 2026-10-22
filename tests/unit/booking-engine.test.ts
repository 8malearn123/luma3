import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { itinerariesForDate, validateItinerary, type EngineInput, type ItemSpec, type StaffSchedule } from '@/server/domains/booking/engine';

const TZ = 'Asia/Riyadh';
// Sunday 2030-01-06 (weekday 0). "now" is the previous day so notice never interferes unless set.
const DAY = '2030-01-06';
const at = (hhmm: string, date = DAY) => DateTime.fromISO(`${date}T${hhmm}`, { zone: TZ }).toMillis();
const fmt = (ms: number) => DateTime.fromMillis(ms, { zone: TZ }).toFormat('HH:mm');

function staff(id: string, over: Partial<StaffSchedule> = {}): StaffSchedule {
  return { staffId: id, sort: 0, weekly: [{ weekday: 0, start: '10:00', end: '14:00', effectiveFrom: null, effectiveTo: null }], breaks: [], overrides: [], busy: [], ...over };
}

function input(over: Partial<EngineInput> = {}): EngineInput {
  return {
    tz: TZ, now: at('09:00', '2030-01-05'), minNoticeMin: 0, maxAdvanceDays: 60, slotIncrementMin: 30, maxGapMin: 30,
    anyStaffRule: 'earliest_then_least_booked', branchHours: [], staff: { a: staff('a') }, resources: [], bookedMinutes: {}, ...over,
  };
}

const item = (over: Partial<ItemSpec> = {}): ItemSpec => ({ key: 'i1', serviceId: 's1', durationByStaff: { a: 60 }, bufferBefore: 0, bufferAfter: 0, qualifiedStaff: ['a'], resourceNeeds: [], ...over });
const starts = (inp: EngineInput, items: ItemSpec[]) => itinerariesForDate(inp, items, DAY).map((i) => fmt(i.start));

describe('availability engine', () => {
  it('slots fit fully inside the shift (end-of-shift respected)', () => {
    expect(starts(input(), [item()])).toEqual(['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00']);
  });

  it('respects breaks', () => {
    const inp = input({ staff: { a: staff('a', { breaks: [{ weekday: 0, onDate: null, start: '12:00', end: '12:30' }] }) } });
    expect(starts(inp, [item()])).toEqual(['10:00', '10:30', '11:00', '12:30', '13:00']);
  });

  it('respects leave and existing allocations without exposing them', () => {
    const inp = input({ staff: { a: staff('a', { busy: [{ start: at('10:00'), end: at('11:30') }] }) } });
    expect(starts(inp, [item()])).toEqual(['11:30', '12:00', '12:30', '13:00']);
  });

  it('applies buffers before and after the service', () => {
    const r = starts(input(), [item({ bufferBefore: 15, bufferAfter: 15 })]);
    // occupied [start-15, start+75) must fit in 10:00–14:00
    expect(r[0]).toBe('10:30');
    expect(r[r.length - 1]).toBe('12:30');
  });

  it('excludes unqualified staff', () => {
    const inp = input({ staff: { a: staff('a'), b: staff('b', { weekly: [{ weekday: 0, start: '16:00', end: '18:00', effectiveFrom: null, effectiveTo: null }] }) } });
    expect(starts(inp, [item({ qualifiedStaff: ['a'] })]).every((s) => s < '14:00')).toBe(true);
  });

  it('day-off override removes the day; replace override changes hours', () => {
    expect(starts(input({ staff: { a: staff('a', { overrides: [{ onDate: DAY, kind: 'off', start: null, end: null }] }) } }), [item()])).toEqual([]);
    expect(starts(input({ staff: { a: staff('a', { overrides: [{ onDate: DAY, kind: 'replace', start: '18:00', end: '19:00' }] }) } }), [item()])).toEqual(['18:00']);
  });

  it('enforces minimum notice and the booking window', () => {
    const inp = input({ now: at('10:10'), minNoticeMin: 60 });
    expect(starts(inp, [item()])[0]).toBe('11:30');
    const far = input({ now: at('09:00', '2029-01-01'), maxAdvanceDays: 30 });
    expect(starts(far, [item()])).toEqual([]);
  });

  it('computes in the branch timezone (Riyadh UTC+3)', () => {
    const it0 = itinerariesForDate(input(), [item()], DAY)[0]!;
    expect(new Date(it0.start).toISOString()).toBe('2030-01-06T07:00:00.000Z');
  });

  it('requires a free resource unit of each required type', () => {
    const inp = input({ resources: [{ resourceId: 'room1', typeId: 'room', busy: [{ start: at('10:00'), end: at('13:00') }] }] });
    expect(starts(inp, [item({ resourceNeeds: [{ typeId: 'room', quantity: 1 }] })]).filter(Boolean)).toEqual(['13:00']);
  });

  it('chooses "any available" staff deterministically by the declared rule', () => {
    const inp = input({ staff: { a: staff('a', { sort: 1 }), b: staff('b', { sort: 2 }) }, bookedMinutes: { a: { [DAY]: 120 }, b: { [DAY]: 0 } } });
    const it0 = itinerariesForDate(inp, [item({ qualifiedStaff: ['a', 'b'], durationByStaff: { a: 60, b: 60 } })], DAY)[0]!;
    expect(it0.items[0]!.staffId).toBe('b'); // least booked
    const byOrder = itinerariesForDate({ ...inp, anyStaffRule: 'earliest_then_staff_order' }, [item({ qualifiedStaff: ['a', 'b'], durationByStaff: { a: 60, b: 60 } })], DAY)[0]!;
    expect(byOrder.items[0]!.staffId).toBe('a');
  });

  it('builds multi-service sequences with different staff and discloses gaps', () => {
    // a does hair 10:00–14:00; b does nails but only from 11:30.
    const inp = input({ staff: { a: staff('a'), b: staff('b', { weekly: [{ weekday: 0, start: '11:30', end: '14:00', effectiveFrom: null, effectiveTo: null }] }) } });
    const items = [item({ key: 'hair', qualifiedStaff: ['a'] }), item({ key: 'nails', serviceId: 's2', qualifiedStaff: ['b'], durationByStaff: { b: 30 } })];
    const first = itinerariesForDate(inp, items, DAY)[0]!;
    expect(first.items.map((i) => [i.key, i.staffId, fmt(i.start)])).toEqual([['hair', 'a', '10:00'], ['nails', 'b', '11:30']]);
    expect(first.gapsMin).toEqual([30]);
  });

  it('never returns a partial sequence when the second service cannot fit', () => {
    const inp = input({ maxGapMin: 0, staff: { a: staff('a'), b: staff('b', { weekly: [{ weekday: 0, start: '16:00', end: '17:00', effectiveFrom: null, effectiveTo: null }] }) } });
    const items = [item({ key: 'hair' }), item({ key: 'nails', qualifiedStaff: ['b'], durationByStaff: { b: 30 } })];
    expect(itinerariesForDate(inp, items, DAY)).toEqual([]);
  });

  it('the same staff can do consecutive services', () => {
    const items = [item({ key: 'x' }), item({ key: 'y', durationByStaff: { a: 30 } })];
    const first = itinerariesForDate(input(), items, DAY)[0]!;
    expect(first.items.map((i) => fmt(i.start))).toEqual(['10:00', '11:00']);
  });

  it('validates a concrete itinerary and rejects taken/unqualified/notice violations', () => {
    const inp = input({ staff: { a: staff('a', { busy: [{ start: at('11:00'), end: at('12:00') }] }) } });
    expect(validateItinerary(inp, [item()], [{ key: 'i1', staffId: 'a', start: at('10:00') }]).ok).toBe(true);
    expect(validateItinerary(inp, [item()], [{ key: 'i1', staffId: 'a', start: at('10:30') }])).toMatchObject({ ok: false, reason: 'slot_unavailable' });
    expect(validateItinerary(inp, [item()], [{ key: 'i1', staffId: 'z', start: at('10:00') }])).toMatchObject({ ok: false, reason: 'staff_not_qualified' });
    expect(validateItinerary({ ...inp, now: at('09:50'), minNoticeMin: 30 }, [item()], [{ key: 'i1', staffId: 'a', start: at('10:00') }])).toMatchObject({ ok: false, reason: 'notice_period' });
  });
});
