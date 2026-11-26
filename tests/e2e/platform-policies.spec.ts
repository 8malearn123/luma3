import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { creds, failOnPageErrors, signIn } from './helpers';
import { freshTotp } from './totp';

/**
 * Platform administration end to end (verification workstream): platform staff
 * sign in with password + TOTP (the factor that works on every build), the
 * admin area is refused (`mfa_required`) until the second factor is passed,
 * businesses/plans/integrations render, and the policy cycle works in the UI:
 * criterion → LUMA decision (step-up) → customer appeal from /account/policy →
 * reviewer resolves it → decision revoked; a second decision is ended early.
 */
test.describe.configure({ mode: 'serial' });

const EVIDENCE = 'docs/remediation/evidence/verify';
const shot = async (page: Page, name: string) => { if (process.env.E2E_EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/${name}.png` }); };

async function englishPage(browser: Browser, baseURL: string) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL }]);
  return ctx.newPage();
}

/** Answers the password step-up dialog if the server asks for it (it may not, right after sign-in). */
async function stepUpIfAsked(page: Page, email: string) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  try { await dialog.waitFor({ state: 'visible', timeout: 4_000 }); } catch { return; }
  await dialog.getByLabel(/Password/).fill(creds()[email]!);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
}

/** Signs a platform user in and enrols an authenticator app from the MFA gate; returns the TOTP secret. */
async function signInWithTotp(page: Page, email: string, next: string) {
  await signIn(page, email, next);
  await page.waitForURL(/\/platform\/mfa/);
  await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
  await stepUpIfAsked(page, email);
  const secret = (await page.getByTestId('mfa-secret').textContent())!.replace(/\s+/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByLabel('Verification code').fill(await freshTotp(secret));
  await page.getByRole('button', { name: 'Confirm and enable' }).click();
  await page.waitForURL((u) => u.pathname === next);
  return secret;
}

let customerId = '';
let admin: Page;
let reviewer: Page;
let shopper: Page;
const APPEAL = 'I attended every appointment this year; please review this requirement.';

test.beforeAll(async ({ browser, baseURL }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  shopper = await englishPage(browser, baseURL!);
  await signIn(shopper, 'new@demo.test', '/account');
  await shopper.waitForURL(/\/account/);
  customerId = (await (await shopper.request.get('/api/v1/auth/session')).json()).data.user.id;
  expect(customerId).toMatch(/^[0-9a-f-]{36}$/);
});

test('a password-only platform session gets mfa_required; TOTP enrolment opens the admin area', async ({ browser, baseURL }) => {
  admin = await englishPage(browser, baseURL!);
  const done = failOnPageErrors(admin);
  await signIn(admin, 'admin@luma.demo', '/platform');
  await admin.waitForURL(/\/platform\/mfa/);
  // The browser's session cookie alone is not enough for the admin API.
  const blocked = await admin.request.get('/api/v1/platform/overview');
  expect(blocked.status()).toBe(403);
  expect((await blocked.json()).error.code).toBe('mfa_required');
  // Navigating anywhere in the admin area returns to the second-factor gate.
  await admin.goto('/platform/policies');
  await admin.waitForURL(/\/platform\/mfa/);
  await expect(admin.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await shot(admin, 'platform-mfa-gate-en');

  await admin.goto('/platform/mfa?next=%2Fplatform');
  await admin.getByRole('button', { name: 'Set up an authenticator app' }).click();
  await stepUpIfAsked(admin, 'admin@luma.demo');
  const secret = (await admin.getByTestId('mfa-secret').textContent())!.replace(/\s+/g, '');
  await admin.getByLabel('Verification code').fill(await freshTotp(secret));
  await admin.getByRole('button', { name: 'Confirm and enable' }).click();
  await admin.waitForURL(/\/platform$/);
  expect((await admin.request.get('/api/v1/platform/overview')).status()).toBe(200);
  done();
});

test('businesses, plans and integrations render for the platform owner; providers report their real status', async () => {
  const done = failOnPageErrors(admin);
  for (const p of ['/platform/tenants', '/platform/plans', '/platform/integrations']) {
    const res = await admin.goto(p);
    expect(res!.status(), p).toBeLessThan(400);
    await expect(admin.getByRole('main').first()).toBeVisible();
  }
  await admin.goto('/platform/tenants');
  await expect(admin.getByRole('main')).toContainText(/الروشة|noura-salon/);
  await admin.goto('/platform/integrations');
  await admin.waitForLoadState('networkidle');
  await shot(admin, 'platform-integrations-en');
  // Evidence for the provider-status check: what the server itself reports.
  const st = (await (await admin.request.get('/api/v1/platform/integrations')).json()).data;
  if (process.env.E2E_EVIDENCE) writeFileSync(`${EVIDENCE}/integrations-status.json`, JSON.stringify({ messaging: st.messaging, ai: { status: st.ai.status }, payments: { live_accounts: st.payments.live_accounts, sandbox_accounts: st.payments.sandbox_accounts, accounts: st.payments.accounts }, storage: st.storage }, null, 2));
  expect(st.payments.live_accounts).toBe(0);
  expect(st.ai.status.state).toBe('disconnected'); // no AI key in this environment
  for (const ch of ['email', 'sms', 'whatsapp']) expect(st.messaging[ch]).not.toBe('connected');
  done();
});

test('policies: create a LUMA criterion; the escalations list renders', async () => {
  const done = failOnPageErrors(admin);
  await admin.goto('/platform/policies');
  await expect(admin.getByRole('heading', { name: 'Policy review — LUMA' })).toBeVisible();
  // Escalations tab (default): the list or its empty state, with the status filter.
  await expect(admin.getByRole('tab', { name: 'Escalated incidents' })).toHaveAttribute('aria-selected', 'true');
  await expect(admin.getByLabel('Status')).toBeVisible();
  await expect(admin.getByText('Nothing here').or(admin.getByRole('button', { name: 'No action' }).first())).toBeVisible();

  await admin.getByRole('tab', { name: 'LUMA criteria' }).click();
  await admin.getByRole('button', { name: 'New criterion' }).click();
  await admin.getByLabel(/^Key/).fill('e2e.no_show.three');
  await admin.getByLabel(/^Description/).fill('Three confirmed no-shows in 90 days');
  await admin.getByLabel(/^Incident type/).selectOption('no_show');
  await admin.getByLabel(/^Minimum confirmed incidents/).fill('3');
  await admin.getByLabel(/^Within \(days\)/).fill('90');
  await admin.getByRole('button', { name: 'Create', exact: true }).click();
  await stepUpIfAsked(admin, 'admin@luma.demo');
  await expect(admin.getByText('e2e.no_show.three')).toBeVisible();
  await expect(admin.getByText('3+ confirmed incidents within 90 days').first()).toBeVisible();
  done();
});

async function createDecision(page: Page, explanation: string) {
  await page.goto('/platform/policies');
  await page.getByRole('button', { name: 'Create decision' }).click();
  const drawer = page.getByRole('dialog', { name: 'Create decision' });
  await drawer.getByLabel(/^Customer account ID/).fill(customerId);
  await drawer.getByLabel(/^Action/).selectOption('require_deposit');
  await drawer.getByLabel(/^Internal reason/).fill('E2E verification: repeated late cancellations reported');
  await drawer.getByLabel(/^Explanation for the customer \(English\)/).fill(explanation);
  await drawer.getByRole('button', { name: 'Save' }).click();
  await stepUpIfAsked(page, 'admin@luma.demo');
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('tab', { name: 'LUMA decisions' })).toHaveAttribute('aria-selected', 'true');
}

test('LUMA decision (step-up) → customer appeals from /account/policy → reviewer accepts → decision revoked', async ({ browser, baseURL }) => {
  const done = failOnPageErrors(admin);
  await createDecision(admin, 'A deposit is required for LUMA bookings for now.');
  await expect(admin.getByText('E2E verification: repeated late cancellations reported').first()).toBeVisible();

  // The customer sees the effect and explanation (never the internal reason) and asks for a review.
  await shopper.goto('/account/policy');
  await expect(shopper.getByText('A deposit is required for LUMA bookings for now.')).toBeVisible();
  await expect(shopper.locator('main')).not.toContainText('repeated late cancellations');
  await shopper.getByRole('button', { name: 'Request a review' }).first().click();
  // The shared Dialog has an accessible name from its title (aria-labelledby).
  const dialog = shopper.getByRole('dialog', { name: /Request a review: Deposit required/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/Explain why you are asking for a review/).fill(APPEAL);
  await shot(shopper, 'account-policy-appeal-dialog-en');
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(dialog).toBeHidden();
  await expect(shopper.getByText(APPEAL)).toBeVisible();

  // A policy reviewer (her own MFA) resolves it.
  reviewer = await englishPage(browser, baseURL!);
  const rdone = failOnPageErrors(reviewer);
  await signInWithTotp(reviewer, 'reviewer@luma.demo', '/platform/policies');
  await reviewer.getByRole('tab', { name: 'Review requests' }).click();
  const card = reviewer.locator('li', { hasText: APPEAL });
  await expect(card).toBeVisible();
  await card.getByLabel(/^Outcome/).selectOption('accepted');
  await card.getByLabel(/^Reply to the customer/).fill('Reviewed: the requirement is removed. Thank you.');
  await card.getByRole('button', { name: 'Send decision' }).click();
  await stepUpIfAsked(reviewer, 'reviewer@luma.demo');
  await expect(card.getByRole('button', { name: 'Send decision' })).toBeHidden();
  await shot(reviewer, 'platform-appeal-resolved-en');
  rdone();

  // The customer sees the reply; the decision no longer applies.
  await shopper.reload();
  await expect(shopper.getByText('Reviewed: the requirement is removed. Thank you.')).toBeVisible();
  const pol = (await (await shopper.request.get('/api/v1/account/policy')).json()).data;
  expect(pol.decisions.filter((d: { status: string }) => d.status === 'active')).toEqual([]);
  done();
});

test('a second LUMA decision is ended early with a reason', async () => {
  const done = failOnPageErrors(admin);
  await createDecision(admin, 'Temporary deposit requirement.');
  // Only the new one is active for this customer (the first was revoked on appeal).
  const row = admin.locator('li', { hasText: 'E2E verification' }).first();
  await row.getByRole('button', { name: 'End now' }).click();
  await admin.getByLabel(/^Reason for ending/).fill('E2E: ended early after review');
  await admin.getByRole('button', { name: 'End now' }).last().click();
  await stepUpIfAsked(admin, 'admin@luma.demo');
  await expect(row.getByRole('button', { name: 'End now' })).toBeHidden();
  await admin.getByLabel('Status').selectOption('expired');
  await expect(admin.locator('li', { hasText: 'E2E verification' }).first()).toBeVisible();
  const pol = (await (await shopper.request.get('/api/v1/account/policy')).json()).data;
  expect(pol.decisions.filter((d: { status: string }) => d.status === 'active')).toEqual([]);
  done();
});
