import { sql } from 'kysely';
import { withSystem, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { resolvePeriod } from '../analytics/period';
import { formatMoney } from '@/shared/format';
import { marketplaceFeesForTenant, type FeePeriod } from './fees';

/**
 * Settlement statements for the split-payment model: customers pay through
 * LUMA's payment intermediary, which pays each provider directly and keeps
 * LUMA's marketplace fee. A statement per tenant per period shows what was
 * collected online (gross), refunds, LUMA's marketplace fee and the provider
 * net. Statements stay `simulated` (recomputed on every generation) until the
 * platform owner records the intermediary's settlement reference (`settled`,
 * frozen). Cash, POS terminal and gift-card payments never pass through the
 * intermediary and are excluded.
 */
export const OFFLINE_METHODS = ['cash', 'pos_terminal', 'gift_card'] as const;
const TZ = 'Asia/Riyadh';

async function computeFor(trx: Tx, tenantId: string, p: FeePeriod) {
  const g = await sql<{ gross: number; n: number; currency: string | null }>`
    select coalesce(sum(amount_minor), 0)::bigint as gross, count(*)::int as n, max(currency) as currency
    from payments where tenant_id = ${tenantId} and status = 'captured'
      and method not in ('cash', 'pos_terminal', 'gift_card')
      and captured_at >= ${p.start} and captured_at < ${p.end}`.execute(trx);
  const r = await sql<{ refunds: number }>`
    select coalesce(sum(r.amount_minor), 0)::bigint as refunds from refunds r
    join payments pay on pay.tenant_id = r.tenant_id and pay.id = r.payment_id
    where r.tenant_id = ${tenantId} and r.status = 'succeeded' and pay.method not in ('cash', 'pos_terminal', 'gift_card')
      and coalesce(r.completed_at, r.created_at) >= ${p.start} and coalesce(r.completed_at, r.created_at) < ${p.end}`.execute(trx);
  const fees = await marketplaceFeesForTenant(trx, tenantId, p);
  const gross = g.rows[0]?.gross ?? 0;
  const refunds = r.rows[0]?.refunds ?? 0;
  // The fee can never exceed what was actually collected net of refunds.
  const fee = Math.max(0, Math.min(fees.fee_minor, gross - refunds));
  return { gross, refunds, fee, net: gross - refunds - fee, count: g.rows[0]?.n ?? 0, currency: g.rows[0]?.currency ?? 'SAR', feeSource: fees.source };
}

/**
 * (Re)generates statements for a period: every tenant with online payments,
 * refunds or marketplace fees in it (or one tenant). Settled statements are
 * never touched.
 */
export async function generateStatements(actor: AuditActor, input: { from: string; to: string; tenant?: string }) {
  const p = resolvePeriod(TZ, input.from, input.to);
  return withSystem('platform: generate settlement statements', async (trx) => {
    let tenantIds: string[];
    if (input.tenant) {
      const t = await trx.selectFrom('tenants').select('id').where(sql<string>`slug::text`, '=', input.tenant).executeTakeFirst();
      if (!t) throw Errors.notFound('business');
      tenantIds = [t.id];
    } else {
      const r = await sql<{ tenant_id: string }>`
        select distinct tenant_id from payments where status = 'captured' and method not in ('cash', 'pos_terminal', 'gift_card') and captured_at >= ${p.start} and captured_at < ${p.end}
        union select distinct tenant_id from refunds where status = 'succeeded' and coalesce(completed_at, created_at) >= ${p.start} and coalesce(completed_at, created_at) < ${p.end}
        union select distinct tenant_id from bookings where created_at >= ${p.start} and created_at < ${p.end} and source not in ('dashboard', 'walk_in')`.execute(trx);
      tenantIds = r.rows.map((x) => x.tenant_id);
    }
    let created = 0, updated = 0, skipped = 0;
    for (const tenantId of tenantIds) {
      const c = await computeFor(trx, tenantId, p);
      if (!input.tenant && c.gross === 0 && c.refunds === 0 && c.fee === 0) continue;
      const cur = await trx.selectFrom('settlement_statements').select(['id', 'status']).where('tenant_id', '=', tenantId)
        .where('period_start', '=', p.from).where('period_end', '=', p.to).forUpdate().executeTakeFirst();
      const values = { gross_minor: c.gross, refunds_minor: c.refunds, fee_minor: c.fee, net_minor: c.net, payments_count: c.count, currency: c.currency, fee_source: c.feeSource, generated_by: actor.userId };
      if (!cur) {
        await trx.insertInto('settlement_statements').values({ tenant_id: tenantId, period_start: p.from, period_end: p.to, ...values }).execute();
        created++;
      } else if (cur.status === 'simulated') {
        await trx.updateTable('settlement_statements').set(values).where('id', '=', cur.id).execute();
        updated++;
      } else skipped++;
    }
    await audit(trx, actor, 'platform.settlements.generated', { targetType: 'settlement_period', data: { from: p.from, to: p.to, tenant: input.tenant ?? null, created, updated, skipped } });
    return { from: p.from, to: p.to, created, updated, skipped_settled: skipped };
  });
}

export async function listStatements(q: { tenant?: string; status?: string; from?: string; to?: string; page: number; limit: number }) {
  return withSystem('platform: list settlement statements', async (trx) => {
    let base = trx.selectFrom('settlement_statements as s').innerJoin('tenants as t', 't.id', 's.tenant_id');
    if (q.tenant) base = base.where(sql<string>`t.slug::text`, '=', q.tenant);
    if (q.status) base = base.where('s.status', '=', q.status);
    if (q.from) base = base.where('s.period_end', '>=', q.from);
    if (q.to) base = base.where('s.period_start', '<=', q.to);
    const totals = await base.select([sql<number>`count(*)::int`.as('n'), sql<number>`coalesce(sum(s.gross_minor),0)::bigint`.as('gross'), sql<number>`coalesce(sum(s.refunds_minor),0)::bigint`.as('refunds'),
      sql<number>`coalesce(sum(s.fee_minor),0)::bigint`.as('fee'), sql<number>`coalesce(sum(s.net_minor),0)::bigint`.as('net')]).executeTakeFirstOrThrow();
    const items = await base.select(['s.id', 's.period_start', 's.period_end', 's.currency', 's.gross_minor', 's.refunds_minor', 's.fee_minor', 's.net_minor', 's.payments_count', 's.fee_source',
      's.status', 's.settled_at', 's.settlement_reference', 's.created_at', 's.updated_at', 't.id as tenant_id', sql<string>`t.slug::text`.as('tenant_slug'), 't.name as tenant_name'])
      .orderBy('s.period_start', 'desc').orderBy('t.name').limit(q.limit).offset((q.page - 1) * q.limit).execute();
    return { items, total: totals.n, totals: { gross_minor: totals.gross, refunds_minor: totals.refunds, fee_minor: totals.fee, net_minor: totals.net }, page: q.page, limit: q.limit };
  });
}

export async function statementDetail(id: string) {
  return withSystem('platform: settlement statement detail', async (trx) => {
    const s = await trx.selectFrom('settlement_statements as s').innerJoin('tenants as t', 't.id', 's.tenant_id')
      .leftJoin('users as u', 'u.id', 's.settled_by')
      .selectAll('s').select([sql<string>`t.slug::text`.as('tenant_slug'), 't.name as tenant_name', 't.city as tenant_city', 'u.display_name as settled_by_name'])
      .where('s.id', '=', id).executeTakeFirst();
    if (!s) throw Errors.notFound('statement');
    const p = resolvePeriod(TZ, s.period_start, s.period_end);
    // Line items: online payments only (no customer identity; booking/order number for reconciliation).
    const lines = await sql<{ id: string; captured_at: Date; purpose: string; method: string; amount_minor: number; currency: string; reference: string | null; refunded_minor: number }>`
      select pay.id, pay.captured_at, pay.purpose, pay.method, pay.amount_minor, pay.currency,
        coalesce(b.number, o.number) as reference,
        coalesce((select sum(r.amount_minor) from refunds r where r.tenant_id = pay.tenant_id and r.payment_id = pay.id and r.status = 'succeeded'), 0)::bigint as refunded_minor
      from payments pay
      left join bookings b on b.tenant_id = pay.tenant_id and b.id = pay.booking_id
      left join orders o on o.tenant_id = pay.tenant_id and o.id = pay.order_id
      where pay.tenant_id = ${s.tenant_id} and pay.status = 'captured' and pay.method not in ('cash', 'pos_terminal', 'gift_card')
        and pay.captured_at >= ${p.start} and pay.captured_at < ${p.end}
      order by pay.captured_at limit 2000`.execute(trx);
    return { statement: s, lines: lines.rows };
  });
}

export async function settleStatement(id: string, actor: AuditActor, input: { reference: string }) {
  return withSystem('platform: mark settlement settled', async (trx) => {
    const s = await trx.selectFrom('settlement_statements').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!s) throw Errors.notFound('statement');
    if (s.status === 'settled') throw Errors.conflict('already_settled', 'This statement is already settled');
    const row = await trx.updateTable('settlement_statements').set({ status: 'settled', settled_at: new Date(), settled_by: actor.userId, settlement_reference: input.reference })
      .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'platform.settlement.settled', { tenantId: s.tenant_id, targetType: 'settlement_statement', targetId: id, data: { reference: input.reference, net_minor: s.net_minor, fee_minor: s.fee_minor } });
    return row;
  });
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Print-ready (PDF via the browser's print) bilingual HTML statement. */
export function statementHtml(d: Awaited<ReturnType<typeof statementDetail>>, platformName: string) {
  const s = d.statement;
  const m = (v: number) => esc(formatMoney(v, s.currency, 'ar'));
  const rows = d.lines.map((l) => `<tr><td>${esc(l.captured_at.toISOString().slice(0, 16).replace('T', ' '))}</td><td>${esc(l.reference ?? '—')}</td><td>${esc(l.purpose)}</td><td>${esc(l.method)}</td><td class="n">${m(l.amount_minor)}</td><td class="n">${l.refunded_minor ? m(l.refunded_minor) : '—'}</td></tr>`).join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(platformName)} — كشف تسوية ${esc(s.tenant_name)} ${esc(s.period_start)} → ${esc(s.period_end)}</title>
<style>
body{font-family:system-ui,'Segoe UI',Tahoma,sans-serif;color:#1f1630;margin:32px;font-size:13px}
h1{font-size:20px;margin:0 0 4px;color:#4c1d95}h2{font-size:14px;margin:24px 0 8px}
.meta{color:#555;margin-bottom:16px}.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;background:${s.status === 'settled' ? '#dcfce7' : '#fef3c7'}}
table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #e5e1ee;padding:6px 8px;text-align:start}th{background:#f5f3fa;font-weight:600}
.n{text-align:end;font-variant-numeric:tabular-nums;direction:ltr}.sum td{font-weight:600}.total td{font-size:15px;font-weight:700;border-top:2px solid #4c1d95}
.foot{margin-top:24px;color:#666;font-size:11px}@media print{body{margin:12mm}button{display:none}}
</style></head><body>
<button onclick="window.print()" style="float:left">طباعة / PDF · Print</button>
<h1>${esc(platformName)} · كشف تسوية مدفوعات · Settlement statement</h1>
<div class="meta">${esc(s.tenant_name)} (${esc(s.tenant_slug)})${s.tenant_city ? ` · ${esc(s.tenant_city)}` : ''}<br>
الفترة · Period: <b dir="ltr">${esc(s.period_start)} → ${esc(s.period_end)}</b> · <span class="badge">${s.status === 'settled' ? 'مُسوّى · Settled' : 'محاكاة · Simulated'}</span>
${s.settlement_reference ? `<br>مرجع التسوية · Reference: <b dir="ltr">${esc(s.settlement_reference)}</b>` : ''}</div>
<table><tbody>
<tr><td>إجمالي المحصّل إلكترونياً · Gross collected online (${s.payments_count})</td><td class="n">${m(s.gross_minor)}</td></tr>
<tr><td>المسترد · Refunds</td><td class="n">− ${m(s.refunds_minor)}</td></tr>
<tr><td>عمولة سوق لوما · LUMA marketplace fee</td><td class="n">− ${m(s.fee_minor)}</td></tr>
<tr class="total"><td>صافي مستحق النشاط · Provider net</td><td class="n">${m(s.net_minor)}</td></tr>
</tbody></table>
<h2>المدفوعات · Payments</h2>
<table><thead><tr><th>التاريخ · Date (UTC)</th><th>المرجع · Ref</th><th>النوع · Purpose</th><th>الطريقة · Method</th><th class="n">المبلغ · Amount</th><th class="n">المسترد · Refunded</th></tr></thead><tbody>${rows || '<tr><td colspan="6">—</td></tr>'}</tbody></table>
<p class="foot">وسيط الدفع يحوّل صافي المستحق مباشرة إلى حساب النشاط ويحتفظ بعمولة لوما. المبالغ شاملة ضريبة القيمة المضافة. مصدر العمولة: ${esc(s.fee_source)}.<br>
The payment intermediary pays the provider net directly and keeps LUMA's fee. Amounts are VAT-inclusive. Fee source: ${esc(s.fee_source)}.</p>
</body></html>`;
}
