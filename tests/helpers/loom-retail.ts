import { DateTime } from 'luxon';
import { toCsv, type Mapping } from '@/loom';

/**
 * A retail store's export as CSV files (the documented templates), dated
 * relative to now in Asia/Riyadh. 6 products; P1 is the best seller with
 * little stock (stockout risk); P5 is a slow mover with lots of stock;
 * P2 is usually bought together with P1 (basket cross-sell); statuses are
 * the source system's own words ("done", "refunded", "void"), mapped in the
 * mapping step. C29 and C30 share a contact hash (suspected duplicate).
 */
const TZ = 'Asia/Riyadh';
const local = (daysAgo: number, hour = 18) => DateTime.now().setZone(TZ).minus({ days: daysAgo }).set({ hour, minute: 15, second: 0, millisecond: 0 }).toFormat('yyyy-MM-dd HH:mm');
const day = (daysAhead: number, hour: number) => DateTime.now().setZone(TZ).plus({ days: daysAhead }).set({ hour, minute: 0, second: 0, millisecond: 0 }).toFormat('yyyy-MM-dd HH:mm');

export const RETAIL_MAPPING: Mapping = {
  timezone: TZ, currency: 'SAR', money_unit: 'major',
  columns: { transactions: { id: 'order_no', status: 'state' } },
  status_map: { done: 'fulfilled', refunded: 'cancelled_customer', void: 'cancelled_business', pending: 'requested' },
  revenue_basis: { amounts_include_tax: true, subtract_refunds: true, total_is_after_discount: true },
};

export function retailCsv(opts: { orders?: number } = {}) {
  const products = [
    ['P1', 'product', 'قهوة مختصة', 'Specialty coffee', '60.00', 'active', '', '', '0', '30.00', 'true', 'true', 'true'],
    ['P2', 'product', 'فلتر ورقي', 'Paper filters', '15.00', 'active', '', '', '0', '5.00', 'true', 'true', 'true'],
    ['P3', 'product', 'مطحنة يدوية', 'Hand grinder', '220.00', 'active', '', '', '0', '120.00', 'true', 'true', 'true'],
    ['P4', 'product', 'كوب حراري', 'Travel mug', '45.00', 'active', '', '', '0', '20.00', 'true', 'true', 'true'],
    ['P5', 'product', 'إبريق تقطير', 'Pour-over kettle', '150.00', 'active', '', '', '0', '80.00', 'true', 'true', 'true'],
    ['P6', 'product', 'قهوة مختصة', 'Specialty coffee (old SKU)', '60.00', 'inactive', '', '', '0', '30.00', 'false', 'false', 'false'],
  ];
  const offerings = toCsv(['id', 'kind', 'name', 'name_en', 'price', 'status', 'category', 'duration_min', 'buffer_min', 'cost', 'has_image', 'has_description', 'visible'], products);
  const inventory = toCsv(['id', 'name', 'usage', 'on_hand', 'reserved', 'unit', 'unit_cost', 'reorder_level', 'offering_id', 'active'], [
    ['I1', 'Specialty coffee 250g', 'sellable', 6, 0, 'unit', '30.00', 10, 'P1', 'true'],
    ['I2', 'Paper filters x100', 'sellable', 80, 0, 'unit', '5.00', 10, 'P2', 'true'],
    ['I3', 'Hand grinder', 'sellable', 12, 0, 'unit', '120.00', 2, 'P3', 'true'],
    ['I4', 'Travel mug', 'sellable', 30, 0, 'unit', '20.00', 5, 'P4', 'true'],
    ['I5', 'Pour-over kettle', 'sellable', 90, 0, 'unit', '80.00', 2, 'P5', 'true'],
  ]);
  const resources = toCsv(['id', 'kind', 'type_ref', 'skills', 'active'], [['PACK-1', 'staff', 'packer', '', 'true'], ['VAN-1', 'vehicle', 'van', '', 'true']]);
  const windows: Array<Array<string>> = [];
  for (let d = 0; d < 14; d++) { windows.push(['PACK-1', day(d, 9), day(d, 17), 'free']); windows.push(['VAN-1', day(d, 12), day(d, 20), 'free']); }
  const capacity = toCsv(['resource_id', 'start', 'end', 'state'], windows);
  const orders: Array<Array<string | number>> = [];
  const lines: Array<Array<string | number>> = [];
  const n = opts.orders ?? 60;
  for (let i = 0; i < n; i++) {
    const id = `O-${1000 + i}`;
    const cust = `C${(i % 28) + 1}`;
    const status = i % 15 === 7 ? 'refunded' : i % 20 === 11 ? 'void' : 'done';
    // P1 in every order; P2 in 2 of 3; P3 or P4 sometimes; P5 almost never.
    const items: Array<[string, number, number]> = [['P1', 1, 60]];
    if (i % 3 !== 0) items.push(['P2', 1, 15]);
    if (i % 4 === 0) items.push(['P4', 1, 45]);
    if (i % 8 === 0) items.push(['P3', 1, 220]);
    if (i === 5) items.push(['P5', 1, 150]);
    const gross = items.reduce((m, x) => m + x[2], 0);
    const tax = Math.round(gross * 0.15 / 1.15 * 100) / 100;
    orders.push([id, 'order', status, local(1 + Math.floor(i * 1.3)), cust, 'in_store', gross.toFixed(2), '0', tax.toFixed(2), gross.toFixed(2), status === 'refunded' ? gross.toFixed(2) : '0']);
    for (const [p, q, t] of items) lines.push([id, p, q, t.toFixed(2)]);
  }
  const transactions = toCsv(['order_no', 'kind', 'state', 'occurred_at', 'customer_ref', 'channel', 'gross', 'discount', 'tax', 'total', 'refunded'], orders);
  const transactionLines = toCsv(['transaction_id', 'offering_id', 'qty', 'line_total'], lines);
  const customers = toCsv(['pseudo_id', 'created_at', 'acquisition_source', 'consent_marketing', 'dup_key'],
    Array.from({ length: 30 }, (_, i) => [`C${i + 1}`, local(200), i % 2 ? 'instagram' : 'walk_in', i % 3 ? 'true' : 'false', i >= 28 ? 'hash-shared' : `hash-${i}`]));
  const costs = toCsv(['type', 'scope', 'offering_id', 'amount', 'rate_bp', 'completeness'], [['payment_fee', 'business', '', '', '200', 'complete']]);
  return { offerings, inventory_items: inventory, resources, capacity_windows: capacity, transactions, transaction_lines: transactionLines, customers, cost_facts: costs };
}

/** Enables the retail pack for a test file without writing platform audit records (other suites count them). */
export async function enableRetailPack() {
  const { withSystem } = await import('@/server/db/client');
  await withSystem('test: enable retail pack', (trx) => trx.insertInto('loom.loom_settings').values({ key: 'platform.enabled_sector_packs', value: JSON.stringify(['beauty', 'retail']) })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(['beauty', 'retail']) })).execute());
}
