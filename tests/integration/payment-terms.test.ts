import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withSystem, withTenant } from '@/server/db/client';
import { computePaymentTerms, depositFor, reassessPaymentTerms, requireAllowedOption } from '@/server/domains/policy/payment-terms';
import { createDecision } from '@/server/domains/policy/decisions';
import { createBusinessFor, signup } from '../helpers/factory';
import { me, relationshipFor, setTenantSettings } from '../helpers/policy';
import type { PaymentMethod } from '@/shared/payments';

const ALL: PaymentMethod[] = ['card', 'mada', 'cash'];
const sys = { userId: null, kind: 'system' as const };

async function setup(settings: Record<string, unknown> = {}) {
  const owner = await signup('Owner');
  const biz = await createBusinessFor(owner);
  const customer = await signup('Customer');
  const cu = await me(customer);
  const tcId = await relationshipFor(biz.tenantId, customer);
  const ownerId = (await me(owner)).id;
  if (Object.keys(settings).length) await setTenantSettings(biz.tenantId, settings);
  const terms = (amount: number, methods: PaymentMethod[] = ALL, context: 'booking' | 'order' = 'booking', now?: Date) =>
    withTenant(biz.tenantId, (trx) => computePaymentTerms(trx, { tenantId: biz.tenantId, tenantCustomerId: tcId, customerUserId: null, amountDueMinor: amount, availableMethods: methods, context, now }));
  const tenantDecision = (action: 'require_deposit' | 'require_full_payment' | 'manual_approval' | 'default', extra: Record<string, unknown> = {}) =>
    withTenant(biz.tenantId, (trx) => createDecision(trx, { scope: 'tenant', tenantId: biz.tenantId, tenantCustomerId: tcId, action, reason: 'test decision', reviewerId: ownerId, actor: sys, ...extra }));
  const platformDecision = (action: 'require_deposit' | 'require_full_payment' | 'manual_approval' | 'suspend_account', extra: Record<string, unknown> = {}) =>
    withSystem('test', (trx) => createDecision(trx, { scope: 'platform', tenantId: null, customerUserId: cu.id, action, reason: 'platform test decision (internal)', customerExplanationEn: 'LUMA explanation', reviewerId: ownerId, actor: sys, ...extra }));
  return { biz, tcId, cu, terms, tenantDecision, platformDecision, ownerId };
}

describe('deposit arithmetic', () => {
  it('rounds half up in integer halalas and never exceeds the amount due', () => {
    expect(depositFor(10001, { deposit_mode: 'percent', deposit_percent_bp: 2500, deposit_fixed_minor: 0 })).toBe(2500); // 2500.25 → 2500
    expect(depositFor(10002, { deposit_mode: 'percent', deposit_percent_bp: 2500, deposit_fixed_minor: 0 })).toBe(2501); // 2500.5 → 2501
    expect(depositFor(5000, { deposit_mode: 'fixed', deposit_percent_bp: 0, deposit_fixed_minor: 9000 })).toBe(5000);
    expect(depositFor(5000, { deposit_mode: 'percent', deposit_percent_bp: 0, deposit_fixed_minor: 0 })).toBe(0);
    expect(depositFor(5000, { deposit_mode: 'none', deposit_percent_bp: 5000, deposit_fixed_minor: 100 })).toBe(0);
  });
});

describe('computePaymentTerms', () => {
  it('default terms offer full, deposit and on-site when the business allows them', async () => {
    const s = await setup({ deposit_mode: 'percent', deposit_percent_bp: 2000 });
    const t = await s.terms(15000);
    // A business deposit policy removes "pay everything on site".
    expect(t.allowed).toEqual(['full', 'deposit']);
    expect(t.depositMinor).toBe(3000);
    expect(t.blocked).toBe(false);
    expect(new Date(t.validUntil).getTime() - new Date(t.computedAt).getTime()).toBe(600_000);
    const noDeposit = await setup();
    expect((await noDeposit.terms(15000)).allowed).toEqual(['full', 'on_site']);
  });

  it('require_full_payment excludes deposit and on-site', async () => {
    const s = await setup({ deposit_mode: 'percent', deposit_percent_bp: 2000 });
    const d = await s.tenantDecision('require_full_payment');
    const t = await s.terms(15000);
    expect(t.allowed).toEqual(['full']);
    expect(t.depositMinor).toBeNull();
    expect(t.decisionIds).toContain(d.id);
    expect(t.reasonCodes).toContain('restriction:full_payment_required');
    expect(t.customerExplanation?.en).toMatch(/Full prepayment/);
    expect(() => requireAllowedOption(t, 'on_site')).toThrow();
  });

  it('a fixed deposit larger than the amount collapses into full payment; deposit 0 means no deposit', async () => {
    const s = await setup({ deposit_mode: 'fixed', deposit_fixed_minor: 50000 });
    const t = await s.terms(20000);
    expect(t.allowed).toEqual(['full']);
    expect(t.depositMinor).toBeNull();
    const z = await setup({ deposit_mode: 'percent', deposit_percent_bp: 0 });
    const tz = await z.terms(20000);
    expect(tz.allowed).toEqual(['full', 'on_site']);
    expect(tz.depositMinor).toBeNull();
  });

  it('no compatible method → blocked with a contact path (restriction never weakened)', async () => {
    const s = await setup();
    await s.tenantDecision('require_full_payment');
    const t = await s.terms(15000, ['cash']);
    expect(t.blocked).toBe(true);
    expect(t.allowed).toEqual([]);
    expect(t.reasonCodes).toContain('no_compatible_method');
    expect(t.policySnapshot.contact_path).toBe('contact_business');
    expect(t.customerExplanation?.en).toMatch(/contact the business/);
    expect(() => requireAllowedOption(t, 'full')).toThrow();
  });

  it('require_deposit without a configured deposit is strengthened to full prepayment', async () => {
    const s = await setup();
    await s.tenantDecision('require_deposit');
    const t = await s.terms(15000);
    expect(t.allowed).toEqual(['full']);
    expect(t.reasonCodes).toContain('deposit_unavailable_full_required');
  });

  it('ignores expired and superseded decisions', async () => {
    const s = await setup({ deposit_mode: 'percent', deposit_percent_bp: 2000 });
    const old = await s.tenantDecision('require_full_payment', { effectiveAt: new Date(Date.now() - 3 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000) });
    let t = await s.terms(15000);
    expect(t.decisionIds).not.toContain(old.id);
    expect(t.allowed).toEqual(['full', 'deposit']);
    // Supersession: a correction replaces the stricter decision.
    const strict = await s.tenantDecision('require_full_payment');
    const corrected = await s.tenantDecision('require_deposit', { supersedesId: strict.id });
    t = await s.terms(15000);
    expect(t.decisionIds).toEqual([corrected.id]);
    expect(t.allowed).toEqual(['full', 'deposit']);
    const prev = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('policy_decisions').select('status').where('id', '=', strict.id).executeTakeFirstOrThrow());
    expect(prev.status).toBe('superseded');
  });

  it('strictest across tenant + platform wins; manual approval is additive', async () => {
    const s = await setup({ deposit_mode: 'percent', deposit_percent_bp: 2000 });
    await s.tenantDecision('require_deposit');
    await s.tenantDecision('manual_approval');
    const p = await s.platformDecision('require_full_payment');
    const t = await s.terms(15000);
    expect(t.allowed).toEqual(['full']);
    expect(t.requiresManualApproval).toBe(true);
    expect(t.decisionIds).toContain(p.id);
    expect(t.policySnapshot.effective_action).toBe('require_full_payment');
    expect(t.customerExplanation?.en).toContain('LUMA explanation');
  });

  it('suspend_account blocks payment entirely', async () => {
    const s = await setup();
    await s.platformDecision('suspend_account');
    const t = await s.terms(15000);
    expect(t.blocked).toBe(true);
    expect(t.reasonCodes).toContain('account_suspended');
  });

  it('a tenant sees a platform decision only as an action: no reason or evidence is readable', async () => {
    const s = await setup();
    const p = await s.platformDecision('require_full_payment', { evidenceRefs: [{ type: 'note', note: 'secret note' }] });
    const t = await s.terms(15000);
    expect(JSON.stringify(t)).not.toContain('platform test decision (internal)');
    expect(JSON.stringify(t)).not.toContain('secret note');
    expect(t.policySnapshot.decisions).toEqual([{ id: p.id, scope: 'platform', action: 'require_full_payment' }]);
    // Direct table access from the tenant scope cannot see platform rows (RLS).
    const rows = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('policy_decisions').select(['id', 'reason']).where('id', '=', p.id).execute());
    expect(rows).toHaveLength(0);
    const fn = await withTenant(s.biz.tenantId, (trx) => sql<Record<string, unknown>>`select * from app.platform_decisions_for_customer(${s.cu.id})`.execute(trx));
    expect(Object.keys(fn.rows[0]!)).not.toContain('reason');
    expect(Object.keys(fn.rows[0]!)).not.toContain('evidence_refs');
  });

  it('orders never take deposits; zero amount needs no payment', async () => {
    const s = await setup({ deposit_mode: 'percent', deposit_percent_bp: 2000 });
    const t = await s.terms(15000, ALL, 'order');
    expect(t.allowed).toEqual(['full', 'on_site']);
    const z = await s.terms(0, []);
    expect(z.blocked).toBe(false);
    expect(z.allowed).toEqual(['full']);
  });

  it('reassessment reports material changes when policy changes during a hold', async () => {
    const s = await setup({ deposit_mode: 'percent', deposit_percent_bp: 2000 });
    const input = { tenantId: s.biz.tenantId, tenantCustomerId: s.tcId, customerUserId: null, amountDueMinor: 15000, availableMethods: ALL, context: 'booking' as const };
    const first = await s.terms(15000);
    const same = await withTenant(s.biz.tenantId, (trx) => reassessPaymentTerms(trx, first, input));
    expect(same.changed).toBe(false);
    await s.tenantDecision('require_full_payment');
    const after = await withTenant(s.biz.tenantId, (trx) => reassessPaymentTerms(trx, first, input));
    expect(after.changed).toBe(true);
    expect(after.changes).toEqual(expect.arrayContaining(['allowed', 'deposit']));
    const later = await withTenant(s.biz.tenantId, (trx) => reassessPaymentTerms(trx, first, { ...input, now: new Date(Date.now() + 3_600_000) }));
    expect(later.expired).toBe(true);
  });
});
