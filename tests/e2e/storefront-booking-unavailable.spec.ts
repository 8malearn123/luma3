import { expect, test, type APIRequestContext } from '@playwright/test';
import { signIn } from './helpers';

/**
 * LUMA-AUDIT-017: archiving the last bookable service of a LIVE store warns the
 * owner, the dashboard says booking is unavailable, and the public "Book now"
 * leads to a clear unavailable state with contact options (no dead end).
 * Uses lamar-makeup and restores its services afterwards.
 */
test.use({ launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' } });

const SLUG = 'lamar-makeup';
const H = { 'x-luma-csrf': '1' };

async function bookableServices(req: APIRequestContext) {
  const r = await req.get(`/api/v1/t/${SLUG}/services`);
  expect(r.status()).toBe(200);
  return ((await r.json()).data as Array<{ id: string; is_active: boolean; is_visible: boolean; archived_at: string | null }>).filter((s) => s.is_active && s.is_visible && !s.archived_at);
}

async function restore(req: APIRequestContext, ids: string[]) {
  for (const id of ids) {
    await req.post(`/api/v1/t/${SLUG}/services/${id}/archive`, { headers: H, data: { archived: false } });
    const cur = (await (await req.get(`/api/v1/t/${SLUG}/services/${id}`)).json()).data;
    await req.patch(`/api/v1/t/${SLUG}/services/${id}`, { headers: H, data: { version: cur.version, is_active: true } });
  }
}

test('archiving the last bookable service warns, flags the dashboard and shows a clear public unavailable state', async ({ page, browser, baseURL, context }) => {
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  await signIn(page, 'lamar@lamar.demo', `/app/${SLUG}`);
  await page.waitForURL(new RegExp(`/app/${SLUG}`));
  const all = await bookableServices(page.request);
  expect(all.length).toBeGreaterThan(0);
  const archived: string[] = [];
  try {
    for (const s of all.slice(0, -1)) {
      expect((await page.request.post(`/api/v1/t/${SLUG}/services/${s.id}/archive`, { headers: H, data: { archived: true } })).status()).toBe(200);
      archived.push(s.id);
    }
    const last = all.at(-1)!;
    await page.goto(`/app/${SLUG}/services?service=${last.id}`);
    const drawer = page.getByRole('dialog').first();
    await drawer.getByRole('button', { name: 'Archive' }).click();
    const confirm = page.getByRole('dialog', { name: 'Archive this service?' });
    await expect(confirm.getByText('This is the last bookable service on your live store')).toBeVisible();
    await confirm.getByRole('button', { name: 'Archive' }).click();
    archived.push(last.id);
    await expect(page.getByText('Service archived.')).toBeVisible();

    await page.goto(`/app/${SLUG}`);
    await expect(page.getByRole('heading', { name: 'Your store is live, but nothing can be booked right now' })).toBeVisible();

    // A visitor: "Book now" leads to a clear unavailable state with a way back / to contact.
    const visitor = await browser.newContext({ baseURL });
    await visitor.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
    const pub = await visitor.newPage();
    await pub.goto(`/s/${SLUG}`);
    await pub.getByRole('link', { name: /Book now/ }).first().click();
    await pub.waitForURL(new RegExp(`/s/${SLUG}/booking`));
    await expect(pub.getByRole('heading', { name: 'Online booking is not available right now' })).toBeVisible();
    await expect(pub.getByRole('link', { name: 'Back to the store' })).toBeVisible();
    if (process.env.EVIDENCE_DIR) await pub.screenshot({ path: `${process.env.EVIDENCE_DIR}/017-public-booking-unavailable.png` });
    await visitor.close();
  } finally {
    await restore(page.request, archived);
  }
  // Restored: booking is available again.
  expect((await bookableServices(page.request)).length).toBe(all.length);
});
