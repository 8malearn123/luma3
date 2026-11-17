import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

/** Shared demo password the deploy build was given (tests/demo/serve.ts sets DEMO_ACCOUNT_PASSWORD). */
export const DEMO_PASSWORD = process.env.DEMO_ACCOUNT_PASSWORD ?? 'demo-e2e-password-0123';

/** Seeded demo accounts: password sign-in only on a deployed build (R3), with where each one lands. */
export const ACCOUNTS = {
  platformOwner: { email: 'admin@luma.demo', home: '/platform', lands: /\/platform\/mfa/ },
  policyReviewer: { email: 'reviewer@luma.demo', home: '/platform', lands: /\/platform\/mfa/ },
  owner: { email: 'owner@noura.demo', home: '/app/noura-salon', lands: /\/app\/noura-salon$/ },
  manager: { email: 'manager@noura.demo', home: '/app/noura-salon', lands: /\/app\/noura-salon$/ },
  reception: { email: 'reception@noura.demo', home: '/app/noura-salon', lands: /\/app\/noura-salon$/ },
  specialist: { email: 'sara@noura.demo', home: '/app/noura-salon/me', lands: /\/app\/noura-salon\/me$/ },
  finance: { email: 'finance@noura.demo', home: '/app/noura-salon', lands: /\/app\/noura-salon$/ },
  expert: { email: 'lamar@lamar.demo', home: '/app/lamar-makeup', lands: /\/app\/lamar-makeup$/ },
  customer: { email: 'customer@demo.test', home: '/account', lands: /\/account$/ },
  restrictedCustomer: { email: 'restricted@demo.test', home: '/account', lands: /\/account$/ },
  newCustomer: { email: 'new@demo.test', home: '/account', lands: /\/account$/ },
} as const;

export async function english(page: Page, baseURL: string) {
  await page.context().addCookies([{ name: 'luma_locale', value: 'en', url: baseURL }]);
}

/** Password sign-in from the login page (no one-click demo sign-in on a deployed build); waits for the landing page. */
export async function demoSignIn(page: Page, account: (typeof ACCOUNTS)[keyof typeof ACCOUNTS]) {
  await page.goto(`/auth/login?next=${encodeURIComponent(account.home)}`);
  const ar = (await page.locator('html').getAttribute('lang')) === 'ar';
  await page.getByLabel(ar ? 'البريد الإلكتروني أو رقم الجوال' : 'Email or mobile number').fill(account.email);
  await page.getByLabel(ar ? 'كلمة المرور' : 'Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: ar ? 'دخول' : 'Sign in', exact: true }).click();
  await page.waitForURL(account.lands);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the authenticator-app step in the browser tests. */
export function totp(secretBase32: string, atMs = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of secretBase32.replace(/\s+/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = h[h.length - 1]! & 0x0f;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

/** On the MFA gate of a deployed build: set up an authenticator app and confirm it (verifies the session). */
export async function enrolAuthenticator(page: Page) {
  await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
  const secret = (await page.getByTestId('mfa-secret').innerText()).replace(/\s+/g, '');
  await page.getByLabel('Verification code').fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm and enable' }).click();
  return secret;
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
  // Pages with external resources (web fonts, map embeds) may never go idle offline.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await expect(page.getByRole('alert').filter({ hasText: /went wrong|unexpected|not found/i }), path).toHaveCount(0);
  if (!path.startsWith('/auth/')) expect(page.url(), `${path} redirected to sign-in`).not.toMatch(/\/auth\/login/);
  done();
}
