import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { failOnPageErrors, signIn } from './helpers';

/**
 * Freelancer storefront customization (verification workstream): the expert
 * (lamar-makeup) changes a brand colour, the heading font and her hero section
 * in the builder, publishes, and the public storefront computes the new styles
 * — while another business's storefront (noura-salon) is untouched. Also the
 * natural-language assistant without an AI provider: it says plainly that it
 * is not connected, cannot be used, and nothing is proposed or applied.
 */
test.describe.configure({ mode: 'serial' });

const EVIDENCE = 'docs/remediation/evidence/verify';
const NEW_PRIMARY = '#1F6F5C';
const NEW_TITLE = 'لمسات لمار — تجربة التخصيص';

type Theme = { primary: string; heading: string; buttonBg: string | null; h1Font: string; h1: string };
async function storefrontTheme(browser: Browser, baseURL: string, slug: string): Promise<Theme> {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const res = await page.goto(`/s/${slug}`);
  expect(res!.status()).toBeLessThan(400);
  const theme = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[style*="--sf-primary"]')!;
    const cs = getComputedStyle(root);
    const btn = document.querySelector<HTMLElement>('.bg-sf-primary');
    const h1 = document.querySelector('h1')!;
    return {
      primary: cs.getPropertyValue('--sf-primary').trim().toUpperCase(), heading: cs.getPropertyValue('--sf-font-heading').trim(),
      buttonBg: btn ? getComputedStyle(btn).backgroundColor : null, h1Font: getComputedStyle(h1).fontFamily, h1: h1.textContent ?? '',
    };
  });
  if (slug === 'lamar-makeup') { mkdirSync(EVIDENCE, { recursive: true }); await page.screenshot({ path: `${EVIDENCE}/lamar-storefront-customized.png` }); }
  await ctx.close();
  return theme;
}

let owner: Page;
let nouraBefore: Theme;
let lamarBefore: Theme;

test.beforeAll(async ({ browser, baseURL }) => {
  nouraBefore = await storefrontTheme(browser, baseURL!, 'noura-salon');
  lamarBefore = await storefrontTheme(browser, baseURL!, 'lamar-makeup');
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  owner = await ctx.newPage();
  await signIn(owner, 'lamar@lamar.demo', '/app/lamar-makeup/builder');
  await owner.waitForURL(/\/app\/lamar-makeup\/builder/);
});

test('the expert changes colour, heading font and her hero section, publishes; only her storefront changes', async ({ browser, baseURL }) => {
  const done = failOnPageErrors(owner);
  expect(lamarBefore.primary).not.toBe(NEW_PRIMARY);
  await expect(owner.getByRole('button', { name: 'Publish' })).toBeVisible();

  // A section: the hero title (first block of the home page).
  await owner.locator('[data-block-id]').first().click();
  await owner.getByLabel('Title', { exact: true }).fill(NEW_TITLE);

  // Brand: primary colour and heading font.
  await owner.getByRole('tab', { name: 'Brand' }).click();
  await owner.getByLabel('Primary colour code (hex)', { exact: true }).fill(NEW_PRIMARY);
  await owner.getByLabel('Heading font').selectOption('el_messiri');
  await expect(owner.getByText(/Last saved/)).toBeVisible({ timeout: 20_000 });

  await owner.getByRole('button', { name: 'Publish' }).click();
  const drawer = owner.getByRole('dialog', { name: 'Publish storefront' });
  await expect(drawer.getByText('Nothing blocks publishing.')).toBeVisible({ timeout: 30_000 });
  await drawer.getByRole('button', { name: 'Publish now' }).click();
  await expect(owner.getByText(/Version \d+ published/)).toBeVisible({ timeout: 30_000 });
  await owner.screenshot({ path: `${EVIDENCE}/lamar-builder-published-en.png` });

  const lamar = await storefrontTheme(browser, baseURL!, 'lamar-makeup');
  expect(lamar.primary).toBe(NEW_PRIMARY);
  expect(lamar.heading).toContain('El Messiri');
  expect(lamar.h1Font).toContain('El Messiri');
  expect(lamar.h1).toContain(NEW_TITLE);
  if (lamar.buttonBg) expect(lamar.buttonBg).toBe('rgb(31, 111, 92)');

  // Another business's storefront is not affected.
  const noura = await storefrontTheme(browser, baseURL!, 'noura-salon');
  expect(noura).toEqual(nouraBefore);
  expect(noura.primary).not.toBe(NEW_PRIMARY);
  done();
});

test('natural-language assistant without an AI provider: honestly "Not connected", nothing proposed or applied', async () => {
  const done = failOnPageErrors(owner);
  const draftBefore = await (await owner.request.get('/api/v1/t/lamar-makeup/builder')).json();
  await owner.goto('/app/lamar-makeup/builder');
  await owner.getByRole('tab', { name: 'Assistant' }).click();
  const planOff = owner.getByText('Not included in your plan');
  const off = owner.getByText('Not connected', { exact: true });
  await expect(planOff.or(off)).toBeVisible();
  if (await off.isVisible()) {
    await expect(owner.getByText('The AI assistant is not configured right now (no API key or model). The manual builder works fully.')).toBeVisible();
    await expect(owner.locator('#assistant-req')).toBeDisabled();
  }
  await owner.screenshot({ path: `${EVIDENCE}/builder-assistant-not-connected-en.png` });

  // The server refuses as well (a direct call cannot fake a proposal).
  const r = await owner.request.post('/api/v1/t/lamar-makeup/builder/proposals', { headers: { 'x-luma-csrf': '1' }, data: { request_text: 'Make the buttons pink and move reviews to the top' } });
  const body = await r.json();
  expect([403, 503]).toContain(r.status());
  expect(['ai_unavailable', 'plan_feature_unavailable']).toContain(body.error.code);
  const proposals = await (await owner.request.get('/api/v1/t/lamar-makeup/builder/proposals')).json();
  expect(proposals.data ?? []).toEqual([]);
  const draftAfter = await (await owner.request.get('/api/v1/t/lamar-makeup/builder')).json();
  expect(draftAfter.data.brand).toEqual(draftBefore.data.brand);
  done();
});
