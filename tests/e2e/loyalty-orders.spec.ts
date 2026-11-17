import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { e2eEnv } from '../../playwright.config';
import { failOnPageErrors, signIn } from './helpers';

/**
 * Owner decision R6 in the browser: loyalty points are earned on a paid
 * product order at collection (programme rule: points per SAR paid) and
 * reversed on refund. The customer sees the balance in /account/loyalty.
 *
 * There is no dashboard button to refund a product order (returns are
 * approved separately and do not refund — documented gap), so the refund is
 * requested through the staff API from the owner's signed-in browser session
 * and settled in the payment sandbox, then checked in the customer's UI.
 */
test.describe.configure({ mode: 'serial' });
const EVIDENCE = 'docs/remediation/evidence/verify';

async function nouraBalance(page: Page) {
  const rows = (await (await page.request.get('/api/v1/account/loyalty')).json()).data as Array<{ tenant_slug: string; balance: number }>;
  return rows.find((r) => r.tenant_slug === 'noura-salon')?.balance ?? 0;
}

let owner: Page;
let shopper: Page;
let orderId = '';
let before = 0;
let earned = 0;

test.beforeAll(async ({ browser, baseURL }) => {
  const mk = async () => {
    const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await ctx.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
    return ctx.newPage();
  };
  owner = await mk();
  shopper = await mk();
  await signIn(owner, 'owner@noura.demo', '/app/noura-salon/loyalty');
  await owner.waitForURL(/\/app\/noura-salon\/loyalty/);
  await signIn(shopper, 'customer@demo.test', '/s/noura-salon/products');
  await shopper.waitForURL(/\/s\/noura-salon\/products/);
});

test('owner enables the loyalty programme (1 point per SAR paid, reverse on refund)', async () => {
  const done = failOnPageErrors(owner);
  const program = owner.getByRole('switch', { name: 'Enabled' });
  if ((await program.getAttribute('aria-checked')) !== 'true') await program.click();
  await owner.getByLabel(/Points per SAR paid/).fill('1');
  const save = owner.getByRole('button', { name: 'Save' }).first();
  if (await save.isEnabled()) { await save.click(); await expect(owner.getByText('Saved').first()).toBeVisible(); }
  const prog = (await (await owner.request.get('/api/v1/t/noura-salon/loyalty')).json()).data.program;
  expect(prog).toMatchObject({ is_enabled: true, reverse_on_refund: true });
  expect(Number(prog.points_per_currency_unit)).toBe(1);
  done();
});

test('customer buys a product online; points are earned only when the owner marks it collected', async () => {
  const done = failOnPageErrors(shopper);
  before = await nouraBalance(shopper);
  await shopper.getByRole('link', { name: /Nail file/ }).first().click();
  await shopper.waitForURL(/\/s\/noura-salon\/products\//);
  await shopper.getByRole('link', { name: 'Add to cart' }).or(shopper.getByRole('button', { name: 'Add to cart' })).first().click();
  await shopper.waitForURL(/\/s\/noura-salon\/cart/);
  await shopper.getByRole('button', { name: 'Continue to payment' }).click();
  await shopper.waitForURL(/\/checkout\/order\//);
  orderId = shopper.url().match(/\/checkout\/order\/([0-9a-f-]{36})/)![1]!;
  await shopper.getByRole('button', { name: /Pay now/ }).click();
  await shopper.waitForURL(/\/sandbox\/checkout\//);
  await shopper.getByRole('button', { name: 'Simulate successful payment' }).click();
  await expect(shopper.getByRole('heading', { name: 'Paid — thank you' })).toBeVisible({ timeout: 45_000 });
  const paid = (await (await shopper.request.get(`/api/v1/s/noura-salon/orders/${orderId}`)).json()).data.paid_minor as number;
  earned = Math.floor(paid / 100);
  expect(earned).toBeGreaterThan(0);
  expect(await nouraBalance(shopper)).toBe(before); // paid but not collected: nothing yet

  // Owner marks it collected in the orders drawer.
  const odone = failOnPageErrors(owner);
  await owner.goto(`/app/noura-salon/orders?order=${orderId}`);
  const drawer = owner.getByRole('dialog').first();
  for (let i = 0; i < 3 && !(await drawer.getByRole('button', { name: 'Collected' }).isVisible()); i++) {
    await drawer.getByRole('button', { name: /Start preparing|Ready for pickup/ }).first().click();
    await owner.getByRole('dialog', { name: /Ready for pickup|Start preparing/ }).getByRole('button', { name: 'Confirm' }).click();
    await expect(owner.getByText('Order updated').first()).toBeVisible();
  }
  await drawer.getByRole('button', { name: 'Collected' }).click();
  await owner.getByRole('dialog', { name: /Collected/ }).getByRole('button', { name: 'Confirm' }).click();
  await expect(drawer.getByText('Collected').first()).toBeVisible();
  odone();

  await shopper.goto('/account/loyalty');
  const card = shopper.locator('li', { hasText: /الروشة|Rawsha/ }).first();
  await expect(card).toContainText(String(before + earned));
  if (process.env.E2E_EVIDENCE) await shopper.screenshot({ path: `${EVIDENCE}/account-loyalty-after-collection-en.png` });
  expect(await nouraBalance(shopper)).toBe(before + earned);
  done();
});

test('a full refund of the order reverses the points', async () => {
  const detail = (await (await owner.request.get(`/api/v1/t/noura-salon/orders/${orderId}`)).json()).data;
  const pay = detail.payments.find((p: { kind: string; status: string }) => p.status === 'captured');
  expect(pay).toBeTruthy();
  const r = await owner.request.post('/api/v1/t/noura-salon/refunds', {
    headers: { 'x-luma-csrf': '1', 'Idempotency-Key': `e2e-loyalty-refund-${orderId}` },
    data: { payment_id: pay.id, amount_minor: pay.amount_minor, reason: 'E2E: product returned' },
  });
  expect(r.status(), await r.text()).toBe(201);
  // Settle it in the payment sandbox (as the provider would), unless it already completed.
  const c = new pg.Client({ connectionString: e2eEnv.DATABASE_OWNER_URL });
  await c.connect();
  try {
    const rf = (await c.query<{ provider_refund_id: string | null; status: string }>('select provider_refund_id, status from refunds where payment_id = $1 order by created_at desc limit 1', [pay.id])).rows[0]!;
    if (rf.status !== 'succeeded' && rf.provider_refund_id) {
      const s = await owner.request.post(`/api/v1/sandbox/refunds/${rf.provider_refund_id}`, { headers: { 'x-luma-csrf': '1' }, data: { outcome: 'succeeded' } });
      expect(s.status(), await s.text()).toBe(200);
    }
    expect((await c.query('select status from refunds where payment_id = $1', [pay.id])).rows[0].status).toBe('succeeded');
  } finally { await c.end(); }

  await shopper.goto('/account/loyalty');
  await expect(shopper.locator('li', { hasText: /الروشة|Rawsha/ }).first()).toContainText(String(before));
  expect(await nouraBalance(shopper)).toBe(before);
});
