import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * LUMA-AUDIT-035 dark mode (toggle, SSR, scope), 041 accessible names,
 * 049 onboarding/account/denied-state polish.
 */
test.use({ launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' } });

const EVIDENCE = process.env.EVIDENCE_DIR;
const shot = async (page: Page, name: string) => {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}/${name}.png` });
};

const states: Record<string, Awaited<ReturnType<BrowserContext['storageState']>>> = {};
async function as(context: BrowserContext, page: Page, email: string, baseURL: string) {
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL }]);
  if (states[email]) { await context.addCookies(states[email]!.cookies); return; }
  await signIn(page, email);
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'));
  states[email] = await context.storageState();
}

const bg = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);

function luminance(rgb: string) {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

test('dark mode: user-menu toggle persists (server-rendered), follows the device by default, and never themes the storefront', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await as(context, page, 'owner@noura.demo', baseURL!);
  await page.goto('/app/noura-salon');
  expect(await bg(page, '.luma-app')).toBe('rgb(251, 241, 246)'); // light canvas

  await page.locator('header button[aria-haspopup="menu"]').last().click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await bg(page, '.luma-app')).toBe('rgb(23, 17, 26)');

  // Server renders the choice (no flash): the raw HTML already carries it.
  const html = await (await page.request.get('/app/noura-salon')).text();
  expect(html).toMatch(/<html[^>]*data-theme="dark"/);
  await page.reload();
  expect(await bg(page, '.luma-app')).toBe('rgb(23, 17, 26)');
  // AA contrast on key pairs in dark mode.
  const main = page.locator('main').first();
  const textColor = await main.evaluate((el) => getComputedStyle(el).color);
  expect(contrast(textColor, await bg(page, '.luma-app'))).toBeGreaterThanOrEqual(4.5);
  const active = page.locator('aside nav a[aria-current="page"]').first();
  const [fg, abg] = await active.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
  expect(contrast(fg!, abg!)).toBeGreaterThanOrEqual(4.5);
  await shot(page, '035-dashboard-dark');

  // The public storefront keeps the business's theme, even with dark chosen.
  await page.goto('/s/noura-salon');
  const sfBg = await bg(page, '.storefront');
  expect(sfBg).not.toBe('rgb(23, 17, 26)');
  expect(sfBg).toBe(await page.locator('.storefront').evaluate((el) => { const v = getComputedStyle(el).getPropertyValue('--sf-background').trim(); const n = parseInt(v.slice(1), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; }));
  // The marketing site is not a dashboard: it stays light.
  await page.goto('/');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(251, 241, 246)');

  // Builder in dark: LUMA chrome is dark, the storefront canvas keeps its own light theme.
  await page.goto('/app/noura-salon/builder');
  await expect(page.locator('[data-builder-canvas] .storefront')).toBeVisible();
  expect(await bg(page, '[data-builder-canvas] .storefront')).not.toBe('rgb(34, 26, 38)');
  await shot(page, '035-builder-dark');

  // "Match device": follows prefers-color-scheme.
  await page.goto('/app/noura-salon');
  await page.locator('header button[aria-haspopup="menu"]').last().click();
  await page.getByRole('menuitemradio', { name: 'Match device' }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined();
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await bg(page, '.luma-app')).toBe('rgb(23, 17, 26)');
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await bg(page, '.luma-app')).toBe('rgb(251, 241, 246)');
});

test('accessible names are unique: colour picker vs hex field, image chooser per field', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await as(context, page, 'owner@noura.demo', baseURL!);
  await page.goto('/app/noura-salon/builder');
  await page.getByRole('tab', { name: 'Brand' }).click();
  await expect(page.getByRole('textbox', { name: 'Primary colour code (hex)', exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Primary colour picker', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Primary', exact: true })).toHaveCount(0);
  // Each image field names its own chooser.
  const choosers = page.getByRole('button', { name: /^(Choose image|Change image|Change|Choose): / });
  const names = await choosers.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(new Set(names).size).toBe(names.length);
  await choosers.first().click();
  const dialog = page.getByRole('dialog').last();
  // One "Upload" control (the hidden file input is not a second one).
  await expect(dialog.getByRole('button', { name: /^Upload/ })).toHaveCount(1);
  await expect(dialog.getByLabel(/^Upload/)).toHaveCount(0);
});

test('onboarding explains a mid-way start, marks step 1 done, and has one primary action on the last screen', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await as(context, page, 'owner@noura.demo', baseURL!);
  const slug = `ux-${Date.now().toString(36)}`;
  const r = await page.request.post('/api/v1/tenants', { headers: { 'x-luma-csrf': '1' }, data: { name: 'Polish test salon', slug, business_type: 'salon', city: 'Riyadh' } });
  expect(r.status(), await r.text()).toBe(201);
  await page.goto(`/app/${slug}/onboarding`);
  await expect(page.getByText(/You have completed 1 of 7 steps/)).toBeVisible();
  const steps = page.getByRole('list', { name: "Let's set up your storefront" });
  await expect(steps.getByRole('button', { name: /\(completed\)/ })).toHaveCount(1);
  await expect(steps.getByRole('button', { name: /\(current\)/ })).toContainText('2');
  await shot(page, '049-onboarding-resume');

  // Jump to the generate screen: before generating, Generate is the only primary action.
  for (let s = 2; s <= 7; s++) await page.getByRole('button', { name: s === 7 ? 'Finish' : 'Skip' }).click();
  const generate = page.getByRole('button', { name: /Generate/ });
  const builderLink = page.getByRole('link', { name: 'Open storefront builder' });
  await expect(generate).toHaveClass(/bg-primary/);
  await expect(builderLink).not.toHaveClass(/bg-primary/);
  await generate.click();
  await expect(builderLink).toHaveClass(/bg-primary/);
  await expect(generate).not.toHaveClass(/bg-primary/);
});

test('customer account: bookings list shows payment state; cancel dialog says "Keep booking"', async ({ page, context, baseURL }) => {
  await as(context, page, 'customer@demo.test', baseURL!);
  await page.goto('/account/bookings');
  await page.waitForLoadState('networkidle');
  // Seeded history lives in "Past"; journeys earlier in the run may add upcoming ones.
  if (!(await page.locator('main li').count())) await page.getByRole('tab', { name: 'Past' }).click();
  const first = page.locator('main li').first();
  await expect(first).toBeVisible();
  await expect(first.getByText(/^(Unpaid|Deposit paid|Partially paid|Paid|Refund pending|Partially refunded|Refunded)$/)).toBeVisible();
  await shot(page, '049-account-bookings-payment');
  await first.getByRole('link', { name: /Details/ }).click();
  const cancel = page.getByRole('button', { name: 'Cancel booking' });
  if (await cancel.count()) {
    await cancel.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Keep booking' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Keep booking' }).click();
  }
});

test('a hidden (404) resource shows "not available", not "Could not load data"', async ({ page, context, baseURL }) => {
  await as(context, page, 'owner@noura.demo', baseURL!);
  await page.route('**/api/v1/t/noura-salon/services?*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }) }));
  await page.route('**/api/v1/t/noura-salon/services', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }) }));
  await page.goto('/app/noura-salon/services');
  await expect(page.getByText('This is not available here')).toBeVisible();
  await expect(page.getByText('Could not load data')).toHaveCount(0);
});
