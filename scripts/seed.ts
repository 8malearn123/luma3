/**
 * Demo seed (development/review only). Creates clearly fictional data:
 *  - LUMA platform owner, Noura Salon (multi-staff, multi-specialty), a second
 *    business with a different identity, team roles, customers (ordinary, one
 *    with an explicitly EXPERIMENTAL require_full_payment decision, one new),
 *    several weeks of historical bookings with consistent payments, expenses
 *    with deliberately missing costs.
 * Every demo user gets a unique random password written to .demo-credentials.txt
 * (gitignored). Refuses to run in production. Safe to re-run: it skips if the
 * demo owner already exists unless --force-new-slugs is passed.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadDotEnv } from './load-env';

loadDotEnv();
if (process.env.APP_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

const { DateTime } = await import('luxon');
const { sql } = await import('kysely');
const { db, withCentral, withSystem, withTenant, closeDb } = await import('../src/server/db/client');
await import('../src/server/boot');
const { hashPassword } = await import('../src/server/auth/crypto');
const { resolveSession, createSession } = await import('../src/server/auth/service');
const { createBusiness } = await import('../src/server/domains/tenants/service');
const { resolveTenantAccess } = await import('../src/server/tenancy/access');
const { createService, createCategory } = await import('../src/server/domains/catalog/service');
const { createStaff } = await import('../src/server/domains/team/service');
const { setWeeklyHours } = await import('../src/server/domains/schedule/service');
const { saveStep, generateDraft } = await import('../src/server/domains/onboarding/service');
const { connectSandbox } = await import('../src/server/domains/payments/service');
const { recordExpense, createCommissionRule } = await import('../src/server/domains/finance/service');
const { recognizeBookingRevenue, recognizeRetainedOnClose, earnCommissions } = await import('../src/server/domains/finance/postings');
const { post } = await import('../src/server/domains/finance/journal');
const { ensureTenantCustomerForUser } = await import('../src/server/domains/customers/relationship');
const { nextReadableNumber } = await import('../src/server/infra/counters');
const { createProduct } = await import('../src/server/domains/commerce/products');
const { seedIncident, seedAppeal } = await import('../src/server/domains/policy/seed');
const { publish } = await import('../src/server/domains/builder/publish');
const { createExamplePlan } = await import('../src/server/domains/marketing/plans');

const credentials: string[] = ['# LUMA demo credentials (development only — fictional people)', ''];
const credentialMap: Record<string, string> = {};
const actorSystem = { userId: null, kind: 'system' as const };

async function demoUser(email: string, name: string, opts: { phone?: string } = {}) {
  const password = randomBytes(9).toString('base64url');
  const hash = await hashPassword(password);
  const existing = await db().selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
  if (existing) return existing.id;
  const u = await withCentral(async (trx) => {
    const row = await trx.insertInto('users').values({
      email, phone: opts.phone ?? null, password_hash: hash, display_name: name, locale: 'ar', email_verified_at: new Date(), is_demo: true,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('customer_profiles').values({ user_id: row.id }).execute();
    return row.id;
  });
  credentials.push(`${name.padEnd(28)} ${email.padEnd(34)} ${password}`);
  credentialMap[email] = password;
  return u;
}

async function sessionFor(userId: string) {
  const s = await createSession(userId, null, 'seed');
  return (await resolveSession(s.token))!;
}

async function main() {
  const already = await db().selectFrom('users').select('id').where('email', '=', 'owner@noura.demo').executeTakeFirst();
  if (already && !process.argv.includes('--again')) {
    console.log('Demo data already present (owner@noura.demo). Use `pnpm db:reset-dev` for a clean dev database, or pass --again.');
    return;
  }

  // ── People ────────────────────────────────────────────────────────────────
  const platformOwner = await demoUser('admin@luma.demo', 'مالكة منصة لوما', { phone: '+966500000010' });
  await withSystem('seed platform role', (trx) => trx.insertInto('platform_roles').values({ user_id: platformOwner, role: 'platform_owner' }).onConflict((oc) => oc.doNothing()).execute());
  const policyReviewer = await demoUser('reviewer@luma.demo', 'مراجِعة السياسات', { phone: '+966500000011' });
  await withSystem('seed platform role', (trx) => trx.insertInto('platform_roles').values({ user_id: policyReviewer, role: 'policy_reviewer' }).onConflict((oc) => oc.doNothing()).execute());

  const ownerId = await demoUser('owner@noura.demo', 'نورة (مالكة الصالون)');
  const managerId = await demoUser('manager@noura.demo', 'ريم (مديرة)');
  const receptionId = await demoUser('reception@noura.demo', 'جود (استقبال)');
  const specialistId = await demoUser('sara@noura.demo', 'سارة (أخصائية شعر)');
  const financeId = await demoUser('finance@noura.demo', 'منى (مالية)');
  const expertId = await demoUser('lamar@lamar.demo', 'لمار (خبيرة مكياج)');
  const customerA = await demoUser('customer@demo.test', 'عميلة عادية — هيا', { phone: '+966500000001' });
  const customerFull = await demoUser('restricted@demo.test', 'عميلة بقرار تجريبي — دانة', { phone: '+966500000002' });
  const customerNew = await demoUser('new@demo.test', 'عميلة جديدة — لين');

  // ── Noura Salon ───────────────────────────────────────────────────────────
  const owner = await sessionFor(ownerId);
  const noura = await createBusiness(owner, { name: 'صالون نورة', slug: 'noura-salon', business_type: 'salon', city: 'الرياض', branch_name: 'فرع العليا', plan_code: 'wahaj' }, { userId: ownerId, kind: 'user' });
  const access = await resolveTenantAccess(owner, 'noura-salon');
  const actor = { userId: ownerId, kind: 'user' as const };

  let ob = await withTenant(noura.tenantId, (trx) => trx.selectFrom('onboarding_progress').select('version').executeTakeFirstOrThrow());
  for (const [step, answers] of [
    [3, { traits: ['elegant', 'warm'], reference_style: 'classic_luxury', description: 'صالون نسائي هادئ بلمسة فاخرة' }],
    [4, { existing_colors: ['#7A4E5B'], excluded_colors: ['#00FF00'] }],
    [6, { priorities: ['booking', 'portfolio', 'team', 'offers', 'reviews', 'products'] }],
    [7, { tagline: 'جمالك بلمسة نورة', intro: 'نقدم خدمات الشعر والأظافر والمكياج بأيدي خبيرات معتمدات في بيئة مريحة.', phone: '0550000000', whatsapp: '0550000000', email: 'hello@noura.demo', address: 'الرياض، حي العليا (عنوان تجريبي)', latitude: 24.6911, longitude: 46.6857, hours: [0, 1, 2, 3, 4, 6].map((d) => ({ weekday: d, opens: '10:00', closes: '22:00' })), social: { instagram: 'noura.demo' } }],
  ] as const) {
    const r = await saveStep(access, actor, step, answers, ob.version);
    ob = { version: r.version };
  }
  await generateDraft(access, actor);

  const cat = async (slug: string, ar: string, en: string) => (await createCategory(access, actor, { kind: 'service', name_ar: ar, name_en: en, slug })).id;
  const hair = await cat('hair', 'الشعر', 'Hair');
  const nails = await cat('nails', 'الأظافر', 'Nails');
  const makeup = await cat('makeup', 'المكياج', 'Makeup');

  const staff = async (name: string, en: string, title: string) => (await createStaff(access, actor, { display_name: name, display_name_en: en, title_ar: title, is_public: true })).id;
  const sara = await staff('سارة', 'Sara', 'أخصائية شعر');
  const huda = await staff('هدى', 'Huda', 'أخصائية أظافر');
  const maha = await staff('مها', 'Maha', 'خبيرة مكياج');
  const week = (days: number[], from: string, to: string) => days.map((d) => ({ weekday: d, start_time: from, end_time: to }));
  await setWeeklyHours(access, actor, sara, { branch_id: noura.branchId, ranges: week([0, 1, 2, 3, 4, 6], '10:00', '18:00'), breaks: week([0, 1, 2, 3, 4, 6], '14:00', '14:30').map((b) => ({ ...b })) });
  await setWeeklyHours(access, actor, huda, { branch_id: noura.branchId, ranges: week([0, 1, 2, 3, 4], '12:00', '21:00'), breaks: [] });
  await setWeeklyHours(access, actor, maha, { branch_id: noura.branchId, ranges: week([3, 4, 6], '14:00', '22:00'), breaks: [] });

  const svc = async (b: Parameters<typeof createService>[2]) => (await createService(access, actor, b)).id;
  const cut = await svc({ name_ar: 'قص وتصفيف', name_en: 'Cut & style', category_id: hair, price_minor: 15000, duration_min: 60, buffer_after_min: 10, cost_minor: 2000, staff: [{ staff_id: sara }], price_display: 'fixed', is_active: true, is_visible: true, bookable_internally_when_hidden: true, booking_mode: 'individual', requires_manual_approval: false, buffer_before_min: 0 });
  const color = await svc({ name_ar: 'صبغة كاملة', name_en: 'Full colour', category_id: hair, price_minor: 45000, price_display: 'starting_from', duration_min: 120, buffer_after_min: 15, staff: [{ staff_id: sara }], is_active: true, is_visible: true, bookable_internally_when_hidden: true, booking_mode: 'individual', requires_manual_approval: false, buffer_before_min: 0 }); // cost intentionally missing
  const mani = await svc({ name_ar: 'مانيكير', name_en: 'Manicure', category_id: nails, price_minor: 9000, duration_min: 45, staff: [{ staff_id: huda }], price_display: 'fixed', is_active: true, is_visible: true, bookable_internally_when_hidden: true, booking_mode: 'individual', requires_manual_approval: false, buffer_before_min: 0, buffer_after_min: 0 });
  const pedi = await svc({ name_ar: 'باديكير', name_en: 'Pedicure', category_id: nails, price_minor: 11000, duration_min: 60, staff: [{ staff_id: huda }], price_display: 'fixed', is_active: true, is_visible: true, bookable_internally_when_hidden: true, booking_mode: 'individual', requires_manual_approval: false, buffer_before_min: 0, buffer_after_min: 0 });
  const bridal = await svc({ name_ar: 'مكياج عروس', name_en: 'Bridal makeup', category_id: makeup, price_minor: 120000, duration_min: 150, staff: [{ staff_id: maha }], requires_manual_approval: true, price_display: 'starting_from', is_active: true, is_visible: true, bookable_internally_when_hidden: true, booking_mode: 'individual', buffer_before_min: 15, buffer_after_min: 15 });
  const evening = await svc({ name_ar: 'مكياج سهرة', name_en: 'Evening makeup', category_id: makeup, price_minor: 35000, duration_min: 75, staff: [{ staff_id: maha }, { staff_id: sara, price_override_minor: 30000 }], price_display: 'fixed', is_active: true, is_visible: true, bookable_internally_when_hidden: true, booking_mode: 'individual', requires_manual_approval: false, buffer_before_min: 0, buffer_after_min: 0 });

  await connectSandbox(access, actor);
  await createCommissionRule(access, actor, { kind: 'percent', rate_bp: 1000 }); // TEST VALUE: 10% default
  await withSystem('seed settings', async (trx) => {
    await trx.updateTable('tenant_settings').set({
      deposit_mode: 'percent', deposit_percent_bp: 2000, allow_pay_on_site: true, free_cancellation_hours: 24, late_cancellation_fee_bp: 5000,
      booking_policy_text_ar: 'يمكن الإلغاء مجاناً قبل ٢٤ ساعة من الموعد. بعد ذلك تُحتسب رسوم ٥٠٪ من قيمة الحجز. (نص تجريبي)',
      booking_policy_confirmed_at: new Date(), legal_name: 'مؤسسة صالون نورة (اسم تجريبي)', tax_rate_bp: 1500, prices_include_tax: true, tax_label: 'ضريبة القيمة المضافة (إعداد تجريبي)',
      notify_channels: ['in_app', 'sms', 'email'],
    }).where('tenant_id', '=', noura.tenantId).execute();
    await trx.updateTable('tenants').set({ status: 'active' }).where('id', '=', noura.tenantId).execute();
  });

  // Team memberships (invitations would normally be used; the seed is a trusted bootstrap).
  await withTenant(noura.tenantId, async (trx) => {
    await trx.insertInto('tenant_memberships').values([
      { tenant_id: noura.tenantId, user_id: managerId, role: 'manager', granted_capabilities: ['catalog.edit', 'builder.edit'], created_by: ownerId },
      { tenant_id: noura.tenantId, user_id: receptionId, role: 'receptionist', created_by: ownerId },
      { tenant_id: noura.tenantId, user_id: specialistId, role: 'specialist', staff_profile_id: sara, created_by: ownerId },
      { tenant_id: noura.tenantId, user_id: financeId, role: 'finance', created_by: ownerId },
    ]).execute();
  });

  // ── History: several weeks of completed / cancelled / no-show bookings ────
  const customers = await withTenant(noura.tenantId, async (trx) => {
    const ids: string[] = [];
    for (const u of [customerA, customerFull]) {
      const user = await db().selectFrom('users').select(['id', 'display_name', 'phone', 'email']).where('id', '=', u).executeTakeFirstOrThrow();
      ids.push(await ensureTenantCustomerForUser(trx, noura.tenantId, { userId: user.id, displayName: user.display_name, phone: user.phone, email: user.email }));
    }
    for (let i = 1; i <= 10; i++) {
      const r = await trx.insertInto('tenant_customers').values({ tenant_id: noura.tenantId, display_name: `عميلة حضورية ${i}`, phone: `+9665100000${String(i).padStart(2, '0')}`, source: 'walk_in' }).returning('id').executeTakeFirstOrThrow();
      ids.push(r.id);
    }
    return ids;
  });
  const catalog = [{ id: cut, price: 15000, dur: 60, staff: sara, name: 'قص وتصفيف' }, { id: color, price: 45000, dur: 120, staff: sara, name: 'صبغة كاملة' }, { id: mani, price: 9000, dur: 45, staff: huda, name: 'مانيكير' }, { id: pedi, price: 11000, dur: 60, staff: huda, name: 'باديكير' }, { id: evening, price: 35000, dur: 75, staff: maha, name: 'مكياج سهرة' }];
  const tz = 'Asia/Riyadh';
  let n = 0;
  for (let daysAgo = 42; daysAgo >= 1; daysAgo--) {
    const day = DateTime.now().setZone(tz).minus({ days: daysAgo }).startOf('day');
    if (day.weekday === 5) continue; // Friday off
    const perDay = 2 + (daysAgo % 3);
    for (let k = 0; k < perDay; k++) {
      const c = catalog[(daysAgo + k) % catalog.length]!;
      const hour = c.staff === maha ? 15 + k : c.staff === huda ? 12 + k * 2 : 10 + k * 2;
      const start = day.plus({ hours: hour }).toJSDate();
      const end = new Date(start.getTime() + c.dur * 60_000);
      const outcome = (daysAgo + k) % 11 === 0 ? 'no_show' : (daysAgo + k) % 7 === 0 ? 'cancelled' : 'completed';
      const customer = customers[(daysAgo * 3 + k) % customers.length]!;
      await withTenant(noura.tenantId, async (trx) => {
        const number = await nextReadableNumber(trx, noura.tenantId, 'booking');
        const tax = Math.round((c.price * 1500) / 11500);
        const b = await trx.insertInto('bookings').values({
          tenant_id: noura.tenantId, branch_id: noura.branchId, number, tenant_customer_id: customer, customer_user_id: customer === customers[0] ? customerA : customer === customers[1] ? customerFull : null,
          status: outcome, source: 'dashboard', starts_at: start, ends_at: end, timezone: tz, subtotal_minor: c.price, tax_minor: tax, total_minor: c.price,
          paid_minor: outcome === 'completed' ? c.price : 0, payment_status: outcome === 'completed' ? 'paid' : 'unpaid',
          policy_snapshot: JSON.stringify({ free_cancellation_hours: 24, late_cancellation_fee_bp: 5000, no_show_grace_min: 15, tax_rate_bp: 1500, prices_include_tax: true }),
          payment_terms: JSON.stringify({ allowed: ['on_site'], seed: true }), cancelled_at: outcome === 'cancelled' ? start : null, cancel_source: outcome === 'cancelled' ? 'customer' : null, cancel_reason: outcome === 'cancelled' ? 'ظرف طارئ (تجريبي)' : null,
        }).returning('id').executeTakeFirstOrThrow();
        const item = await trx.insertInto('booking_items').values({
          tenant_id: noura.tenantId, booking_id: b.id, sequence: 0, service_id: c.id, staff_id: c.staff, starts_at: start, ends_at: end, service_name_ar: c.name, staff_name: '—',
          duration_min: c.dur, unit_price_minor: c.price, line_total_minor: c.price,
          actual_started_at: outcome === 'completed' ? new Date(start.getTime() + ((daysAgo % 4) * 3) * 60_000) : null,
          actual_ended_at: outcome === 'completed' ? new Date(end.getTime() + ((daysAgo % 5) - 2) * 60_000) : null,
        }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('booking_allocations').values({ tenant_id: noura.tenantId, booking_id: b.id, booking_item_id: item.id, staff_id: c.staff, during: `[${start.toISOString()},${end.toISOString()})`, state: outcome === 'completed' ? 'confirmed' : 'released' }).execute();
        await trx.insertInto('booking_events').values({ tenant_id: noura.tenantId, booking_id: b.id, to_status: outcome, source: 'seed', reason: 'historical demo data' }).execute();
        if (outcome === 'completed') {
          const p = await trx.insertInto('payments').values({ tenant_id: noura.tenantId, purpose: 'booking', booking_id: b.id, kind: 'on_site', method: (n % 2 ? 'cash' : 'pos_terminal'), amount_minor: c.price, currency: 'SAR', status: 'captured', provider: 'on_site', idempotency_key: `seed:${b.id}`, collected_by: receptionId, cash_reference: `SEED-${number}`, captured_at: end }).returning(['id', 'method']).executeTakeFirstOrThrow();
          await post(trx, noura.tenantId, { type: 'payment', id: p.id }, [{ account: p.method === 'cash' ? 'cash_on_hand' : 'provider_clearing', debit: c.price }, { account: 'customer_deposits', credit: c.price }], { occurredAt: end });
          await recognizeBookingRevenue(trx, noura.tenantId, b.id, null);
          await earnCommissions(trx, noura.tenantId, b.id, null);
        } else {
          await recognizeRetainedOnClose(trx, noura.tenantId, b.id);
        }
        await trx.updateTable('booking_items').set({ staff_name: (await trx.selectFrom('staff_profiles').select('display_name').where('id', '=', c.staff).executeTakeFirstOrThrow()).display_name }).where('id', '=', item.id).execute();
      });
      n++;
    }
  }
  await withTenant(noura.tenantId, (trx) => sql`update tenant_customers c set last_visit_at = x.last, first_visit_at = x.first from (select tenant_customer_id, max(starts_at) last, min(starts_at) first from bookings where status = 'completed' group by 1) x where x.tenant_customer_id = c.id`.execute(trx));

  // Expenses (one category deliberately without receipts; product/material costs missing elsewhere → "costs incomplete").
  for (const [cat2, amount, ago] of [['rent', 1200000, 30], ['supplies', 85000, 20], ['utilities', 60000, 15], ['marketing', 40000, 7]] as const) {
    await recordExpense(access, actor, { category: cat2, amount_minor: amount, incurred_on: DateTime.now().setZone(tz).minus({ days: ago }).toISODate()!, description: 'مصروف تجريبي' });
  }

  // Explicitly EXPERIMENTAL tenant-scope decision for one customer.
  await withTenant(noura.tenantId, (trx) => trx.insertInto('policy_decisions').values({
    scope: 'tenant', tenant_id: noura.tenantId, customer_user_id: customerFull, tenant_customer_id: customers[1]!, action: 'require_full_payment',
    reason: 'بيانات تجريبية: قرار تجريبي لاختبار شرط الدفع الكامل بعد حالتي عدم حضور مسجلتين.',
    customer_explanation_ar: 'يتطلب الحجز لدى هذا الصالون الدفع الكامل مسبقاً. يمكنكِ تقديم تظلم من حسابك.',
    customer_explanation_en: 'Bookings at this salon require full prepayment. You can appeal from your account.',
    reviewer_id: ownerId, is_experimental: true, review_at: new Date(Date.now() + 30 * 86_400_000), expires_at: new Date(Date.now() + 90 * 86_400_000),
  }).returning('id').executeTakeFirstOrThrow()).then(async (decision) => {
    // An appeal from that customer, and an incident still under review.
    await withSystem('seed appeal', (trx) => seedAppeal(trx, { customerUserId: customerFull, decisionId: decision.id, message: 'كان لدي ظرف طارئ في أحد المواعيد، أرجو مراجعة القرار.' }));
    const noShow = await withTenant(noura.tenantId, (trx) => trx.selectFrom('bookings').select('id').where('status', '=', 'no_show').where('tenant_customer_id', '=', customers[1]!).executeTakeFirst());
    await withTenant(noura.tenantId, (trx) => seedIncident(trx, { tenantId: noura.tenantId, tenantCustomerId: customers[1]!, bookingId: noShow?.id ?? null, type: 'no_show', status: 'under_review', submittedBy: receptionId, reviewerId: ownerId, description: 'بيانات تجريبية: لم تحضر العميلة للموعد ولم تعتذر.' }));
  });

  // Reviews from verified completed visits (the DB trigger rejects anything else).
  await withTenant(noura.tenantId, async (trx) => {
    const visits = await trx.selectFrom('bookings as b').innerJoin('booking_items as i', 'i.booking_id', 'b.id')
      .select(['b.id', 'b.tenant_customer_id', 'b.customer_user_id', 'i.staff_id']).where('b.status', '=', 'completed').where('b.customer_user_id', 'is not', null)
      .orderBy('b.starts_at', 'desc').limit(3).execute();
    const texts = ['تجربة رائعة وتعامل راقٍ، والنتيجة أجمل مما توقعت.', 'المكان نظيف والموعد كان في وقته تماماً.', 'خدمة ممتازة، سأعود بالتأكيد.'];
    for (const [i, v] of visits.entries()) {
      await trx.insertInto('reviews').values({ tenant_id: noura.tenantId, booking_id: v.id, tenant_customer_id: v.tenant_customer_id!, customer_user_id: v.customer_user_id, staff_id: v.staff_id, rating: i === 1 ? 4 : 5, comment: texts[i], status: 'published' }).execute();
    }
  });

  // Retail products (one deliberately without cost → "costs incomplete"; one low on stock).
  for (const pr of [
    { name_ar: 'شامبو مرطب', name_en: 'Hydrating shampoo', variants: [{ name_ar: '250 مل', name_en: '250 ml', price_minor: 6500, cost_minor: 3000, initial_stock: 24, sku: 'SH-250' }, { name_ar: '500 مل', name_en: '500 ml', price_minor: 11000, cost_minor: 5200, initial_stock: 10, sku: 'SH-500' }] },
    { name_ar: 'زيت أرغان للشعر', name_en: 'Argan hair oil', variants: [{ price_minor: 9000, initial_stock: 3, sku: 'OIL-ARG' }] },
    { name_ar: 'مبرد أظافر', name_en: 'Nail file', variants: [{ price_minor: 1500, cost_minor: 400, initial_stock: 60, sku: 'NF-01' }] },
  ]) await createProduct(access, actor, { status: 'active', is_visible: true, ...pr });

  // A labelled example marketing plan (rules-based; no AI provider is connected in the demo).
  try { await createExamplePlan(access, actor, 'monthly'); } catch (e) { console.warn(`[seed] example plan skipped: ${(e as Error).message}`); }

  // Publish the generated storefront if the readiness checklist passes; otherwise say why.
  try { await publish(access, actor, `seed-publish-${noura.tenantId}`, { note: 'Seed: first publication (demo)' }); }
  catch (e) { console.warn(`[seed] noura-salon not published: ${(e as Error).message} ${JSON.stringify((e as { details?: unknown }).details ?? '')}`); }

  // ── Second business: an independent expert with a different identity ─────
  const expert = await sessionFor(expertId);
  const lamar = await createBusiness(expert, { name: 'لمار للمكياج', slug: 'lamar-makeup', business_type: 'expert', city: 'جدة', plan_code: 'sanaa' }, { userId: expertId, kind: 'user' });
  const lamarAccess = await resolveTenantAccess(expert, 'lamar-makeup');
  const la = { userId: expertId, kind: 'user' as const };
  let ob2 = await withTenant(lamar.tenantId, (trx) => trx.selectFrom('onboarding_progress').select('version').executeTakeFirstOrThrow());
  for (const [step, answers] of [[3, { traits: ['modern', 'bold'], reference_style: 'modern_bold' }], [7, { tagline: 'مكياج يشبهك', phone: '0560000000', hours: [0, 1, 2, 3, 4, 6].map((d) => ({ weekday: d, opens: '12:00', closes: '23:00' })) }]] as const) {
    const r = await saveStep(lamarAccess, la, step, answers, ob2.version);
    ob2 = { version: r.version };
  }
  await generateDraft(lamarAccess, la);
  const lamarStaff = lamar.staffProfileId!;
  await setWeeklyHours(lamarAccess, la, lamarStaff, { branch_id: lamar.branchId, ranges: week([0, 1, 2, 3, 4, 6], '12:00', '22:00'), breaks: [] });
  await createService(lamarAccess, la, { name_ar: 'مكياج ناعم', name_en: 'Soft glam', price_minor: 40000, duration_min: 90, staff: [{ staff_id: lamarStaff }], price_display: 'fixed', is_active: true, is_visible: true, bookable_internally_when_hidden: true, booking_mode: 'individual', requires_manual_approval: false, buffer_before_min: 0, buffer_after_min: 15 });
  await connectSandbox(lamarAccess, la);
  await withSystem('seed lamar', async (trx) => {
    await trx.updateTable('tenant_settings').set({ booking_policy_confirmed_at: new Date(), allow_pay_on_site: false, deposit_mode: 'fixed', deposit_fixed_minor: 10000 }).where('tenant_id', '=', lamar.tenantId).execute();
    await trx.updateTable('tenants').set({ status: 'active' }).where('id', '=', lamar.tenantId).execute();
  });
  try { await publish(lamarAccess, la, `seed-publish-${lamar.tenantId}`, { note: 'Seed: first publication (demo)' }); }
  catch (e) { console.warn(`[seed] lamar-makeup not published: ${(e as Error).message} ${JSON.stringify((e as { details?: unknown }).details ?? '')}`); }
  // The ordinary customer also has a relationship with Lamar (isolation demo).
  await withTenant(lamar.tenantId, async (trx) => {
    const user = await db().selectFrom('users').select(['id', 'display_name', 'phone', 'email']).where('id', '=', customerA).executeTakeFirstOrThrow();
    await ensureTenantCustomerForUser(trx, lamar.tenantId, { userId: user.id, displayName: user.display_name, phone: user.phone, email: user.email });
  });

  void actorSystem; void customerNew; void bridal; void platformOwner;
  const dbName = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  // E2E runs read credentials from a JSON file outside the repo root text file.
  const credFile = process.env.SEED_CREDENTIALS_JSON;
  if (credFile) writeFileSync(credFile, JSON.stringify(credentialMap), { mode: 0o600 });
  else writeFileSync('.demo-credentials.txt', [`# Demo accounts for database "${dbName}" (seeded ${new Date().toISOString()}). Development only.`, ...credentials].join('\n') + '\n', { mode: 0o600 });
  console.log(`Seeded: ${n} historical bookings, businesses noura-salon & lamar-makeup.`);
  console.log(`Demo credentials written to ${credFile ?? '.demo-credentials.txt'} (gitignored).`);
}

await main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closeDb());
