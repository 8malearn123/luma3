import { expect, test, type Page } from '@playwright/test';
import { failOnPageErrors, signIn } from './helpers';

/**
 * Remediation journeys (2026-11): Loom owner experience (LUMA-AUDIT-021/022/
 * 023/024/038/039/043) and the freelancer workspace (LUMA-AUDIT-014, R5).
 * The web server runs the job worker (tests/e2e/serve.ts), so analyses complete.
 */
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
});

const main = (page: Page) => page.getByRole('main').first();
const RAW = /ev_[0-9a-f]{6}|@item:|@offering:|"metric_key"|\{"/;

/** Evidence screenshots are committed; refresh them only on purpose (E2E_EVIDENCE=1), never on every run. */
const evidence = async (page: import('@playwright/test').Page, path: string) => { if (process.env.E2E_EVIDENCE === '1') await page.screenshot({ path }); };

test('Loom: primary tabs first, analysis status is real and an analysis completes through the worker', async ({ page }) => {
  const done = failOnPageErrors(page);
  await signIn(page, 'owner@noura.demo', '/app/noura-salon/marketing');
  await page.waitForURL(/\/marketing/);
  const tabs = page.getByRole('tablist').first().getByRole('tab');
  await expect(tabs).toHaveText(['Home', 'Monthly plans', 'Weekly plans', 'Ongoing opportunities', 'Trends & evidence', 'Results', 'Campaigns', 'Loom setup', 'Advanced']);

  await page.goto('/app/noura-salon/marketing?tab=advanced&section=status');
  await expect(page.getByTestId('loom-latest-analysis')).toContainText('Latest analysis: Succeeded');
  await expect(main(page)).not.toContainText('No analyses yet');
  const analysisRows = page.getByRole('row').filter({ hasText: 'Business data analysis' });
  const before = await analysisRows.count();
  expect(before).toBeGreaterThan(0);

  await page.getByRole('tab', { name: 'Ongoing opportunities' }).click();
  await page.getByRole('button', { name: 'Analyse now' }).click();
  await page.goto('/app/noura-salon/marketing?tab=advanced&section=status');
  // LUMA-AUDIT-043: the worker picks the job up and it succeeds.
  await expect(analysisRows.filter({ hasText: 'Succeeded' })).toHaveCount(before + 1, { timeout: 90_000 });
  await evidence(page, 'docs/remediation/evidence/loom/loom-analysis-status-en.png');
  done();
});

test('Loom: plans and opportunities show business labels, formatted money and English names', async ({ page }) => {
  const done = failOnPageErrors(page);
  await signIn(page, 'owner@noura.demo', '/app/noura-salon/marketing?tab=monthly');
  await page.waitForURL(/\/marketing/);
  // LUMA-AUDIT-039: the Loom plan title follows the UI language.
  const card = page.getByRole('button', { name: /Marketing plan/ }).first();
  await expect(card).toBeVisible();
  await card.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Completed sales (net)');
  // LUMA-AUDIT-023: money in the business currency, not raw halalas.
  await expect(drawer).toContainText(/SAR\s?[\d,]+\.\d{2}/);
  await expect(drawer).not.toContainText(RAW);
  await expect(drawer).toContainText('Prepared by Loom with rules');
  await evidence(page, 'docs/remediation/evidence/loom/loom-plan-en.png');
  await page.keyboard.press('Escape');

  await page.goto('/app/noura-salon/marketing?tab=opportunities');
  // LUMA-AUDIT-039: slow-moving product cards use the product's English name (which items are slowest depends on the run's data).
  const opp = page.locator('li').filter({ hasText: /^Move / }).first();
  await expect(opp).toBeVisible();
  await expect(main(page)).not.toContainText(/Move [\u0600-\u06FF]/);
  await opp.getByRole('button', { name: 'Details and evidence' }).click();
  // LUMA-AUDIT-024: readable metric + subject names instead of `inventory.weekly_usage@item:<uuid>` / `ev_…`.
  await expect(opp).toContainText(/Weekly usage — [A-Za-z]/);
  await expect(opp).toContainText(/On hand — [A-Za-z]/);
  await expect(opp).not.toContainText(RAW);
  await evidence(page, 'docs/remediation/evidence/loom/loom-opportunity-evidence-en.png');
  done();
});

test('Loom: converting an opportunity already in the plan does not duplicate it', async ({ page }) => {
  await signIn(page, 'owner@noura.demo', '/app/noura-salon/marketing?tab=monthly');
  await page.waitForURL(/\/marketing/);
  const openPlan = async () => {
    await page.getByRole('button', { name: /Marketing plan/ }).first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('Fill quiet periods', { exact: true }).first()).toBeVisible();
    await expect(drawer.getByText('Loading…')).toHaveCount(0); // the Loom actions card loads after the version content
    await page.waitForLoadState('networkidle');
    return { drawer, n: await drawer.getByText('Fill quiet periods', { exact: true }).count(), versions: await drawer.getByRole('combobox').first().locator('option').count() };
  };
  // Convert once (adds it, or reports it is already there — depends on earlier specs' analyses), then convert the
  // SAME card again: the second conversion must add nothing (LUMA-AUDIT-038).
  const convert = async () => {
    await page.goto('/app/noura-salon/marketing?tab=opportunities');
    const opp = page.locator('li').filter({ hasText: 'Fill quiet periods' }).first();
    const res = page.waitForResponse((r) => /\/loom\/opportunities\/[^/]+\/convert/.test(r.url()) && r.request().method() === 'POST');
    await opp.getByRole('button', { name: 'To a monthly plan item' }).click();
    expect((await res).status()).toBeLessThan(300);
  };
  await convert();
  await page.goto('/app/noura-salon/marketing?tab=monthly');
  const before = await openPlan();
  await convert();
  await expect(page.getByText('already in this month’s plan')).toBeVisible();
  await page.goto('/app/noura-salon/marketing?tab=monthly');
  const after = await openPlan();
  expect(after.n).toBe(before.n);
  expect(after.versions).toBe(before.versions);
  await expect(after.drawer).not.toContainText('Edited by you');
});

test('freelancer: own schedule is editable, team-admin areas hidden, hidden pages say not available', async ({ page }) => {
  const done = failOnPageErrors(page);
  await signIn(page, 'lamar@lamar.demo', '/app/lamar-makeup/me');
  await page.waitForURL(/\/app\/lamar-makeup\/me/);
  await expect(main(page)).not.toContainText('Read-only. Contact management');
  await expect(page.getByTestId('own-schedule-note')).toBeVisible();
  const sat = page.getByLabel('Saturday To').first();
  await sat.fill('20:00');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText('Saved').first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Saturday To').first()).toHaveValue('20:00');
  await expect(main(page)).not.toContainText('Lateness and absence');
  await evidence(page, 'docs/remediation/evidence/loom/expert-me-schedule-en.png');

  const nav = page.getByRole('navigation').first();
  await expect(nav.getByRole('link', { name: 'My assistants' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Payroll' })).toHaveCount(0);

  for (const path of ['/hosting', '/payroll', '/groups']) {
    await page.goto(`/app/lamar-makeup${path}`);
    await expect(page.getByTestId('not-available')).toBeVisible();
  }
  await page.goto('/app/lamar-makeup/team');
  await expect(page.getByTestId('solo-team-hint')).toBeVisible();
  for (const tab of ['Leave', 'Attendance', 'Staff files', 'Requests']) await expect(page.getByRole('tab', { name: tab })).toHaveCount(0);
  await page.goto('/app/lamar-makeup/settings?tab=branches');
  await expect(page.getByRole('button', { name: 'Add branch' })).toHaveCount(0);
  await expect(main(page)).not.toContainText('branch limit');
  done();
});
