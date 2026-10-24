import { expect, test } from '@playwright/test';
import { ACCOUNTS, demoSignIn, english } from './helpers';

/** Phone layout (RTL, Arabic): the demo switcher and dashboards fit the screen. */
async function noHorizontalScroll(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('Arabic, phone: login with the demo switcher, owner dashboard and storefront fit the screen', async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: 'luma_locale', value: 'ar', url: baseURL! }]);
  await page.goto('/auth/login');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await noHorizontalScroll(page);
  await demoSignIn(page, ACCOUNTS.owner);
  await noHorizontalScroll(page);
  await page.goto('/s/noura-salon');
  await noHorizontalScroll(page);
});

test('English, phone: customer account', async ({ page, baseURL }) => {
  await english(page, baseURL!);
  await demoSignIn(page, ACCOUNTS.customer);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await noHorizontalScroll(page);
});
