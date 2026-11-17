import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import { DateTime } from 'luxon';
import { e2eEnv } from '../../playwright.config';
import { creds, failOnPageErrors, noHorizontalScroll } from './helpers';

/**
 * Workspace hosting, end to end in the browser (LUMA-AUDIT-004/009/013/037/047):
 *  1. the salon («الروشة», noura-salon) creates a space with a product and an equipment add-on,
 *     edits it and publishes it — entirely through the UI;
 *  2. the expert (lamar-makeup) searches, checks the price breakdown, books and pays in the sandbox;
 *  3. she places a client appointment inside the confirmed space from the booking drawer
 *     (an appointment whose buffers spill out is refused with the window explained);
 *  4. check-in with the reception code, a material request approved by the salon, check-out;
 *  5. the settlement is visible on both sides, dues are paid, and both finance reports show hosting.
 *
 * Time independence: check-in opens one hour before the start, so the space starts within the
 * hour. The test environment widens today's opening/working hours and the expert's notice period
 * in the disposable E2E database (setup only — every hosting record is created through the UI).
 */
test.use({ launchOptions: { executablePath: '/opt/pw-browsers/chromium' }, viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: 'serial' });

const TZ = 'Asia/Riyadh';
const CODE = `E2E-${Date.now().toString(36).slice(-4).toUpperCase()}`;
const TITLE = 'E2E chair';
const EVIDENCE = 'docs/remediation/evidence/host';

async function db<T>(fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: e2eEnv.DATABASE_OWNER_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** Opening/working hours for today cover the whole day for both businesses; the expert needs no notice. */
async function wholeDayToday() {
  const weekday = DateTime.now().setZone(TZ).weekday % 7;
  await db(async (c) => {
    for (const slug of ['noura-salon', 'lamar-makeup']) {
      const t = (await c.query<{ id: string }>('select id from tenants where slug = $1', [slug])).rows[0]!;
      const branches = (await c.query<{ id: string }>('select id from branches where tenant_id = $1', [t.id])).rows;
      for (const b of branches) {
        await c.query('delete from branch_hours where tenant_id = $1 and branch_id = $2 and weekday = $3', [t.id, b.id, weekday]);
        await c.query(`insert into branch_hours (tenant_id, branch_id, weekday, opens, closes) values ($1, $2, $3, '00:00', '23:59')`, [t.id, b.id, weekday]);
      }
    }
    const lamar = (await c.query<{ id: string }>(`select id from tenants where slug = 'lamar-makeup'`)).rows[0]!;
    const staff = (await c.query<{ id: string; branch_id: string }>('select s.id, b.id as branch_id from staff_profiles s join branches b on b.tenant_id = s.tenant_id where s.tenant_id = $1', [lamar.id])).rows;
    for (const s of staff) {
      await c.query('delete from working_hours where tenant_id = $1 and staff_id = $2 and weekday = $3', [lamar.id, s.id, weekday]);
      await c.query(`insert into working_hours (tenant_id, staff_id, branch_id, weekday, start_time, end_time) values ($1, $2, $3, $4, '00:00', '23:59')`, [lamar.id, s.id, s.branch_id, weekday]);
    }
    await c.query('update tenant_settings set min_notice_min = 0, slot_increment_min = 15 where tenant_id = $1', [lamar.id]);
  });
}

async function signedIn(browser: Browser, baseURL: string, email: string, next: string) {
  const ctx = await browser.newContext({ locale: 'en-US' });
  await ctx.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL }]);
  const page = await ctx.newPage();
  await page.goto(`/auth/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email or mobile number').fill(email);
  await page.getByLabel('Password').fill(creds()[email]!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname === next.split('?')[0]);
  return page;
}

/** Evidence screenshots are refreshed only on request (E2E_EVIDENCE=1), so a normal run leaves the tree clean. */
const shot = async (page: Page, name: string) => { if (process.env.E2E_EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage: false }); };

// The space starts 15–30 minutes from now (quarter-hour aligned), so check-in is already open.
const now = DateTime.now().setZone(TZ);
const start = now.plus({ minutes: 15 + (15 - (now.minute % 15)) }).startOf('minute');
const DATE = start.toISODate()!;
const HHMM = start.toFormat('HH:mm');
const fitsToday = start.plus({ minutes: 120 }) <= start.endOf('day').minus({ minutes: 1 });

let host: Page;
let expert: Page;
let bookingId = '';

test.beforeAll(async ({ browser, baseURL }) => {
  test.skip(!fitsToday, 'A 2-hour space starting within the hour must end before midnight (Asia/Riyadh); re-run earlier in the day.');
  await wholeDayToday();
  host = await signedIn(browser, baseURL!, 'owner@noura.demo', '/app/noura-salon/hosting');
  expert = await signedIn(browser, baseURL!, 'lamar@lamar.demo', '/app/lamar-makeup/workspace');
});

test('salon creates, edits and publishes a space with add-ons entirely in the UI', async () => {
  const done = failOnPageErrors(host);
  await host.getByRole('tab', { name: 'Spaces' }).click();
  // The seeded, published chair K-1 is listed; the editor opens (it used to crash: LUMA-AUDIT-004).
  await expect(host.getByTestId('listing-K-1')).toContainText('Published');
  await host.getByRole('button', { name: 'New space' }).click();
  const drawer = host.getByRole('dialog');
  await expect(drawer.getByText('Add-ons (products and equipment)')).toBeVisible();
  await drawer.getByLabel(/^Chair \/ room/).selectOption({ label: 'كرسي 2 — فرع العليا' });
  await drawer.getByLabel(/^Number or name/).fill(CODE);
  await drawer.getByLabel(/^Title/).fill(TITLE);
  await drawer.getByLabel(/^Booking mode/).selectOption('instant');
  await drawer.getByLabel(/^Price/).first().fill('40');
  // Offered today, all day.
  await drawer.getByLabel('Day', { exact: true }).first().selectOption(String(start.weekday % 7));
  await drawer.getByLabel('From', { exact: true }).first().fill('00:00');
  await drawer.getByLabel('To', { exact: true }).first().fill('23:59');
  // D5/D5b: a whole store product at store price, with a 10% add-ons discount; D6: rented equipment.
  await drawer.getByLabel(/^Add-ons discount/).fill('10');
  await drawer.getByRole('button', { name: 'Add product' }).click();
  await drawer.getByLabel(/^Product/).selectOption({ index: 1 });
  await expect(drawer.getByText(/Current store price/)).toBeVisible();
  await drawer.getByRole('button', { name: 'Add equipment' }).click();
  await drawer.getByLabel(/^Equipment \(a resource/).selectOption({ label: 'جهاز بخار للبشرة' });
  await drawer.getByLabel('Name shown to the expert').fill('Facial steamer');
  await drawer.getByLabel(/^Rental price/).fill('15');
  await expect(drawer.getByTestId('addon-row')).toHaveCount(2);
  await shot(host, 'h1-new-space-addons');
  await drawer.getByRole('button', { name: 'Save' }).click();
  const card = host.getByTestId(`listing-${CODE}`);
  await expect(card).toContainText('Draft');
  await expect(card).toContainText(/SAR\s?40(\.00)?\b/);

  // Edit: the saved add-ons come back, the price changes.
  await card.getByRole('button', { name: 'Edit space' }).click();
  await expect(host.getByRole('dialog').getByTestId('addon-row')).toHaveCount(2);
  await host.getByRole('dialog').getByLabel(/^Price/).first().fill('50');
  await host.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(card).toContainText(/SAR\s?50(\.00)?\b/);

  await card.getByRole('button', { name: 'Publish' }).click();
  await expect(card).toContainText('Published');
  await shot(host, 'h2-space-published');
  done();
});

test('expert searches, sees the price breakdown, books and pays in the sandbox', async () => {
  const done = failOnPageErrors(expert);
  await expert.getByLabel(/^Date/).fill(DATE);
  await expert.getByLabel('Start time').fill(HHMM);
  await expert.getByLabel('Duration (min)').fill('120');
  await expert.getByRole('button', { name: 'Search' }).click();
  const result = expert.getByRole('button', { name: new RegExp(`${TITLE}`) });
  await expect(result).toBeVisible();
  // LUMA-AUDIT-037: the second amount on the card is labelled.
  await expect(result).toContainText('Chair alone for this duration (120 min)');
  await result.click();
  const drawer = expert.getByRole('dialog');
  await expect(drawer.getByText('No materials are included', { exact: false })).toBeVisible();
  // Both add-on kinds configured by the salon are offered to the expert (LUMA-AUDIT-009).
  await expect(drawer.getByText('Facial steamer')).toBeVisible();
  await expect(drawer.getByLabel('Quantity')).toHaveCount(2);
  await drawer.getByLabel('Quantity').first().fill('1');
  await drawer.getByRole('button', { name: 'Total with add-ons' }).click();
  const breakdown = drawer.getByTestId('price-breakdown');
  await expect(breakdown).toContainText('Space rent');
  await expect(breakdown).toContainText(/Add-ons discount \(10%\)/);
  await expect(breakdown).toContainText(/included \(15%\)/);
  await expect(breakdown).toContainText('Total due');
  await shot(expert, 'h3-price-breakdown');
  await drawer.getByRole('button', { name: 'Book', exact: true }).click();

  await expect(expert).toHaveURL(/booking=/);
  bookingId = new URL(expert.url()).searchParams.get('booking')!;
  const bd = expert.getByRole('dialog');
  await expect(bd.getByTestId('hold-expiry')).toContainText('Held until');
  await bd.getByRole('button', { name: 'Pay now' }).click();
  await expert.waitForURL(/\/sandbox\/checkout\//);
  await expert.getByRole('button', { name: 'Simulate successful payment' }).click();
  await expert.waitForURL(/\/app\/lamar-makeup\/workspace\?booking=/);
  await expect(expert.getByRole('dialog').getByText('Confirmed', { exact: true })).toBeVisible({ timeout: 30_000 });
  done();
});

test('expert places a client appointment inside the confirmed space; the salon sees none of it', async () => {
  const done = failOnPageErrors(expert);
  const bd = expert.getByRole('dialog');
  const form = bd.getByRole('form', { name: 'Add a client appointment in this space' });
  await form.getByLabel(/^Client/).selectOption({ index: 1 });
  await form.getByLabel(/^Service/).selectOption({ label: 'Soft glam' });
  // 90 min + 15 min cleanup starting 30 min into a 2-hour space does not fit: the message explains why.
  await form.getByLabel(/^Appointment start/).fill(start.plus({ minutes: 30 }).toFormat('HH:mm'));
  await form.getByRole('button', { name: 'Add a client appointment in this space' }).click();
  await expect(form).toContainText(/cleanup \(15 min\) after/);
  await shot(expert, 'h4-outside-window-message');
  await form.getByLabel(/^Appointment start/).fill(HHMM);
  await form.getByRole('button', { name: 'Add a client appointment in this space' }).click();
  await expect(bd.getByTestId('linked-appointments')).toBeVisible();
  await expect(bd.getByTestId('linked-appointments').locator('li')).toHaveCount(1);

  // D14: the salon's view of the same booking has no client data.
  await host.goto(`/app/noura-salon/hosting?booking=${bookingId}`);
  const hd = host.getByRole('dialog');
  await expect(hd.getByText(/Check-in code for the expert/)).toBeVisible();
  await expect(hd).not.toContainText('هيا');
  await expect(hd).not.toContainText('Soft glam');
  done();
});

test('check-in with the reception code, a material add-on approved by the salon, check-out', async () => {
  const hd = host.getByRole('dialog');
  const code = (await hd.getByText(/Check-in code for the expert/).innerText()).match(/(\d{6})/)![1]!;
  const bd = expert.getByRole('dialog');
  await bd.getByLabel('Reception code').fill(code);
  await bd.getByRole('button', { name: 'Check in' }).click();
  await expect(bd.getByText('Checked in', { exact: true })).toBeVisible();

  await bd.getByLabel('Add-ons', { exact: true }).selectOption({ index: 1 });
  await bd.getByRole('button', { name: 'Send' }).click();
  await host.reload();
  await host.getByRole('dialog').getByRole('button', { name: 'Approve & sell' }).click();
  await expect(host.getByRole('dialog').getByText('Approved', { exact: true })).toBeVisible();

  await expert.reload();
  await expert.getByRole('dialog').getByLabel('Reception code').fill(code);
  await expert.getByRole('dialog').getByRole('button', { name: 'Check out' }).click();
  await expect(expert.getByRole('dialog').getByText('Completed', { exact: true })).toBeVisible();
});

test('the settlement is visible on both sides, dues are paid, and both finance reports include hosting', async () => {
  await host.reload();
  const hd = host.getByRole('dialog');
  await expect(hd.getByText('Salon net (total charges less platform fee)')).toBeVisible();
  await hd.getByRole('button', { name: 'Approve settlement' }).click();
  await expect(hd.getByRole('button', { name: 'Approve settlement' })).toHaveCount(0);
  await shot(host, 'h5-host-settlement');

  await expert.reload();
  const bd = expert.getByRole('dialog');
  await expect(bd.getByText('Total charges')).toBeVisible();
  await bd.getByRole('button', { name: /Pay dues/ }).click();
  await expert.waitForURL(/\/sandbox\/checkout\//);
  await expert.getByRole('button', { name: 'Simulate successful payment' }).click();
  await expert.waitForURL(/\/app\/lamar-makeup\/workspace\?booking=/);
  await expect(expert.getByRole('dialog').getByRole('button', { name: /Pay dues/ })).toHaveCount(0, { timeout: 30_000 });
  await shot(expert, 'h6-expert-settlement');

  // Expert: hosting expense by salon adds up to the total (LUMA-AUDIT-037).
  await expert.getByRole('dialog').press('Escape');
  await expert.goto('/app/lamar-makeup/workspace');
  await expert.getByRole('tab', { name: 'Expenses & dues' }).click();
  const total = await expert.getByText('Hosting expenses').locator('..').innerText();
  const perHost = await expert.getByTestId('expense-per-host').innerText();
  const amount = (s: string) => [...s.matchAll(/SAR\s?([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1]!.replace(/,/g, '')));
  expect(amount(perHost).reduce((a, b) => a + b, 0)).toBeCloseTo(amount(total)[0]!, 2);

  // Finance reports (LUMA-AUDIT-010): the salon's net hosting revenue and the expert's hosting expense.
  await host.goto('/app/noura-salon/finance');
  await expect(host.getByText('Net hosting revenue')).toBeVisible();
  await shot(host, 'h7-finance-hosting-revenue');
  await expert.goto('/app/lamar-makeup/finance');
  await expect(expert.getByText('Hosting expense', { exact: true })).toBeVisible();
});

test('the hosting screens fit a 375 px phone without horizontal scrolling', async () => {
  await host.setViewportSize({ width: 375, height: 800 });
  await host.goto('/app/noura-salon/hosting');
  await host.getByRole('tab', { name: 'Spaces' }).click();
  await expect(host.getByTestId('listing-K-1')).toBeVisible();
  await noHorizontalScroll(host);
  await host.getByRole('button', { name: 'New space' }).click();
  await expect(host.getByRole('dialog').getByText('Add-ons (products and equipment)')).toBeVisible();
  await noHorizontalScroll(host);
  await expert.setViewportSize({ width: 375, height: 800 });
  await expert.goto(`/app/lamar-makeup/workspace?booking=${bookingId}`);
  await expect(expert.getByRole('dialog').getByTestId('linked-appointments')).toBeVisible();
  await noHorizontalScroll(expert);
});
