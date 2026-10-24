import { expect, test } from '@playwright/test';
import { ACCOUNTS, demoSignIn, english, expectPageRenders, totp } from './helpers';

/**
 * Every request alternates between two server instances that each hold their
 * own copy of the demo data (separate serverless instances on Vercel). Signing
 * in and everything a demo user reads must work regardless of the instance.
 */
test.beforeEach(async ({ page, baseURL }) => english(page, baseURL!));

const OWNER_PAGES = ['', '/bookings', '/bookings?view=calendar', '/services', '/team', '/finance', '/waitlist', '/groups', '/loyalty', '/gifts', '/memberships', '/settings?tab=payments', '/products', '/orders', '/inventory', '/customers', '/policies', '/marketing', '/analytics', '/builder', '/settings', '/audit'];
const PLATFORM_PAGES = ['', '/tenants', '/users', '/subscriptions', '/plans', '/policies', '/reports', '/support', '/templates', '/integrations', '/ai-usage', '/audit', '/security'];

test('public pages render without signing in', async ({ page }) => {
  for (const p of ['/', '/pricing', '/s/noura-salon', '/s/noura-salon/booking', '/s/noura-salon/products', '/s/lamar-makeup', '/auth/login']) {
    await expectPageRenders(page, p);
  }
});

test('the login page lists every demo account', async ({ page }) => {
  await page.goto('/auth/login');
  for (const a of Object.values(ACCOUNTS)) await expect(page.getByRole('button', { name: a.label, exact: true })).toBeVisible();
});

for (const [key, account] of Object.entries(ACCOUNTS)) {
  test(`demo sign-in: ${key} lands on its dashboard and stays signed in on every instance`, async ({ page }) => {
    await demoSignIn(page, account);
    await expect(page.getByRole('main').first()).toBeVisible();
    // Several more requests: each alternates instance, none may sign the user out.
    for (let i = 0; i < 4; i++) {
      await page.reload();
      await expect(page).toHaveURL(account.lands);
    }
  });
}

test('salon owner: every dashboard page renders', async ({ page }) => {
  await demoSignIn(page, ACCOUNTS.owner);
  for (const p of OWNER_PAGES) await expectPageRenders(page, `/app/noura-salon${p}`);
});

test('manager, reception and finance: their dashboards render', async ({ page, baseURL }) => {
  for (const account of [ACCOUNTS.manager, ACCOUNTS.reception, ACCOUNTS.finance]) {
    await page.context().clearCookies();
    await english(page, baseURL!);
    await demoSignIn(page, account);
    for (const p of ['', '/bookings']) await expectPageRenders(page, `/app/noura-salon${p}`);
  }
});

test('independent expert: her dashboard renders', async ({ page }) => {
  await demoSignIn(page, ACCOUNTS.expert);
  for (const p of ['', '/bookings', '/services', '/finance', '/builder']) await expectPageRenders(page, `/app/lamar-makeup${p}`);
});

test('specialist: her own portal, no money, no finance', async ({ page }) => {
  await demoSignIn(page, ACCOUNTS.specialist);
  await expectPageRenders(page, '/app/noura-salon/me');
  await page.goto('/app/noura-salon/bookings');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('main')).not.toContainText(/SAR|ر\.س/);
  await page.goto('/app/noura-salon/finance');
  await expect(page.getByText('You do not have permission to view this page')).toBeVisible();
});

test('customers: account pages render; the admin area is hidden from them', async ({ page }) => {
  await demoSignIn(page, ACCOUNTS.restrictedCustomer);
  for (const p of ['', '/bookings', '/orders', '/policy', '/privacy', '/security', '/reviews', '/waitlist']) await expectPageRenders(page, `/account${p}`);
  const admin = await page.goto('/platform');
  expect(admin!.status()).toBe(404);
  const salon = await page.goto('/app/noura-salon/finance');
  expect(salon!.status()).toBeGreaterThanOrEqual(400);
});

test('signed-out visitors are sent to sign in', async ({ page }) => {
  for (const p of ['/account', '/app/noura-salon', '/platform']) {
    await page.goto(p);
    await expect(page, p).toHaveURL(/\/auth\/login/);
  }
});

test('platform owner: sets up two-step verification at first sign-in, then the whole admin area works on every instance', async ({ browser, baseURL }) => {
  // Setting up MFA is a few requests in a row: on Vercel they reach the same warm instance.
  const setup = await browser.newContext({ extraHTTPHeaders: { 'x-demo-route': 'sticky' }, locale: 'en-US' });
  const page = await setup.newPage();
  await english(page, baseURL!);
  await demoSignIn(page, ACCOUNTS.platformOwner);
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await page.getByRole('button', { name: 'Start setup' }).click();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.replace(/\s/g, '');
  await page.getByLabel('Verification code').fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm and enable' }).click();
  await page.waitForURL(/\/platform$/);

  // The same browser session, now alternating instances: every admin page opens without asking again.
  const roaming = await browser.newContext({ storageState: await setup.storageState(), locale: 'en-US' });
  const p2 = await roaming.newPage();
  for (const path of PLATFORM_PAGES) {
    await expectPageRenders(p2, `/platform${path}`);
    expect(p2.url(), path).not.toMatch(/\/platform\/mfa/);
  }
  await setup.close();
  await roaming.close();
});
