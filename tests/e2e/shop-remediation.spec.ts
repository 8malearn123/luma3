import { existsSync, mkdirSync } from 'node:fs';
import pg from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { e2eEnv } from '../../playwright.config';
import { creds, failOnPageErrors, signIn } from './helpers';

/**
 * Remediation journeys (shop workstream): payment failure feedback (015),
 * session expiry mid-booking (016), variants/add-ons online (018), payment
 * paths for orders (006 / R2), multi-specialist bookings and customer payment
 * restrictions through checkout. Data tweaks go straight to the disposable
 * E2E database and are undone after each test.
 */
// Containers without Playwright's pinned browser build: PW_CHROMIUM, or the preinstalled /opt/pw-browsers/chromium.
const chromium = process.env.PW_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
test.use({ ...(chromium ? { launchOptions: { executablePath: chromium } } : {}), viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });

const EVIDENCE = 'docs/remediation/evidence/shop';
mkdirSync(EVIDENCE, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage: false });

async function db<T extends pg.QueryResultRow = Record<string, unknown>>(q: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: e2eEnv.DATABASE_OWNER_URL });
  await c.connect();
  try { return (await c.query<T>(q, params)).rows; } finally { await c.end(); }
}
const tenantId = async (slug: string) => (await db<{ id: string }>('select id from tenants where slug = $1', [slug]))[0]!.id;
const userId = async (email: string) => (await db<{ id: string }>('select id from users where email = $1', [email]))[0]!.id;

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
});

const timeButton = (page: Page) => page.getByRole('button', { name: /^\d{1,2}:\d{2}\s?(AM|PM)$/ }).first();
/** The n-th bookable day tab from the end (separate tests use separate days so their holds never collide). */
const dayFromEnd = (page: Page, n: number) => page.locator('[role="tab"]:not([disabled])').nth(-1 - n);

async function startBooking(page: Page, service: RegExp, dayIndexFromEnd: number, slot = 0) {
  await page.getByRole('button', { name: service }).first().click();
  await timeButton(page).waitFor(); // the week's search has finished: day tabs are settled
  // A negative index keeps the day chosen automatically (the first day with times).
  if (dayIndexFromEnd >= 0) await dayFromEnd(page, dayIndexFromEnd).click();
  else if (dayIndexFromEnd < -1) await page.locator('[role="tab"]:not([disabled])').nth(-dayIndexFromEnd - 1).click(); // -2 → 2nd bookable day
  await timeButton(page).waitFor();
  await page.getByRole('button', { name: /^\d{1,2}:\d{2}\s?(AM|PM)$/ }).nth(slot).click();
}

// ── 015: explicit payment failure feedback ────────────────────────────────────
test('booking checkout: a failed sandbox payment shows an alert and lets her choose again', async ({ page }) => {
  const done = failOnPageErrors(page);
  await signIn(page, 'customer@demo.test', '/s/noura-salon/booking');
  await page.waitForURL(/\/s\/noura-salon\/booking/);
  await startBooking(page, /Cut & style/, 1);
  await page.getByRole('button', { name: /Reserve this time/ }).click();
  await page.waitForURL(/\/checkout\/booking\//);
  await page.getByLabel('Pay the full amount now').check();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForURL(/\/sandbox\/checkout\//);
  await page.getByRole('button', { name: 'Simulate failed payment' }).click();
  await page.waitForURL(/\/checkout\/booking\/.*payment=/);
  const alert = page.getByRole('alert').filter({ hasText: 'Payment did not go through' });
  await expect(alert).toBeVisible({ timeout: 45_000 });
  await expect(alert).toContainText('nothing was charged');
  // Back to a held booking: the options are offered again.
  await expect(page.getByLabel('Pay the full amount now')).toBeVisible();
  await shot(page, '015-booking-payment-failed');
  done();
});

test('order checkout: a failed sandbox payment shows an alert; the order can still be paid', async ({ page }) => {
  const done = failOnPageErrors(page);
  await signIn(page, 'customer@demo.test', '/s/noura-salon/products');
  await page.waitForURL(/\/s\/noura-salon\/products/);
  await page.getByRole('link', { name: /Nail file/ }).first().click();
  await page.getByRole('link', { name: 'Add to cart' }).or(page.getByRole('button', { name: 'Add to cart' })).first().click();
  await page.waitForURL(/\/s\/noura-salon\/cart/);
  await expect(page.getByText('Test payment environment')).toBeVisible(); // sandbox really connected here
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await page.waitForURL(/\/checkout\/order\//);
  await page.getByRole('button', { name: /Pay now/ }).click();
  await page.waitForURL(/\/sandbox\/checkout\//);
  await page.getByRole('button', { name: 'Simulate failed payment' }).click();
  await page.waitForURL(/\/checkout\/order\/.*payment=/);
  await expect(page.getByRole('alert').filter({ hasText: 'Payment did not go through' })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: /Pay now/ })).toBeEnabled();
  await shot(page, '015-order-payment-failed');
  done();
});

// ── 016: session expiry mid-booking ───────────────────────────────────────────
test('session expiry mid-booking: Reserve → sign in again → selection intact and re-validated', async ({ page, context, baseURL }) => {
  const done = failOnPageErrors(page);
  await signIn(page, 'new@demo.test', '/s/noura-salon/booking');
  await page.waitForURL(/\/s\/noura-salon\/booking/);
  await startBooking(page, /Cut & style/, 2);
  const chosen = await page.locator('button[aria-pressed="true"]').first().innerText();
  // The session ends while she is on the page.
  await context.clearCookies();
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  await page.getByRole('button', { name: /Reserve this time/ }).click();
  await page.waitForURL(/\/auth\/login/);
  await page.getByLabel('Email or mobile number').fill('new@demo.test');
  await page.getByLabel('Password').fill(creds()['new@demo.test']!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/s\/noura-salon\/booking/);
  await expect(page.getByRole('status').filter({ hasText: 'Your session ended' })).toBeVisible();
  await expect(page.locator('button[aria-pressed="true"]').first()).toHaveText(chosen);
  await expect(page.getByText('Cut & style').first()).toBeVisible();
  await shot(page, '016-session-expiry-restored');
  await page.getByRole('button', { name: /Reserve this time/ }).click();
  await page.waitForURL(/\/checkout\/booking\//);
  done();
});

// ── 018: variants and add-ons online ──────────────────────────────────────────
test('variant + two add-ons: the slot length and total follow the server quote', async ({ page }) => {
  const done = failOnPageErrors(page);
  const t = await tenantId('noura-salon');
  const [svc] = await db<{ id: string }>(`select id from services where tenant_id = $1 and name_en = 'Cut & style'`, [t]);
  const made = await db<{ id: string }>(`insert into service_variants (tenant_id, service_id, name_ar, name_en, price_minor, duration_min) values ($1, $2, 'شعر طويل', 'Long hair', 20000, 90) returning id`, [t, svc!.id]);
  const a = await db<{ id: string }>(`insert into service_addons (tenant_id, service_id, name_ar, name_en, price_minor, duration_min, sort) values ($1, $2, 'علاج كيراتين', 'Keratin mask', 3000, 15, 1), ($1, $2, 'تجفيف', 'Blow-dry finish', 2000, 15, 2) returning id`, [t, svc!.id]);
  try {
    await signIn(page, 'customer@demo.test', '/s/noura-salon/booking');
    await page.waitForURL(/\/s\/noura-salon\/booking/);
    await page.getByRole('button', { name: /Cut & style/ }).first().click();
    await page.getByLabel('Option').selectOption(made[0]!.id);
    await page.getByLabel('Keratin mask').check();
    await page.getByLabel('Blow-dry finish').check();
    await timeButton(page).waitFor();
    await dayFromEnd(page, 3).click();
    await timeButton(page).click();
    const summary = page.locator('section[aria-labelledby="rev-h"]');
    await expect(summary).toContainText('Long hair · + Keratin mask · + Blow-dry finish');
    // 90 + 15 + 15 minutes; 200 + 30 + 20 SAR.
    await expect(summary).toContainText(/2\s*h(ours?|r)?/i);
    await expect(summary).toContainText(/250/);
    await shot(page, '018-variant-addons-summary');
    await page.getByRole('button', { name: /Reserve this time/ }).click();
    await page.waitForURL(/\/checkout\/booking\//);
    const id = page.url().split('/checkout/booking/')[1]!.split('?')[0]!;
    const [row] = await db<{ total_minor: string; duration_min: number; variant_id: string; mins: number }>(
      `select b.total_minor, i.duration_min, i.variant_id, extract(epoch from (i.ends_at - i.starts_at))::int / 60 as mins
         from bookings b join booking_items i on i.booking_id = b.id where b.id = $1`, [id]);
    expect(Number(row!.total_minor)).toBe(25000);
    expect(row!.duration_min).toBe(120);
    expect(row!.mins).toBe(120);
    expect(row!.variant_id).toBe(made[0]!.id);
    done();
  } finally {
    await db('update service_variants set is_active = false where id = $1', [made[0]!.id]);
    await db('update service_addons set is_active = false where id = any($1::uuid[])', [a.map((x) => x.id)]);
  }
});

// ── Multi-service with different qualified specialists (browser) ─────────────
test('two services with two different qualified specialists are booked as one visit', async ({ page }) => {
  const done = failOnPageErrors(page);
  await signIn(page, 'customer@demo.test', '/s/noura-salon/booking');
  await page.waitForURL(/\/s\/noura-salon\/booking/);
  await page.getByRole('button', { name: /Cut & style/ }).first().click();
  await page.getByText(/Add another service/).click();
  await page.getByRole('button', { name: /Manicure/ }).first().click();
  // Each service's specialist picker names its service — not a second "1." under step 1 (LUMA-AUDIT-041).
  const svc = page.locator('section[aria-labelledby="svc-h"]');
  await expect(svc.getByText(/^Specialist for service 1 \(Cut & style/)).toBeVisible();
  await expect(svc.getByText(/^Specialist for service 2 \(Manicure/)).toBeVisible();
  await expect(svc).not.toContainText('1. Choose a specialist');
  // The first day with a joint itinerary is selected automatically.
  await timeButton(page).click();
  const summary = page.locator('section[aria-labelledby="rev-h"]');
  // The English UI shows the specialists' English names (LUMA-AUDIT-039); the Arabic snapshot is kept on the booking.
  await expect(summary).toContainText('with Sara');
  await expect(summary).toContainText('with Huda');
  await shot(page, 'multi-specialist-summary');
  await page.getByRole('button', { name: /Reserve this time/ }).click();
  await page.waitForURL(/\/checkout\/booking\//);
  const id = page.url().split('/checkout/booking/')[1]!.split('?')[0]!;
  // Checkout: English staff names and the localized tax label (the business typed an Arabic-only label).
  await expect(page.getByText(/· Sara ·/)).toBeVisible();
  await expect(page.getByText('Tax', { exact: true })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('ضريبة القيمة المضافة');
  const snap = await db<{ staff_name: string }>('select staff_name from booking_items where booking_id = $1 order by sequence', [id]);
  expect(snap.map((r) => r.staff_name)).toContain('سارة');
  const staff = await db<{ staff_id: string }>('select distinct staff_id from booking_items where booking_id = $1', [id]);
  expect(staff).toHaveLength(2);
  done();
});

// ── Customer payment restrictions through checkout (PAYMENT_FLOW §1) ─────────
test('payment restrictions: business deposit, full payment required, deposit required with on-site disallowed', async ({ page }) => {
  const t = await tenantId('noura-salon');
  const cust = await userId('customer@demo.test');
  const owner = await userId('owner@noura.demo');
  const decide = async (action: string) => (await db<{ id: string }>(
    `insert into policy_decisions (scope, tenant_id, customer_user_id, action, reason, customer_explanation_en, customer_explanation_ar, reviewer_id)
     values ('tenant', $1, $2, $3, 'e2e restriction test', 'Prepayment is required for your next visits.', 'مطلوب الدفع المسبق لزياراتك القادمة.', $4) returning id`, [t, cust, action, owner]))[0]!.id;
  const decisions: string[] = [];
  let round = 0;
  const options = async () => {
    await page.goto('/s/noura-salon/booking');
    // A different time each round, so earlier holds never block the next one.
    await startBooking(page, /Manicure/, -2, 4 + 2 * round++);
    await page.getByRole('button', { name: /Reserve this time/ }).click();
    await page.waitForURL(/\/checkout\/booking\//);
    await expect(page.getByRole('heading', { name: 'Complete your booking' })).toBeVisible();
    const labels = await page.locator('fieldset input[name="pay"]').evaluateAll((els) => els.map((e) => (e.parentElement?.textContent ?? '').trim()));
    return labels;
  };
  try {
    await signIn(page, 'customer@demo.test', '/s/noura-salon/booking');
    await page.waitForURL(/\/s\/noura-salon\/booking/);
    // Business policy: 20 % deposit → full or deposit; never on site.
    const base = await options();
    expect(base.some((l) => /full amount/.test(l))).toBe(true);
    expect(base.some((l) => /deposit/i.test(l))).toBe(true);
    expect(base.some((l) => /at the salon/i.test(l))).toBe(false);

    // Full payment required → only the full amount.
    decisions.push(await decide('require_full_payment'));
    const full = await options();
    expect(full).toHaveLength(1);
    expect(full[0]).toMatch(/full amount/);
    await shot(page, 'restriction-full-payment-required');
    await db(`update policy_decisions set status = 'revoked', ended_at = now() where id = any($1::uuid[])`, [decisions]);

    // No business deposit, on-site allowed, but a deposit-required decision: on-site is removed and,
    // with no deposit configured, the requirement is strengthened to full prepayment.
    await db(`update tenant_settings set deposit_mode = 'none' where tenant_id = $1`, [t]);
    const open = await options();
    expect(open.some((l) => /at the salon/i.test(l))).toBe(true);
    decisions.push(await decide('require_deposit'));
    const dep = await options();
    expect(dep.some((l) => /at the salon/i.test(l))).toBe(false);
    expect(dep.some((l) => /full amount/.test(l))).toBe(true);
  } finally {
    if (decisions.length) await db(`update policy_decisions set status = 'revoked', ended_at = now() where id = any($1::uuid[])`, [decisions]);
    await db(`update tenant_settings set deposit_mode = 'percent' where tenant_id = $1`, [t]);
  }
});

// ── 006 / R2: payment paths for product orders ───────────────────────────────
test('no online provider: the cart offers pay at pickup (no test-payment label); with on-site off the store says it is not accepting orders', async ({ page, baseURL }) => {
  const done = failOnPageErrors(page);
  const t = await tenantId('noura-salon');
  await db(`update payment_accounts set status = 'disconnected' where tenant_id = $1`, [t]);
  try {
    await signIn(page, 'customer@demo.test', '/s/noura-salon/products');
    await page.waitForURL(/\/s\/noura-salon\/products/);
    await page.getByRole('link', { name: /Nail file/ }).first().click();
    await page.getByRole('link', { name: 'Add to cart' }).or(page.getByRole('button', { name: 'Add to cart' })).first().click();
    await page.waitForURL(/\/s\/noura-salon\/cart/);
    await expect(page.getByLabel(/Pay at pickup/)).toBeChecked();
    await expect(page.getByText(/Online payment isn't available/)).toBeVisible();
    await expect(page.getByText('Test payment environment')).toHaveCount(0);
    await shot(page, '006-cart-pay-at-pickup');
    await page.getByRole('button', { name: 'Place order' }).click();
    await page.waitForURL(/\/checkout\/order\//);
    const orderId = page.url().split('/checkout/order/')[1]!.split('?')[0]!;
    await expect(page.getByText('Pay at pickup').first()).toBeVisible();
    await expect(page.getByText(/reserved until/)).toBeVisible();
    await expect(page.getByText('Test payment environment')).toHaveCount(0);
    await shot(page, '006-order-pay-at-pickup');

    // Pay-on-site off as well: nothing can be paid, so no order may be placed.
    await db(`update tenant_settings set allow_pay_on_site = false where tenant_id = $1`, [t]);
    await page.goto('/s/noura-salon/products');
    await page.getByRole('link', { name: /Nail file/ }).first().click();
    await page.getByRole('link', { name: 'Add to cart' }).or(page.getByRole('button', { name: 'Add to cart' })).first().click();
    await page.waitForURL(/\/s\/noura-salon\/cart/);
    await expect(page.getByText(/isn't accepting orders right now/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Continue to payment|Place order/ })).toHaveCount(0);
    await shot(page, '006-cart-not-accepting');

    // Owner: the pay-at-pickup order says so and is collected at the counter.
    await db(`update tenant_settings set allow_pay_on_site = true where tenant_id = $1`, [t]);
    await page.context().clearCookies();
    await page.context().addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
    await signIn(page, 'owner@noura.demo', `/app/noura-salon/orders?order=${orderId}`);
    await page.waitForURL(/\/app\/noura-salon\/orders/);
    await expect(page.getByText('The customer pays SAR 15 at pickup')).toBeVisible();
    await page.getByRole('button', { name: 'Record payment' }).click();
    await page.getByLabel(/Reference \/ receipt no\./).fill('E2E-PICKUP-1');
    await shot(page, '006-owner-record-pickup-payment');
    await page.getByRole('dialog').filter({ hasText: 'Collect order payment' }).last().getByRole('button', { name: 'Record payment' }).last().click();
    await expect(page.getByText('Payment recorded')).toBeVisible();
    const [o] = await db<{ status: string }>('select status from orders where id = $1', [orderId]);
    expect(o!.status).toBe('paid');
    done();
  } finally {
    await db(`update payment_accounts set status = 'active' where tenant_id = $1`, [t]);
    await db(`update tenant_settings set allow_pay_on_site = true where tenant_id = $1`, [t]);
  }
});

// ── 033 / R7: package editing ────────────────────────────────────────────────
test('owner edits a package in place: same id, new price for new sales', async ({ page }) => {
  const done = failOnPageErrors(page);
  const t = await tenantId('noura-salon');
  const svcs = await db<{ id: string }>(`select id from services where tenant_id = $1 and name_en in ('Cut & style', 'Manicure') order by name_en`, [t]);
  const [p] = await db<{ id: string }>(`insert into service_packages (tenant_id, name_ar, name_en, price_minor) values ($1, 'باقة الدلال', 'Pamper package', 21000) returning id`, [t]);
  await db(`insert into service_package_items (tenant_id, package_id, service_id, sequence) values ($1, $2, $3, 0), ($1, $2, $4, 1)`, [t, p!.id, svcs[0]!.id, svcs[1]!.id]);
  await signIn(page, 'owner@noura.demo', '/app/noura-salon/services?tab=packages');
  await page.waitForURL(/\/app\/noura-salon\/services/);
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Pamper package' }) });
  await card.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit package' });
  await expect(dialog.getByText(/Changes apply to new bookings and sales only/)).toBeVisible();
  await dialog.getByLabel('Package price').fill('199');
  await shot(page, '033-package-edit');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Package saved.')).toBeVisible();
  const [row] = await db<{ id: string; price_minor: string }>('select id, price_minor from service_packages where id = $1', [p!.id]);
  expect(Number(row!.price_minor)).toBe(19900);
  done();
});
