import { IANAZone } from 'luxon';
import { z } from 'zod';
import { TRANSACTION_STATUSES, type TransactionStatus } from '../../contracts/canonical';
import { stableHash } from '../../util/text';
import { localToMs } from '../../util/time';
import { PII_COLUMN, SOURCE_ENTITIES, TEMPLATES, type FieldDef, type SourceEntity } from './templates';

/**
 * The mapping step of a staged connection (§16 rule: a new system does not
 * work just by connecting). Stored in loom.source_mappings (entity '*'):
 *   columns        per entity: template field → source column (default: same name)
 *   status_map     source transaction status → canonical status (§5.2)
 *   revenue_basis  how the source's amounts relate to the canonical net
 *   timezone, currency, money_unit
 */
export const revenueBasisSchema = z.object({
  /** Amounts (total, line totals) include tax: tax is subtracted for net. */
  amounts_include_tax: z.boolean(),
  /** Refunds are subtracted from revenue. */
  subtract_refunds: z.boolean(),
  /** `total` is already after discounts; otherwise net starts from gross − discount. */
  total_is_after_discount: z.boolean(),
}).strict();
export type RevenueBasis = z.infer<typeof revenueBasisSchema>;

export const mappingSchema = z.object({
  timezone: z.string().min(3).max(64).refine((tz) => IANAZone.isValidZone(tz), { message: 'invalid timezone' }),
  currency: z.string().regex(/^[A-Z]{3}$/),
  money_unit: z.enum(['major', 'minor']).default('major'),
  columns: z.partialRecord(z.enum(SOURCE_ENTITIES), z.record(z.string().max(60), z.string().min(1).max(80))).default({}),
  status_map: z.record(z.string().min(1).max(60), z.enum(TRANSACTION_STATUSES)).default({}),
  revenue_basis: revenueBasisSchema,
}).strict();
export type Mapping = z.infer<typeof mappingSchema>;

export function describeRevenueBasis(b: RevenueBasis) {
  return [
    b.total_is_after_discount ? 'net starts from total (after discounts)' : 'net starts from gross − discount',
    b.amounts_include_tax ? 'minus tax (amounts include tax)' : 'tax not included in amounts',
    b.subtract_refunds ? 'minus refunds' : 'refunds not subtracted',
  ].join('; ');
}

export type RowError = { row: number; field: string; code: string; value?: string };
export type NormalizedRow = { op: 'upsert' | 'delete'; source_id: string; source_version: string; data: Record<string, unknown> };

const TRUE = new Set(['true', '1', 'yes', 'y', 'نعم']);
const FALSE = new Set(['false', '0', 'no', 'n', 'لا', '']);

export function columnFor(m: Pick<Mapping, 'columns'> | null, entity: SourceEntity, field: string) {
  return m?.columns?.[entity]?.[field] ?? field;
}

function convert(def: FieldDef, raw: string, m: Pick<Mapping, 'timezone' | 'money_unit'>): { ok: true; v: unknown } | { ok: false } {
  const s = raw.trim();
  if (s === '') return { ok: true, v: null };
  switch (def.type) {
    case 'string': return { ok: true, v: s.slice(0, 500) };
    case 'money': {
      if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false };
      return { ok: true, v: m.money_unit === 'minor' ? Math.round(Number(s)) : Math.round(Number(s) * 100) };
    }
    case 'number': return /^-?\d+(\.\d+)?$/.test(s) ? { ok: true, v: Number(s) } : { ok: false };
    case 'int': return /^-?\d+$/.test(s) ? { ok: true, v: Number(s) } : { ok: false };
    case 'bool': { const l = s.toLowerCase(); return TRUE.has(l) ? { ok: true, v: true } : FALSE.has(l) ? { ok: true, v: false } : { ok: false }; }
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { ok: true, v: s } : { ok: false };
    case 'datetime': {
      // Absolute instants (Z or an offset) are kept; local date-times are read in the mapping timezone.
      if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && /T/.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? { ok: true, v: t } : { ok: false }; }
      const mt = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/.exec(s);
      if (!mt) return { ok: false };
      const t = localToMs(mt[1]!, mt[2] ?? '00:00', m.timezone);
      return Number.isFinite(t) ? { ok: true, v: t } : { ok: false };
    }
    case 'enum': { const l = s.toLowerCase(); return def.values!.includes(l) ? { ok: true, v: l } : { ok: false }; }
    case 'list': return { ok: true, v: s.split('|').map((x) => x.trim()).filter(Boolean).slice(0, 50) };
  }
}

/** Header check: required columns present, no contact columns. */
export function checkHeader(entity: SourceEntity, header: string[], m: Pick<Mapping, 'columns'> | null): RowError[] {
  const errors: RowError[] = [];
  for (const def of TEMPLATES[entity].fields) {
    if (def.required && !header.includes(columnFor(m, entity, def.field))) errors.push({ row: 1, field: def.field, code: 'missing_column', value: columnFor(m, entity, def.field) });
  }
  for (const h of header) if (PII_COLUMN.test(h) && !(entity === 'offerings' || entity === 'inventory_items')) errors.push({ row: 1, field: h, code: 'pii_column' });
  return errors;
}

export function statusOf(m: Pick<Mapping, 'status_map'>, raw: string): TransactionStatus | null {
  const k = raw.trim().toLowerCase();
  const mapped = m.status_map[k] ?? m.status_map[raw.trim()];
  if (mapped) return mapped;
  return (TRANSACTION_STATUSES as readonly string[]).includes(k) ? (k as TransactionStatus) : null;
}

/**
 * Converts source rows of one entity into normalised rows (template field
 * names, typed values, money in minor units, instants in epoch ms, statuses
 * normalised). Rows with errors are reported and skipped. A `_op` column
 * with value `delete` produces a tombstone.
 */
export function normalizeRows(entity: SourceEntity, rows: Array<Record<string, unknown>>, m: Mapping, opts: { firstRow?: number } = {}) {
  const tpl = TEMPLATES[entity];
  const out: NormalizedRow[] = [];
  const errors: RowError[] = [];
  const unmapped = new Set<string>();
  const seenLines = new Map<string, number>();
  rows.forEach((raw, idx) => {
    const rowNo = idx + (opts.firstRow ?? 2);
    const data: Record<string, unknown> = {};
    let bad = false;
    const isDelete = String(raw._op ?? '').toLowerCase() === 'delete';
    for (const def of tpl.fields) {
      const v0 = raw[columnFor(m, entity, def.field)];
      const s = v0 === undefined || v0 === null ? (def.default ?? '') : typeof v0 === 'object' ? JSON.stringify(v0) : String(v0);
      const c = convert(def, s === '' && def.default !== undefined ? def.default : s, m);
      if (!c.ok) { errors.push({ row: rowNo, field: def.field, code: 'invalid_value', value: s.slice(0, 40) }); bad = true; continue; }
      if (def.required && c.v === null && !(isDelete && !tpl.key.includes(def.field))) { errors.push({ row: rowNo, field: def.field, code: 'required' }); bad = true; continue; }
      data[def.field] = c.v;
    }
    if (bad) return;
    if (entity === 'transactions' && !isDelete) {
      const st = statusOf(m, String(data.status));
      data.source_status = data.status;
      if (!st) { unmapped.add(String(data.status)); data.status = null; } else data.status = st;
    }
    if (entity === 'capacity_windows' && !isDelete && (data.end as number) <= (data.start as number)) { errors.push({ row: rowNo, field: 'end', code: 'end_before_start' }); return; }
    if (entity === 'reviews' && !isDelete && ((data.rating as number) < 0 || (data.rating as number) > 5)) { errors.push({ row: rowNo, field: 'rating', code: 'out_of_range' }); return; }
    let key = tpl.key.map((k) => String(data[k] ?? '-')).join(':');
    if (entity === 'transaction_lines' && !data.line_id) {
      const base = `${data.transaction_id}:${data.offering_id}`;
      const n = (seenLines.get(base) ?? 0) + 1;
      seenLines.set(base, n);
      key = `${base}#${n}`;
    }
    out.push({ op: isDelete ? 'delete' : 'upsert', source_id: key.slice(0, 200), source_version: stableHash(data).slice(0, 16), data });
  });
  return { rows: out, errors: errors.slice(0, 200), error_count: errors.length, unmapped_statuses: [...unmapped].sort() };
}
