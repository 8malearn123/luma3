import { mkdirSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * LUMA-AUDIT-003: a business's identity (colours, fonts, radius) must render on
 * its public storefront — checked with COMPUTED browser styles, not class names.
 */
test.use({ launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' } });

const EVIDENCE = process.env.EVIDENCE_DIR;
const shot = async (page: Page, name: string) => {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}/${name}.png` });
};

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

const NOURA = {
  primary: '#1F6F5C', on_primary: '#FFFFFF', secondary: '#6B4E9B', accent: '#C2410C',
  background: '#F3F8F6', surface: '#FFFDF8', text: '#14231F', muted: '#4B5B57', border: '#D5E3DE',
};
const LAMAR = {
  primary: '#8B1E3F', on_primary: '#FFFFFF', secondary: '#2B6CB0', accent: '#B7791F',
  background: '#FFF7F9', surface: '#FFFFFF', text: '#2A0F18', muted: '#6B4A55', border: '#F0D5DD',
};

async function setBrand(req: APIRequestContext, slug: string, colors: Record<string, string>, fonts: { heading: string; body: string }, radius: string) {
  const state = await req.get(`/api/v1/t/${slug}/builder`);
  expect(state.status()).toBe(200);
  const s = (await state.json()).data;
  const { version: _v, ...brand } = s.brand;
  const r = await req.patch(`/api/v1/t/${slug}/builder/brand`, {
    headers: { 'x-luma-csrf': '1' },
    data: { version: s.brand_version, brand: { ...brand, colors, fonts, radius, button_style: 'solid', card_style: 'bordered' } },
  });
  expect(r.status(), await r.text()).toBe(200);
}

async function publish(req: APIRequestContext, slug: string) {
  const r = await req.post(`/api/v1/t/${slug}/builder/publish`, { headers: { 'x-luma-csrf': '1', 'Idempotency-Key': `e2e-${slug}-${Date.now()}` }, data: {} });
  expect(r.status(), await r.text()).toBe(201);
}

/** Computed identity of the storefront rendered inside `scope`. */
async function identity(page: Page, scope = '') {
  return page.evaluate((scope) => {
    const root = document.querySelector(`${scope} .storefront`) as HTMLElement;
    const cs = (el: Element | null) => (el ? getComputedStyle(el) : null);
    const cta = root.querySelector('a[class*="bg-sf-primary"], span[class*="bg-sf-primary"]');
    const heading = root.querySelector('[class*="font-sf-heading"]');
    const surface = root.querySelector('footer');
    // Probes for tokens that only appear on optional blocks: same utilities, same scope.
    const probe = (cls: string) => { const el = document.createElement('span'); el.className = cls; root.appendChild(el); const s = getComputedStyle(el); const out = { color: s.color, bg: s.backgroundColor }; el.remove(); return out; };
    return {
      primary: cs(cta)?.backgroundColor, onPrimary: cs(cta)?.color, radius: cs(cta)?.borderTopLeftRadius,
      background: cs(root)!.backgroundColor, text: cs(root)!.color, bodyFont: cs(root)!.fontFamily,
      headingFont: cs(heading)?.fontFamily, surface: cs(surface)?.backgroundColor,
      accent: probe('text-sf-accent').color, secondary: probe('bg-sf-secondary').bg, muted: probe('text-sf-muted').color,
    };
  }, scope);
}

function expectIdentity(id: Awaited<ReturnType<typeof identity>>, c: typeof NOURA, fonts: { heading: string; body: string }, radiusPx: string) {
  expect(id.primary).toBe(rgb(c.primary));
  expect(id.onPrimary).toBe(rgb(c.on_primary));
  expect(id.background).toBe(rgb(c.background));
  expect(id.surface).toBe(rgb(c.surface));
  expect(id.text).toBe(rgb(c.text));
  expect(id.accent).toBe(rgb(c.accent));
  expect(id.secondary).toBe(rgb(c.secondary));
  expect(id.muted).toBe(rgb(c.muted));
  expect(id.headingFont).toContain(fonts.heading);
  expect(id.bodyFont).toContain(fonts.body);
  expect(id.radius).toBe(radiusPx);
}

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
});

test('tenant colours, fonts and radius render on the public storefront; draft stays separate until publish', async ({ page, browser, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, 'owner@noura.demo', '/app/noura-salon');
  await page.waitForURL(/\/app\/noura-salon/);
  // The LUMA dashboard keeps LUMA's own palette (luma-50 canvas), untouched by any storefront theme.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(251, 241, 246)');

  const fonts = { heading: 'Cairo', body: 'Tajawal' };
  await setBrand(page.request, 'noura-salon', NOURA, { heading: 'cairo', body: 'tajawal' }, 'lg');
  await publish(page.request, 'noura-salon');

  // A second business, published by its own owner, at the same time.
  const other = await browser.newContext({ baseURL });
  await other.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  const lamarPage = await other.newPage();
  await signIn(lamarPage, 'lamar@lamar.demo', '/app/lamar-makeup');
  await lamarPage.waitForURL(/\/app\/lamar-makeup/);
  await setBrand(lamarPage.request, 'lamar-makeup', LAMAR, { heading: 'amiri', body: 'almarai' }, 'none');
  await publish(lamarPage.request, 'lamar-makeup');

  // Desktop 1440.
  const visitor = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  await visitor.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  const pub = await visitor.newPage();
  await pub.goto('/s/noura-salon');
  const desktop = await identity(pub);
  expectIdentity(desktop, NOURA, fonts, '18px');
  await shot(pub, '003-noura-public-desktop');

  const lamarPub = await visitor.newPage();
  await lamarPub.goto('/s/lamar-makeup');
  const lamarId = await identity(lamarPub);
  expectIdentity(lamarId, LAMAR, { heading: 'Amiri', body: 'Almarai' }, '0px');
  expect(lamarId.primary).not.toBe(desktop.primary);
  await shot(lamarPub, '003-lamar-public-desktop');

  // Mobile 375 shows the same identity.
  const phone = await browser.newContext({ baseURL, viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  await phone.addCookies([{ name: 'luma_locale', value: 'en', url: baseURL! }]);
  const mob = await phone.newPage();
  await mob.goto('/s/noura-salon');
  expect(await identity(mob)).toEqual(desktop);
  await shot(mob, '003-noura-public-mobile');

  // Draft change: public keeps the published identity; the preview link shows the draft.
  const DRAFT = { ...NOURA, primary: '#7A1FA2' };
  await setBrand(page.request, 'noura-salon', DRAFT, { heading: 'cairo', body: 'tajawal' }, 'lg');
  await pub.reload();
  expect((await identity(pub)).primary).toBe(rgb(NOURA.primary));
  const tok = await page.request.post('/api/v1/t/noura-salon/builder/preview-tokens', { headers: { 'x-luma-csrf': '1' }, data: { ttl_hours: 1 } });
  expect(tok.status()).toBe(201);
  const preview = await visitor.newPage();
  await preview.goto((await tok.json()).data.path);
  expect((await identity(preview)).primary).toBe(rgb(DRAFT.primary));

  // The builder canvas (owner preview) renders the same computed draft identity.
  await page.goto('/app/noura-salon/builder');
  await expect(page.locator('[data-builder-canvas] .storefront')).toBeVisible();
  const canvas = await identity(page, '[data-builder-canvas]');
  expectIdentity(canvas, DRAFT, fonts, '18px');
  await shot(page, '003-builder-canvas-draft');

  // Publishing makes the draft live.
  await publish(page.request, 'noura-salon');
  await pub.reload();
  expect((await identity(pub)).primary).toBe(rgb(DRAFT.primary));
  // The other business is unaffected.
  await lamarPub.reload();
  expect((await identity(lamarPub)).primary).toBe(rgb(LAMAR.primary));

  await Promise.all([other.close(), visitor.close(), phone.close()]);
});
