import type { CanonicalDataset, Transaction } from '@/loom';
import { addDays, localToMs } from '@/loom/util/time';
import { datasetBuilder, NOW, TODAY, TZ } from './loom-dataset';

/**
 * Seeded synthetic histories for phase 6 (learned models). Customers follow
 * their own visit cycle (so recency ÷ usual gap predicts a return), visits
 * avoid Fridays and cluster in the late afternoon (weekday / hour pattern),
 * and each customer prefers one offering. Fully deterministic per seed.
 */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
const HOUR_W = [1, 1, 1, 1, 2, 3, 4, 5, 4, 2];

export function syntheticHistory(opts: { seed?: number; days?: number; customers?: number; offerings?: number; churn?: number } = {}): { ds: CanonicalDataset; offerings: string[] } {
  const r = rng(opts.seed ?? 7);
  const days = opts.days ?? 300;
  const b = datasetBuilder({ createdDaysAgo: days + 30 });
  const offs = Array.from({ length: opts.offerings ?? 3 }, (_, i) => b.service({ name: `Service ${i + 1}`, price_minor: 15000 + i * 5000, cost: 3000 }));
  const staff = b.staff({ qualified: offs.map((o) => o.id) });
  const hourPick = () => { const tot = HOUR_W.reduce((a, c) => a + c, 0); let x = r() * tot; for (let i = 0; i < HOURS.length; i++) { x -= HOUR_W[i]!; if (x <= 0) return HOURS[i]!; } return 19; };
  const first = addDays(TODAY, -days);
  for (let c = 0; c < (opts.customers ?? 700); c++) {
    const cust = b.customer();
    const cycle = 21 + Math.floor(r() * 50);
    const pref = offs[Math.floor(r() * r() * offs.length)]!;
    let d = addDays(first, Math.floor(r() * days));
    while (d < TODAY) {
      let day = d;
      const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
      if (wd === 5) day = addDays(day, 1);
      else if (wd === 1 && r() < 0.5) day = addDays(day, 1);
      if (day >= TODAY) break;
      const o = r() < 0.8 ? pref : offs[Math.floor(r() * offs.length)]!;
      const at = localToMs(day, `${String(hourPick()).padStart(2, '0')}:00`, TZ);
      const tx: Transaction = {
        id: `t-${c}-${day}`, kind: 'booking', status: 'fulfilled', source_status: 'completed', channel: 'direct', origin: null, customer_ref: cust,
        gross_minor: o.price_minor, discount_minor: 0, tax_minor: 0, total_minor: o.price_minor, refunded_minor: 0, net_minor: o.price_minor, occurred_at: at, campaign_id: null, has_coupon: false, platform_fee_minor: 0,
        lines: [{ id: `l-${c}-${day}`, offering_id: o.id, resource_ids: [staff], qty: 1, net_minor: o.price_minor, line_total_minor: o.price_minor, cost_direct_minor: null, starts_at: at, duration_min: 60 }],
        consistent: true,
      };
      b.ds.transactions.push(tx);
      if (r() < (opts.churn ?? 0.06)) break;
      d = addDays(day, Math.max(7, Math.round(cycle * (0.8 + r() * 0.4))));
    }
  }
  b.ds.transactions.sort((x, y) => x.occurred_at - y.occurred_at);
  const ds = b.finalize();
  ds.meta = { ...ds.meta, as_of: NOW.getTime(), today: TODAY, data_version: `synthetic-${opts.seed ?? 7}-${days}` };
  return { ds, offerings: offs.map((o) => o.id) };
}

/** Shifts a dataset in time (simulates later data) by keeping only data before `today` and setting meta.today. */
export function asOf(ds: CanonicalDataset, today: string): CanonicalDataset {
  const end = localToMs(today, '00:00', TZ);
  return { ...ds, transactions: ds.transactions.filter((t) => t.occurred_at < end), meta: { ...ds.meta, today, as_of: end, data_version: `${ds.meta.data_version}@${today}` } };
}
