import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

export const creds = (): Record<string, string> => JSON.parse(readFileSync('.e2e/credentials.json', 'utf8'));

export async function useEnglish(page: Page) {
  await page.context().addCookies([{ name: 'luma_locale', value: 'en', url: page.url().startsWith('http') ? page.url() : `http://localhost:${process.env.E2E_PORT ?? 3110}` }]);
}

/**
 * One client address per spec file. The whole suite runs from localhost, so
 * every sign-in used to count against ONE address's sign-in limit
 * (LOGIN_LIMITS.ipAttempts: 30 per 15 min) and later files failed with "Too
 * many attempts". `next start` takes the client address from X-Forwarded-For
 * as a deployment proxy would set it, so each file now signs in as its own
 * client; the limit itself is unchanged (and still applies within a file).
 */
function clientAddressForFile() {
  let file = 'e2e';
  try { file = test.info().file; } catch { /* outside a test: shared address */ }
  const h = createHash('sha256').update(file).digest();
  return `10.${h[0]}.${h[1]}.${(h[2]! % 250) + 1}`;
}

export async function signIn(page: Page, email: string, next?: string) {
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': clientAddressForFile() });
  await page.goto(`/auth/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  await page.getByLabel('Email or mobile number').fill(email);
  await page.getByLabel('Password').fill(creds()[email]!);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Fails the test on uncaught page errors (console noise from the dev overlay is ignored). */
export function failOnPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return () => expect(errors, errors.join('\n')).toEqual([]);
}

export async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}
