import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export const creds = (): Record<string, string> => JSON.parse(readFileSync('.e2e/credentials.json', 'utf8'));

export async function useEnglish(page: Page) {
  await page.context().addCookies([{ name: 'luma_locale', value: 'en', url: page.url().startsWith('http') ? page.url() : 'http://localhost:3110' }]);
}

export async function signIn(page: Page, email: string, next?: string) {
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
