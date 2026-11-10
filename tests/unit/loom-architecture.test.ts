import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Architecture boundary of Loom Marketing Core (§4.1, docs/LOOM_CORE.md):
 *  1. nothing under src/loom imports src/server/domains/**, routes or UI;
 *  2. the only shared infrastructure allowed is a narrow allowlist;
 *  3. Loom never reads or writes LUMA's public tables directly: query
 *     builders and raw SQL may only name loom.* and loom_export.* relations.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');
const LOOM = path.join(ROOT, 'src/loom');
const ALLOWED_SERVER = new Set(['@/server/db/client', '@/server/db/schema.generated', '@/server/infra/audit', '@/server/infra/outbox', '@/server/http/errors', '@/server/jobs/registry']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

/** Public tables = keys of the generated DB type without a schema prefix. */
function publicTables(): string[] {
  const src = readFileSync(path.join(ROOT, 'src/server/db/schema.generated.ts'), 'utf8');
  const db = src.slice(src.indexOf('export interface DB {'));
  return [...db.matchAll(/^\s+"?([a-z_][a-z0-9_.]*)"?: /gm)].map((m) => m[1]!).filter((t) => !t.includes('.'));
}

export function violations(file: string, text: string, tables: string[]): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1] ?? m[2]!;
    const resolved = spec.startsWith('.') ? path.resolve(path.dirname(file), spec) : spec;
    if (/server\/domains|^@\/app\/|^@\/ui\/|src\/app\/|src\/ui\//.test(resolved)) out.push(`forbidden import ${spec}`);
    if (spec.startsWith('@/server/') && !ALLOWED_SERVER.has(spec)) out.push(`server import outside the allowlist: ${spec}`);
    if (spec.startsWith('.') && !resolved.startsWith(LOOM)) out.push(`relative import leaving src/loom: ${spec}`);
  }
  const tableSet = new Set(tables);
  for (const m of text.matchAll(/\b(selectFrom|insertInto|updateTable|deleteFrom|with|innerJoin|leftJoin|rightJoin)\(\s*['"]([a-z_][a-z0-9_.]*)/g)) {
    const t = m[2]!.split(' ')[0]!;
    if (tableSet.has(t) || !(t.startsWith('loom.') || t.startsWith('loom_export.'))) out.push(`query builder on ${t}`);
  }
  for (const m of text.matchAll(/sql(?:<[^`]*?>)?`([^`]*)`/g)) {
    for (const r of m[1]!.matchAll(/\b(?:from|join|into|update|table)\s+(?:only\s+)?("?[a-z_][a-z0-9_]*"?(?:\."?[a-z_][a-z0-9_]*"?)?)/gi)) {
      const name = r[1]!.replaceAll('"', '');
      if (!(name.startsWith('loom.') || name.startsWith('loom_export.'))) out.push(`raw SQL on ${name}`);
    }
  }
  return out;
}

describe('Loom architecture boundary', () => {
  const tables = publicTables();

  it('knows the public tables (sanity)', () => {
    expect(tables).toEqual(expect.arrayContaining(['bookings', 'services', 'tenants', 'inventory_items']));
    expect(tables).not.toContain('loom.opportunities');
  });

  it('src/loom imports no LUMA domain and reads no public table directly', () => {
    const problems: string[] = [];
    for (const f of files(LOOM)) for (const v of violations(f, readFileSync(f, 'utf8'), tables)) problems.push(`${path.relative(ROOT, f)}: ${v}`);
    expect(problems).toEqual([]);
  });

  it('the checker itself catches violations', () => {
    const f = path.join(LOOM, 'x.ts');
    expect(violations(f, "import { serviceDemand } from '@/server/domains/analytics/metrics';", tables)).toHaveLength(2);
    expect(violations(f, "import { x } from '../server/domains/marketing/rules';", tables).length).toBeGreaterThan(0);
    expect(violations(f, "trx.selectFrom('bookings').selectAll()", tables)).toEqual(['query builder on bookings']);
    expect(violations(f, 'await sql`select * from booking_items bi join bookings b on true`.execute(trx)', tables)).toEqual(['raw SQL on booking_items', 'raw SQL on bookings']);
    expect(violations(f, "trx.selectFrom('loom_export.transactions'); sql`update loom.analyses set x = 1`", tables)).toEqual([]);
  });

  it('only the host adapter and routes reach both worlds', () => {
    const host = readFileSync(path.join(ROOT, 'src/server/loom-host/actions.ts'), 'utf8');
    expect(host).toMatch(/from '@\/loom'/);
    expect(host).toMatch(/domains\/marketing/);
  });
});
