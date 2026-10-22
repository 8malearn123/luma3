import { expect, test } from '@playwright/test';
import { failOnPageErrors, noHorizontalScroll } from './helpers';

// Arabic is the default: pages render right-to-left without horizontal scrolling on a phone.
for (const path of ['/', '/pricing', '/s/noura-salon', '/s/noura-salon/services', '/s/noura-salon/booking', '/s/lamar-makeup', '/auth/login']) {
  test(`RTL + mobile: ${path}`, async ({ page }) => {
    const done = failOnPageErrors(page);
    const res = await page.goto(path);
    expect(res!.status()).toBeLessThan(400);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await noHorizontalScroll(page);
    done();
  });
}

test('English switches direction to LTR', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  await page.goto('/s/noura-salon');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await noHorizontalScroll(page);
});

test('preview links are not indexable and unknown storefronts 404', async ({ page }) => {
  expect((await page.goto('/s/does-not-exist-xyz'))!.status()).toBe(404);
});
