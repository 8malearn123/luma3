import { expect, test } from '@playwright/test';
import { ACCOUNTS, demoSignIn, english, enrolAuthenticator, expectPageRenders } from './helpers';

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

test('deployed build (R3): no one-click demo sign-in, no code exposure, honest unavailable registration/recovery', async ({ page, request }) => {
  await page.goto('/auth/login');
  await expect(page.getByText('Role switcher', { exact: false })).toHaveCount(0);
  expect((await request.get('/api/v1/demo/users')).status()).toBe(404);
  expect((await request.get('/api/v1/auth/dev-outbox?destination=admin%40luma.demo')).status()).toBe(404);
  const rec = await request.post('/api/v1/auth/recovery/request', { headers: { 'x-luma-csrf': '1' }, data: { identifier: 'owner@noura.demo' } });
  expect(JSON.stringify(await rec.json())).not.toContain('dev_code');
  await page.goto('/auth/recover');
  await expect(page.getByText('Password recovery is not available here')).toBeVisible();
  await page.goto('/auth/register');
  await expect(page.getByText('Creating accounts is not available here')).toBeVisible();
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
  for (const p of ['', '/bookings', '/orders', '/policy', '/privacy', '/security', '/reviews']) await expectPageRenders(page, `/account${p}`);
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

test('platform staff: no fixed demo code on a deployed build; an authenticator app verifies the session, then the whole admin area opens on every instance', async ({ page, request }) => {
  await demoSignIn(page, ACCOUNTS.platformOwner);
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  // No WhatsApp provider: no send button; the old fixed demo code is refused by the server.
  await expect(page.getByRole('button', { name: 'Send code on WhatsApp' })).toHaveCount(0);
  const cookies = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const fixed = await request.post('/api/v1/platform/mfa/verify', { headers: { 'x-luma-csrf': '1', cookie: cookies }, data: { code: '2002' } });
  expect(fixed.status()).toBe(422);
  await enrolAuthenticator(page);
  await page.waitForURL(/\/platform$/);
  // Every following request alternates instance: none asks for the code again.
  for (const path of PLATFORM_PAGES) {
    await expectPageRenders(page, `/platform${path}`);
    expect(page.url(), path).not.toMatch(/\/platform\/mfa/);
  }
});

test('policy reviewer: verifies with an authenticator app, then her admin pages open', async ({ page }) => {
  await demoSignIn(page, ACCOUNTS.policyReviewer);
  await enrolAuthenticator(page);
  await page.waitForURL(/\/platform$/);
  for (const path of ['', '/policies']) await expectPageRenders(page, `/platform${path}`);
});
