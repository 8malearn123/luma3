import { expect, test } from '@playwright/test';
import { failOnPageErrors, signIn } from './helpers';

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
});

test('customer adds a product to the cart, checks out and pays in the sandbox; the order shows as paid', async ({ page }) => {
  const done = failOnPageErrors(page);
  await signIn(page, 'customer@demo.test', '/s/noura-salon/products');
  await page.waitForURL(/\/s\/noura-salon\/products/);
  await page.getByRole('link', { name: /Nail file/ }).first().click();
  await page.waitForURL(/\/s\/noura-salon\/products\//);
  await page.getByRole('link', { name: 'Add to cart' }).or(page.getByRole('button', { name: 'Add to cart' })).first().click();
  await page.waitForURL(/\/s\/noura-salon\/cart/);
  await expect(page.getByText('Nail file').first()).toBeVisible();
  await page.getByRole('button', { name: 'Continue to payment' }).click();

  await page.waitForURL(/\/checkout\/order\//);
  await expect(page.getByRole('heading', { name: 'Complete your order' })).toBeVisible();
  await page.getByRole('button', { name: /Pay now/ }).click();
  await page.waitForURL(/\/sandbox\/checkout\//);
  await page.getByRole('button', { name: 'Simulate successful payment' }).click();
  await page.waitForURL(/\/checkout\/order\/.*payment=/);
  await expect(page.getByRole('heading', { name: 'Paid — thank you' })).toBeVisible({ timeout: 45_000 });
  done();
});
