import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { creds, failOnPageErrors, signIn } from './helpers';

/**
 * LUMA-AUDIT-005: owner invites → invitee opens the link signed out → signs in
 * (returns to the invitation) → accepts → lands in the business dashboard with
 * the invited role. Also: a different signed-in account cannot use the link.
 */

const EVIDENCE = 'docs/remediation/evidence/sec';
const shot = async (page: Page, name: string) => {
  if (process.env.SAVE_EVIDENCE !== '1') return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}/${name}.png` });
};

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
});

test('staff invitation: owner invites, invitee signs in from the link and joins with the role', async ({ page, context, baseURL }) => {
  test.setTimeout(180_000);
  const done = failOnPageErrors(page);
  await page.setViewportSize({ width: 1100, height: 800 });

  // 1. Owner invites an existing, verified account as receptionist.
  await signIn(page, 'owner@noura.demo', '/app/noura-salon/team?tab=members');
  await page.waitForURL(/\/app\/noura-salon\/team/);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await page.getByLabel('Email or mobile number').fill('new@demo.test');
  await page.getByLabel('Role').selectOption('receptionist');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  const link = (await page.getByTestId('invite-link').innerText()).trim();
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  await shot(page, 'invite-01-owner-link');
  const path = new URL(link).pathname;

  // 2. A different signed-in account cannot use it.
  await context.clearCookies();
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  await signIn(page, 'customer@demo.test', path);
  await page.waitForURL(new RegExp(path));
  await expect(page.getByText(/this invitation is for ne\*\*\*@demo\.test/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
  await shot(page, 'invite-02-wrong-account');

  // 3. Invitee opens the link signed out → sign in → back on the invitation → accept.
  await context.clearCookies();
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  await page.goto(path);
  await expect(page.getByTestId('invite-intro')).toContainText('invited you to join their team as: Receptionist');
  await shot(page, 'invite-03-signed-out');
  await page.getByRole('link', { name: 'Sign in to accept' }).click();
  await page.waitForURL(/\/auth\/login/);
  await page.getByLabel('Email or mobile number').fill('new@demo.test');
  await page.getByLabel('Password').fill(creds()['new@demo.test']!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(new RegExp(path));
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await page.waitForURL(/\/app\/noura-salon$/);
  await expect(page.getByRole('main').first()).toBeVisible();
  await shot(page, 'invite-04-joined-dashboard');

  const s = await page.request.get('/api/v1/auth/session');
  const memberships = (await s.json()).data.memberships as Array<{ tenant_slug: string; role: string }>;
  expect(memberships).toContainEqual(expect.objectContaining({ tenant_slug: 'noura-salon', role: 'receptionist' }));

  // 4. The link is single-use.
  await page.goto(path);
  await expect(page.getByText('This invitation has already been used.')).toBeVisible();
  done();
});
