import { expect, test } from '@playwright/test';
import { failOnPageErrors, signIn } from './helpers';

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
});

const OWNER_PAGES = ['', '/bookings', '/bookings?view=calendar', '/services', '/team', '/finance', '/waitlist', '/groups', '/loyalty', '/gifts', '/memberships', '/settings?tab=payments', '/products', '/orders', '/inventory', '/customers', '/policies', '/marketing', '/analytics', '/builder', '/settings', '/audit'];

test('owner dashboard pages render without errors', async ({ page }) => {
  await signIn(page, 'owner@noura.demo', '/app/noura-salon');
  await page.waitForURL(/\/app\/noura-salon/);
  for (const p of OWNER_PAGES) {
    const done = failOnPageErrors(page);
    const res = await page.goto(`/app/noura-salon${p}`);
    expect(res!.status(), p).toBeLessThan(400);
    await expect(page.getByRole('main').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('alert').filter({ hasText: /went wrong|unexpected/i })).toHaveCount(0);
    done();
  }
});

test('specialist portal shows her own day without money fields', async ({ page }) => {
  const done = failOnPageErrors(page);
  await signIn(page, 'sara@noura.demo', '/app/noura-salon/me');
  await page.waitForURL(/\/app\/noura-salon\/me/);
  await expect(page.getByRole('main').first()).toBeVisible();
  await page.goto('/app/noura-salon/bookings');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('main')).not.toContainText(/SAR|ر\.س/);
  done();
});

test('platform staff pass a WhatsApp code before using the admin area', async ({ page }) => {
  await signIn(page, 'admin@luma.demo', '/platform');
  await page.waitForURL(/\/platform\/mfa/);
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  // No WhatsApp provider is connected: this build shows the code on screen instead of sending it.
  const code = (await page.locator('[role=status] p.font-mono').textContent())!.trim();
  await page.getByLabel('Verification code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL(/\/platform$/);
  await expect(page.getByRole('main').first()).toBeVisible();
});

test('customer account pages render', async ({ page }) => {
  await signIn(page, 'restricted@demo.test', '/account');
  await page.waitForURL(/\/account/);
  for (const p of ['', '/bookings', '/orders', '/policy', '/privacy', '/security', '/reviews']) {
    const done = failOnPageErrors(page);
    const res = await page.goto(`/account${p}`);
    expect(res!.status(), p).toBeLessThan(400);
    done();
  }
  // The experimental decision is explained to her, with the appeal route.
  await page.goto('/account/policy');
  await expect(page.locator('main')).toContainText(/prepayment|appeal/i);
});
