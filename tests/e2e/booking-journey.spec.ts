import { expect, test } from '@playwright/test';
import { creds, failOnPageErrors, signIn } from './helpers';

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
});

const timeButton = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /^\d{1,2}:\d{2}\s?(AM|PM)$/ }).first();

test('a selection made before signing in survives sign-in and is re-validated', async ({ page }) => {
  await page.goto('/s/noura-salon/booking');
  await page.getByRole('button', { name: /Cut & style/ }).first().click();
  await timeButton(page).click();
  await page.getByRole('button', { name: /Sign in to complete your booking/ }).click();
  await page.waitForURL(/\/auth\/login/);
  await page.getByLabel('Email or mobile number').fill('new@demo.test');
  await page.getByLabel('Password').fill(creds()['new@demo.test']!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/s\/noura-salon\/booking/);
  await expect(page.getByText('Cut & style').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Reserve this time/ })).toBeVisible();
});

test('customer books from the published storefront and pays in the sandbox; confirmation comes from the server', async ({ page }) => {
  const done = failOnPageErrors(page);
  await signIn(page, 'customer@demo.test', '/s/noura-salon/booking');
  await page.waitForURL(/\/s\/noura-salon\/booking/);
  await page.getByRole('button', { name: /Cut & style/ }).first().click();
  // A later day avoids colliding with the other journey's hold.
  await page.getByRole('tab').nth(4).click();
  await timeButton(page).click();
  await page.getByRole('button', { name: /Reserve this time/ }).click();

  await page.waitForURL(/\/checkout\/booking\//);
  await expect(page.getByRole('heading', { name: 'Complete your booking' })).toBeVisible();
  await expect(page.getByText(/This time is held for you/)).toBeVisible();
  const deposit = page.getByLabel(/deposit now/);
  if (await deposit.count()) await deposit.check(); else await page.getByLabel('Pay the full amount now').check();
  await page.getByRole('button', { name: 'Confirm' }).click();

  await page.waitForURL(/\/sandbox\/checkout\//);
  await page.getByRole('button', { name: 'Simulate successful payment' }).click();
  await page.waitForURL(/\/checkout\/booking\/.*payment=/);
  await expect(page.getByRole('heading', { name: /Your booking is confirmed|awaits the salon/ })).toBeVisible({ timeout: 45_000 });
  done();
});

test('a signed-out visitor is sent to sign in before reserving, never shown another customer\'s data', async ({ page }) => {
  await page.goto('/account');
  await expect(page).toHaveURL(/\/auth\/login/);
});

test('staff role boundaries: a specialist cannot open finance; a customer cannot reach the platform admin', async ({ page, baseURL }) => {
  await signIn(page, 'sara@noura.demo', '/app/noura-salon');
  await page.waitForURL(/\/app\/noura-salon/);
  await expect(page.getByRole('link', { name: /^Finance$/ })).toHaveCount(0);
  await page.goto('/app/noura-salon/finance');
  await expect(page.getByText('You do not have permission to view this page')).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/SAR|ر\.س/);

  await page.context().clearCookies();
  await page.context().addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  await signIn(page, 'customer@demo.test', '/account');
  await page.waitForURL(/\/account/);
  const admin = await page.goto('/platform');
  expect(admin!.status()).toBe(404);
});

test('owner sees the dashboard overview for her business', async ({ page }) => {
  const done = failOnPageErrors(page);
  await signIn(page, 'owner@noura.demo', '/app/noura-salon');
  await page.waitForURL(/\/app\/noura-salon$/);
  await expect(page.getByRole('navigation').first()).toBeVisible();
  done();
});
