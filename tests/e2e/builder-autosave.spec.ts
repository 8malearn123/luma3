import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * LUMA-AUDIT-040: builder autosave resumes by itself after the connection
 * comes back, and a concurrent edit (409) asks the owner to choose — never a
 * silent loss. Also LUMA-AUDIT-019's Library state is checked in the UI.
 */
test.use({ launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' } });

// One sign-in for the file (sign-in attempts are rate limited).
let state: Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>>;
test.beforeAll(async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  await ctx.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  const p = await ctx.newPage();
  await signIn(p, 'owner@noura.demo', '/app/noura-salon');
  await p.waitForURL(/\/app\/noura-salon/);
  state = await ctx.storageState();
  await ctx.close();
});
test.beforeEach(async ({ context }) => {
  await context.addCookies(state.cookies);
});

const homeBlocks = async (page: Page) => {
  const r = await page.request.get('/api/v1/t/noura-salon/builder');
  const s = (await r.json()).data;
  return s.pages.find((p: { kind: string }) => p.kind === 'home').blocks as Array<{ id: string; type: string }>;
};

async function openBuilder(page: Page) {
  await page.goto('/app/noura-salon/builder');
  await expect(page.getByRole('button', { name: 'Add: Spacer / divider' })).toBeVisible();
}

test('autosave retries on reconnect without a click', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page);
  const before = (await homeBlocks(page)).filter((b) => b.type === 'spacer').length;

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Add: Spacer / divider' }).click();
  await expect(page.getByText('Connection lost — your changes are kept here')).toBeVisible({ timeout: 15_000 });

  await context.setOffline(false);
  // No click on "Retry now": the online event / backoff saves it.
  await expect(page.getByText(/Last saved/)).toBeVisible({ timeout: 20_000 });
  expect((await homeBlocks(page)).filter((b) => b.type === 'spacer').length).toBe(before + 1);
});

test('a concurrent edit asks: load latest or keep mine — keeping mine overwrites, nothing silently lost', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page);

  // Another tab saves first.
  const other = await context.newPage();
  await other.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(other);
  await other.getByRole('button', { name: 'Add: FAQ' }).click();
  await expect(other.getByText(/Last saved/)).toBeVisible({ timeout: 20_000 });

  // This tab's save now conflicts.
  await page.getByRole('button', { name: 'Add: Spacer / divider' }).click();
  const dialog = page.getByRole('dialog', { name: 'The draft was changed elsewhere' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole('button', { name: 'Load latest (discard my changes)' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep my changes (overwrite the other edit)' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Last saved/)).toBeVisible({ timeout: 20_000 });
  const blocks = await homeBlocks(page);
  expect(blocks.at(-1)?.type).toBe('spacer');
});

test('a component turned off by the platform is greyed in the Library with its reason', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Simulate the platform switch from the builder state as served (the API is covered by integration tests):
  await page.route('**/api/v1/t/noura-salon/builder', async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.data.components = { ...(json.data.components ?? {}), faq: { available: false, reason: 'disabled', feature: null } };
    await route.fulfill({ response: res, json });
  });
  await openBuilder(page);
  await expect(page.getByRole('button', { name: 'Add: FAQ' })).toBeDisabled();
  await expect(page.getByText('Temporarily turned off by LUMA')).toBeVisible();
});
