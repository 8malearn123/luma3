import { withSystem } from '../../db/client';
import { audit, type AuditActor } from '../../infra/audit';

/** CSV for platform exports: UTF-8 BOM (Excel + Arabic), CRLF, formula-injection safe. */
export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]) {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  const esc = (v: unknown) => {
    const s = v instanceof Date ? v.toISOString() : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return `﻿${[cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n')}`;
}

/** Audited CSV download response (every platform export is a sensitive action). */
export async function csvResponse(actor: AuditActor, kind: string, filename: string, rows: Array<Record<string, unknown>>, columns?: string[], filters: Record<string, unknown> = {}) {
  await withSystem('platform: audit export', (trx) => audit(trx, actor, 'platform.export', { targetType: 'export', data: { kind, rows: rows.length, filters } }));
  return new Response(toCsv(rows, columns), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** Minor units → "123.45" for spreadsheets. */
export const major = (minor: number | null | undefined) => (minor == null ? '' : (minor / 100).toFixed(2));
