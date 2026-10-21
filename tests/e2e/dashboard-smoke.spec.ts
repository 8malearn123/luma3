import { expect, test } from '@playwright/test';
import { failOnPageErrors, signIn } from './helpers';

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
});

const OWNER_PAGES = ['', '/products', '/orders', '/inventory', '/customers', '/policies', '/marketing', '/analytics', '/builder', '/settings', '/audit'];

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

test('platform staff must set up MFA before using the admin area', async ({ page }) => {
  await signIn(page, 'admin@luma.demo', '/platform');
  await page.waitForURL(/\/platform\/mfa/);
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
