import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

/** Demo accounts as listed by the login page's role switcher, with where each one lands. */
export const ACCOUNTS = {
  platformOwner: { label: 'مالكة منصة لوما', lands: /\/platform\/mfa/ },
  policyReviewer: { label: 'مراجِعة السياسات', lands: /\/platform\/mfa/ },
  owner: { label: 'نورة (مالكة الصالون)', lands: /\/app\/noura-salon$/ },
  manager: { label: 'ريم (مديرة)', lands: /\/app\/noura-salon$/ },
  reception: { label: 'جود (استقبال)', lands: /\/app\/noura-salon$/ },
  specialist: { label: 'سارة (أخصائية شعر)', lands: /\/app\/noura-salon\/me$/ },
  finance: { label: 'منى (مالية)', lands: /\/app\/noura-salon$/ },
  expert: { label: 'لمار (خبيرة مكياج)', lands: /\/app\/lamar-makeup$/ },
  customer: { label: 'عميلة عادية — هيا', lands: /\/account$/ },
  restrictedCustomer: { label: 'عميلة بقرار تجريبي — دانة', lands: /\/account$/ },
  newCustomer: { label: 'عميلة جديدة — لين', lands: /\/account$/ },
} as const;

export async function english(page: Page, baseURL: string) {
  await page.context().addCookies([{ name: 'luma_locale', value: 'en', url: baseURL }]);
}

/** One-click demo sign-in from the login page; waits for the account's landing page. */
export async function demoSignIn(page: Page, account: (typeof ACCOUNTS)[keyof typeof ACCOUNTS]) {
  await page.goto('/auth/login');
  await page.getByRole('button', { name: account.label, exact: true }).click();
  await page.waitForURL(account.lands);
}

/** Fails the test on uncaught page errors. */
export function failOnPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return () => expect(errors, errors.join('\n')).toEqual([]);
}

/** Loads a page and checks it rendered: no HTTP error, no error state, no uncaught exception. */
export async function expectPageRenders(page: Page, path: string) {
  const done = failOnPageErrors(page);
  const res = await page.goto(path);
  expect(res!.status(), path).toBeLessThan(400);
  await expect(page.getByRole('main').first(), path).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('alert').filter({ hasText: /went wrong|unexpected|not found/i }), path).toHaveCount(0);
  expect(page.url(), `${path} redirected to sign-in`).not.toMatch(/\/auth\/login/);
  done();
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s): what an authenticator app shows for this secret. */
export function totp(secretB32: string, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
