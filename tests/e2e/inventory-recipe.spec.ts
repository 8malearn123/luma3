import { expect, test } from '@playwright/test';
import pg from 'pg';
import { DateTime } from 'luxon';
import { e2eEnv } from '../../playwright.config';
import { creds, failOnPageErrors } from './helpers';

/**
 * Recipe-based service consumption through the browser (audit verification gap), and the
 * seeded opening stock (LUMA-AUDIT-036): the owner books a manicure with Huda — who is linked
 * to «كرسي 1», served by the station «محطة كرسي 1» — checks it in, starts and completes it in
 * the dashboard; the recipe (5 ml polish) is deducted ONCE from the station.
 *
 * Time independence: today's opening hours and Huda's working hours cover the whole day, the
 * salon's notice period is 0 and no deposit is asked, in the disposable E2E database (setup only).
 */
test.use({ launchOptions: { executablePath: '/opt/pw-browsers/chromium' }, viewport: { width: 1280, height: 900 } });

const TZ = 'Asia/Riyadh';
type Row = Record<string, unknown>;

async function q<T extends Row>(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: e2eEnv.DATABASE_OWNER_URL });
  await c.connect();
  try { return (await c.query<T>(sql, params)).rows; } finally { await c.end(); }
}

const tenant = async () => (await q<{ id: string }>(`select id from tenants where slug = 'noura-salon'`))[0]!.id;

test('seeded stock comes from opening movements that reconcile with the ledger (LUMA-AUDIT-036)', async () => {
  const t = await tenant();
  const items = await q<{ name: string; on_hand: string; moved: string; openings: string }>(`
    select i.name, i.on_hand::text, coalesce(sum(m.quantity), 0)::text as moved, count(*) filter (where m.kind = 'opening')::text as openings
    from inventory_items i left join stock_movements m on m.inventory_item_id = i.id where i.tenant_id = $1 group by i.id`, [t]);
  expect(items.length).toBeGreaterThan(0);
  for (const i of items) {
    expect(Number(i.openings), i.name).toBe(1);
    expect(Number(i.moved), i.name).toBe(Number(i.on_hand));
  }
  const [ledger] = await q<{ inventory: string; equity: string }>(`select
    coalesce(sum(debit_minor - credit_minor) filter (where account = 'inventory'), 0)::text as inventory,
    coalesce(sum(credit_minor - debit_minor) filter (where account = 'owner_equity'), 0)::text as equity
    from financial_entries where tenant_id = $1`, [t]);
  const [value] = await q<{ v: string }>('select coalesce(sum(on_hand * coalesce(avg_cost_minor, 0)), 0)::text as v from inventory_items where tenant_id = $1', [t]);
  expect(Number(ledger!.inventory)).toBe(Math.round(Number(value!.v)));
  expect(Number(ledger!.equity)).toBe(Number(ledger!.inventory));
});

test('owner completes a manicure on the station-linked chair: the recipe is deducted once from the station', async ({ browser, baseURL }) => {
  const now = DateTime.now().setZone(TZ);
  test.skip(now.hour >= 23, 'Needs a free slot later today (Asia/Riyadh); re-run earlier in the day.');
  const t = await tenant();
  const weekday = now.weekday % 7;
  const [huda] = await q<{ id: string; branch_id: string }>(`select s.id, b.id as branch_id from staff_profiles s join branches b on b.tenant_id = s.tenant_id where s.tenant_id = $1 and s.display_name = 'هدى'`, [t]);
  for (const [table, cond, cols] of [
    ['branch_hours', 'branch_id = $2', `(tenant_id, branch_id, weekday, opens, closes) values ($1, $2, $3, '00:00', '23:59')`],
  ] as const) {
    await q(`delete from ${table} where tenant_id = $1 and ${cond} and weekday = $3`, [t, huda!.branch_id, weekday]);
    await q(`insert into ${table} ${cols}`, [t, huda!.branch_id, weekday]);
  }
  await q('delete from working_hours where tenant_id = $1 and staff_id = $2 and weekday = $3', [t, huda!.id, weekday]);
  await q(`insert into working_hours (tenant_id, staff_id, branch_id, weekday, start_time, end_time) values ($1, $2, $3, $4, '00:00', '23:59')`, [t, huda!.id, huda!.branch_id, weekday]);
  // No deposit for this walk-in visit: confirmed on site, so it can be checked in and completed now.
  await q(`update tenant_settings set min_notice_min = 0, deposit_mode = 'none' where tenant_id = $1`, [t]);

  const stationQty = async () => Number((await q<{ on_hand: string }>(`select b.on_hand::text from stock_balances b join stock_locations l on l.id = b.location_id
    join inventory_items i on i.id = b.inventory_item_id where l.tenant_id = $1 and l.name = 'محطة كرسي 1' and i.name like 'طلاء أظافر%'`, [t]))[0]?.on_hand ?? 0);
  expect(await stationQty()).toBe(100);

  const ctx = await browser.newContext({ locale: 'en-US' });
  await ctx.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  const page = await ctx.newPage();
  const done = failOnPageErrors(page);
  await page.goto(`/auth/login?next=${encodeURIComponent('/app/noura-salon/bookings')}`);
  await page.getByLabel('Email or mobile number').fill('owner@noura.demo');
  await page.getByLabel('Password').fill(creds()['owner@noura.demo']!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/app\/noura-salon\/bookings/);

  await page.getByRole('button', { name: 'New booking' }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByPlaceholder('Search by name, mobile or email').fill('حضورية 2');
  await drawer.getByRole('button', { name: /حضورية 2/ }).first().click();
  await drawer.getByLabel('Service 1').selectOption({ label: 'Manicure' });
  await drawer.getByLabel('Specialist').selectOption({ label: 'هدى' });
  await drawer.locator('[role="listbox"] [role="option"]').first().click();
  await drawer.getByRole('button', { name: 'Confirm, pay at the salon' }).click();
  await expect(page).toHaveURL(/booking=/);
  const bookingId = new URL(page.url()).searchParams.get('booking')!;
  // The engine reserved the linked chair together with Huda (D1b).
  const chair = await q<{ name: string }>(`select r.name from booking_allocations a join resources r on r.id = a.resource_id where a.booking_id = $1`, [bookingId]);
  expect(chair.map((c) => c.name)).toEqual(['كرسي 1']);

  const bd = page.getByRole('dialog');
  for (const action of ['Check in', 'Start service', 'Complete']) {
    await bd.getByRole('button', { name: action, exact: true }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: action, exact: true }).click();
    await expect(bd.getByRole('button', { name: action, exact: true })).toHaveCount(0);
  }
  await expect(bd.getByText('Completed').first()).toBeVisible();

  // Exactly one consumption movement, from the chair's station, for the recipe quantity.
  const moves = await q<{ quantity: string; location: string }>(`select m.quantity::text, l.name as location from stock_movements m join stock_locations l on l.id = m.location_id
    join booking_items bi on bi.id = m.ref_id where bi.booking_id = $1 and m.kind = 'consumption'`, [bookingId]);
  expect(moves).toEqual([{ quantity: '-5.000', location: 'محطة كرسي 1' }]);
  expect(await stationQty()).toBe(95);

  // The usage list shows the posted consumption at the station.
  await page.goto('/app/noura-salon/inventory?tab=consumption');
  await expect(page.getByRole('table').getByText(/محطة كرسي 1/).first()).toBeVisible();
  await page.screenshot({ path: 'docs/remediation/evidence/host/h8-recipe-consumption-station.png' });

  // Reloading / re-completing never posts it twice.
  await page.goto(`/app/noura-salon/bookings?booking=${bookingId}`);
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Complete', exact: true })).toHaveCount(0);
  expect(await stationQty()).toBe(95);
  done();
});

test('manual issue retried after a lost response posts once (LUMA-AUDIT-011: one Idempotency-Key per operation)', async ({ browser, baseURL }) => {
  const t = await tenant();
  const ctx = await browser.newContext({ locale: 'en-US' });
  await ctx.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  const page = await ctx.newPage();
  await page.goto(`/auth/login?next=${encodeURIComponent('/app/noura-salon/inventory?tab=consumption')}`);
  await page.getByLabel('Email or mobile number').fill('owner@noura.demo');
  await page.getByLabel('Password').fill(creds()['owner@noura.demo']!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/app\/noura-salon\/inventory/);

  const keys: string[] = [];
  let first = true;
  // The first request reaches the server and is posted, but the browser never sees the answer.
  await page.route('**/inventory/issue', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (first) { first = false; await route.fetch(); await route.abort('connectionreset'); return; }
    await route.continue();
  });
  const item = page.getByLabel('Item', { exact: true }).first();
  await item.selectOption((await item.locator('option', { hasText: 'طلاء أظافر' }).first().getAttribute('value'))!);
  await page.getByLabel('Quantity', { exact: true }).first().fill('3');
  await page.getByLabel('Reason', { exact: true }).first().fill('training session');
  const issue = page.getByRole('button', { name: 'Manual issue', exact: true });
  await issue.click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await issue.click();
  await expect(page.getByText('Saved').first()).toBeVisible();

  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^idem-/);
  expect(keys[1]).toBe(keys[0]);
  const manual = await q<{ n: string }>(`select count(*)::text as n from material_consumptions where tenant_id = $1 and source = 'manual' and reason = 'training session'`, [t]);
  expect(Number(manual[0]!.n)).toBe(1);
});
