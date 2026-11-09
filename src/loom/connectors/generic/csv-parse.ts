/**
 * RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, BOM). Pure.
 * Returns the header and rows as objects keyed by the trimmed header names.
 */
export type ParsedCsv = { header: string[]; rows: Array<Record<string, string>>; errors: string[] };

export const MAX_CSV_ROWS = 50_000;

export function parseCsv(text: string, opts: { maxRows?: number } = {}): ParsedCsv {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = '', row: string[] = [], inQuotes = false, i = 0;
  const errors: string[] = [];
  const pushRow = () => { row.push(field); field = ''; if (!(row.length === 1 && row[0] === '')) records.push(row); row = []; };
  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { pushRow(); i++; if (records.length > (opts.maxRows ?? MAX_CSV_ROWS) + 1) { errors.push('too_many_rows'); break; } continue; }
    field += ch; i++;
  }
  if (inQuotes) errors.push('unterminated_quote');
  if (field !== '' || row.length) pushRow();
  const [head, ...body] = records;
  const header = (head ?? []).map((h) => h.trim());
  if (!header.length || header.every((h) => !h)) return { header: [], rows: [], errors: [...errors, 'empty_file'] };
  const dup = header.find((h, idx) => h && header.indexOf(h) !== idx);
  if (dup) errors.push(`duplicate_column:${dup}`);
  const rows = body.map((r) => Object.fromEntries(header.map((h, idx) => [h, (r[idx] ?? '').trim()])));
  body.forEach((r, idx) => { if (r.length !== header.length) errors.push(`row_${idx + 2}:column_count`); });
  return { header, rows, errors: errors.slice(0, 50) };
}

/** Serialises rows back to CSV (template downloads, tests). */
export function toCsv(header: string[], rows: Array<Array<string | number | boolean | null>>): string {
  const esc = (v: string | number | boolean | null) => { const s = v === null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
  return [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n') + '\n';
}
