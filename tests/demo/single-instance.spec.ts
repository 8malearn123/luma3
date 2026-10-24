import { expect, test } from '@playwright/test';
import { ACCOUNTS, demoSignIn, english, failOnPageErrors } from './helpers';

/**
 * Multi-step journeys that write data, on one warm instance (how a single
 * visitor's requests usually reach a Vercel deployment).
 */
test.beforeEach(async ({ page, baseURL }) => english(page, baseURL!));

const timeButton = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /^\d{1,2}:\d{2}\s?(AM|PM)$/ }).first();

test('customer books a service from the storefront and pays in the sandbox; confirmation comes from the server', async ({ page }) => {
  const done = failOnPageErrors(page);
  await demoSignIn(page, ACCOUNTS.customer);
  await page.goto('/s/noura-salon/booking');
  await page.getByRole('button', { name: /Cut & style/ }).first().click();
  await page.getByRole('tab').nth(4).click();
  await timeButton(page).click();
  await page.getByRole('button', { name: /Reserve this time/ }).click();
  await page.waitForURL(/\/checkout\/booking\//);
  await expect(page.getByText(/This time is held for you/)).toBeVisible();
  const deposit = page.getByLabel(/deposit now/);
  if (await deposit.count()) await deposit.check(); else await page.getByLabel('Pay the full amount now').check();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForURL(/\/sandbox\/checkout\//);
  await page.getByRole('button', { name: 'Simulate successful payment' }).click();
  await page.waitForURL(/\/checkout\/booking\/.*payment=/);
  await expect(page.getByRole('heading', { name: /Your booking is confirmed|awaits the salon/ })).toBeVisible({ timeout: 45_000 });
  // The booking is in her account.
  await page.goto('/account/bookings');
  await expect(page.getByText(/Cut & style/).first()).toBeVisible();
  done();
});

test('customer buys a product and pays in the sandbox; the order shows as paid', async ({ page }) => {
  const done = failOnPageErrors(page);
  await demoSignIn(page, ACCOUNTS.newCustomer);
  await page.goto('/s/noura-salon/products');
  await page.getByRole('link', { name: /Nail file/ }).first().click();
  await page.waitForURL(/\/s\/noura-salon\/products\//);
  await page.getByRole('link', { name: 'Add to cart' }).or(page.getByRole('button', { name: 'Add to cart' })).first().click();
  await page.waitForURL(/\/s\/noura-salon\/cart/);
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await page.waitForURL(/\/checkout\/order\//);
  await page.getByRole('button', { name: /Pay now/ }).click();
  await page.waitForURL(/\/sandbox\/checkout\//);
  await page.getByRole('button', { name: 'Simulate successful payment' }).click();
  await page.waitForURL(/\/checkout\/order\/.*payment=/);
  await expect(page.getByRole('heading', { name: 'Paid — thank you' })).toBeVisible({ timeout: 45_000 });
  done();
});

test('reception sees a new booking in the salon dashboard', async ({ page, baseURL }) => {
  await demoSignIn(page, ACCOUNTS.customer);
  await page.goto('/s/noura-salon/booking');
  await page.getByRole('button', { name: /Cut & style/ }).first().click();
  await page.getByRole('tab').nth(5).click();
  await timeButton(page).click();
  await page.getByRole('button', { name: /Reserve this time/ }).click();
  await page.waitForURL(/\/checkout\/booking\//);
  const number = (await page.getByText(/^BKG-\d+$/).first().textContent())!.trim();

  await page.context().clearCookies();
  await english(page, baseURL!);
  await demoSignIn(page, ACCOUNTS.reception);
  await page.goto('/app/noura-salon/bookings');
  await page.waitForLoadState('networkidle');
  await page.getByRole('searchbox').or(page.getByPlaceholder(/search/i)).first().fill(number).catch(() => {});
  await expect(page.getByText(number).first()).toBeVisible();
});
