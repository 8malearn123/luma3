import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * LUMA-AUDIT-035 dark mode, after the token sweep (DESIGN_GUIDE §11): every internal
 * surface — business dashboard, freelancer workspace, platform admin, customer account,
 * auth — renders on the dark tokens with no light patches, readable text (WCAG AA on a
 * sample of real text/background pairs) and no horizontal overflow at 1440 and 375 px.
 * The light theme is checked with the same audit so the sweep did not regress it.
 */
test.use({ launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' } });

const EVIDENCE = process.env.EVIDENCE_DIR;
const REPORT = process.env.DARK_REPORT; // optional JSON-lines dump of every page audit

type Theme = 'light' | 'dark';
type Audit = { canvas: string; lightPatches: string[]; lowContrast: string[]; checked: number; overflow: number };

const DARK_CANVAS = 'rgb(23, 17, 26)';
const LIGHT_CANVAS = 'rgb(251, 241, 246)';

async function setup(context: BrowserContext, baseURL: string, theme: Theme) {
  await context.addCookies([
    { name: 'luma_locale', value: 'en', url: baseURL },
    { name: 'luma_theme', value: theme, url: baseURL },
  ]);
}

/**
 * Runs in the page: resolves every colour through a canvas (handles oklab/color-mix output),
 * composites translucent backgrounds over their ancestors, then
 *  - lightPatches (dark only): opaque light surfaces inside `.luma-app` (larger than a
 *    badge: status pills keep their light status colour on purpose)
 *  - lowContrast: visible text whose colour against its effective background is < 4.5:1
 *    (3:1 for large text). Storefront previews, media and user-chosen colours are skipped.
 */
async function audit(page: Page, theme: Theme): Promise<Audit> {
  return page.evaluate((th) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    const rgba = (c: string): [number, number, number, number] => {
      g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    };
    const lum = ([r, gg, b]: number[]) => { const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r!) + 0.7152 * f(gg!) + 0.0722 * f(b!); };
    const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
    const over = (top: number[], bottom: number[]) => { const a = top[3]!; return [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a)).concat(1); };
    const skip = (el: Element) => !!el.closest('.storefront, [aria-hidden="true"], svg, img, video, canvas, picture, .sr-only, [data-builder-canvas]');
    /** Effective background, or null when an image/gradient/user colour sits underneath. */
    const effectiveBg = (el: Element | null): number[] | null => {
      const layers: number[][] = [];
      for (let e = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.backgroundImage !== 'none' && !e.classList.contains('luma-pattern')) return null;
        if ((e as HTMLElement).style?.backgroundColor) return null;
        const c = rgba(s.backgroundColor);
        if (c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
      }
      let acc = [255, 255, 255, 1];
      for (const l of layers.reverse()) acc = over(l, acc);
      return acc;
    };
    const desc = (el: Element) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className || '').split(/\s+/).slice(0, 6).join('.')} «${(el.textContent || '').trim().slice(0, 40)}»`;
    const app = document.querySelector('.luma-app');
    const lightPatches: string[] = [];
    const lowContrast: string[] = [];
    let checked = 0;
    const all = Array.from((app ?? document.body).querySelectorAll('*'));
    for (const el of all) {
      if (skip(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') continue;
      if (th === 'dark' && app && r.width * r.height > 1600 && !(el as HTMLElement).style?.backgroundColor) {
        const c = rgba(s.backgroundColor);
        if (c[3] >= 0.5 && lum(c) > 0.35) lightPatches.push(`${desc(el)} bg=${s.backgroundColor}`);
      }
      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim().length > 0);
      if (!ownText) continue;
      // Disabled or faded controls are exempt from AA (WCAG 1.4.3 incidental text).
      let faded = false;
      for (let e: Element | null = el; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) < 0.99 || (e as HTMLButtonElement).disabled) { faded = true; break; }
      if (faded) continue;
      const bg = effectiveBg(el);
      if (!bg) continue;
      const fg = over(rgba(s.color), bg);
      const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const cr = ratio(fg, bg);
      checked++;
      if (cr < need) lowContrast.push(`${desc(el)} ${cr.toFixed(2)} fg=${s.color} bg=rgb(${bg.slice(0, 3).map(Math.round).join(',')})`);
    }
    return {
      canvas: app ? getComputedStyle(app).backgroundColor : getComputedStyle(document.body).backgroundColor,
      lightPatches: lightPatches.slice(0, 15), lowContrast: lowContrast.slice(0, 15), checked,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, theme);
}

async function visit(page: Page, path: string, theme: Theme, width: number, shotName?: string) {
  await page.setViewportSize({ width, height: width < 500 ? 812 : 900 });
  const res = await page.goto(path);
  expect(res!.status(), path).toBeLessThan(400);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  const a = await audit(page, theme);
  if (REPORT) appendFileSync(REPORT, `${JSON.stringify({ path, theme, width, ...a })}\n`);
  expect.soft(a.canvas, `${path} ${theme} canvas`).toBe(theme === 'dark' ? DARK_CANVAS : LIGHT_CANVAS);
  expect.soft(a.lightPatches, `${path} ${theme}@${width} light patches`).toEqual([]);
  expect.soft(a.lowContrast, `${path} ${theme}@${width} text below AA`).toEqual([]);
  expect.soft(a.checked, `${path} sampled text`).toBeGreaterThan(3);
  expect.soft(a.overflow, `${path} ${theme}@${width} horizontal overflow`).toBeLessThanOrEqual(1);
  if (shotName && EVIDENCE) { mkdirSync(EVIDENCE, { recursive: true }); await page.screenshot({ path: `${EVIDENCE}/${shotName}-${theme}-${width}.png` }); }
}

const MATRIX: [Theme, number][] = [['dark', 1440], ['dark', 375], ['light', 1440]];

async function sweep(page: Page, context: BrowserContext, baseURL: string, pages: [string, string?][]) {
  for (const [theme, width] of MATRIX) {
    await setup(context, baseURL, theme);
    for (const [path, shot] of pages) await visit(page, path, theme, width, shot && (width === 1440 || theme === 'dark') ? shot : undefined);
  }
}

test('owner dashboard: dark tokens, AA text and no overflow on every main screen', async ({ page, context, baseURL }) => {
  await setup(context, baseURL!, 'dark');
  await signIn(page, 'owner@noura.demo');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'));
  const s = '/app/noura-salon';
  await sweep(page, context, baseURL!, [
    [s, 'owner-home'], [`${s}/bookings`, 'owner-bookings'], [`${s}/bookings?view=calendar`], [`${s}/inventory`], [`${s}/finance`, 'owner-finance'],
    [`${s}/hosting`], [`${s}/marketing`, 'owner-loom'], [`${s}/settings`], [`${s}/team`], [`${s}/customers`], [`${s}/services`], ['/app'], ['/app/new'],
  ]);
});

test('freelancer dashboard and workspace page', async ({ page, context, baseURL }) => {
  await setup(context, baseURL!, 'dark');
  await signIn(page, 'lamar@lamar.demo');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'));
  await sweep(page, context, baseURL!, [['/app/lamar-makeup', 'freelancer-home'], ['/app/lamar-makeup/workspace'], ['/app/lamar-makeup/portfolio']]);
});

test('customer account', async ({ page, context, baseURL }) => {
  await setup(context, baseURL!, 'dark');
  await signIn(page, 'customer@demo.test', '/account');
  await page.waitForURL(/\/account/);
  await sweep(page, context, baseURL!, [['/account', 'account-home'], ['/account/bookings'], ['/account/loyalty'], ['/account/security']]);
});

test('auth pages follow the theme', async ({ page, context, baseURL }) => {
  await sweep(page, context, baseURL!, [['/auth/login', 'auth-login'], ['/auth/register'], ['/auth/recover'], ['/invite/not-a-real-invitation-token']]);
});

test('platform admin (after MFA)', async ({ page, context, baseURL }) => {
  await setup(context, baseURL!, 'dark');
  await signIn(page, 'admin@luma.demo', '/platform');
  await page.waitForURL(/\/platform\/mfa/);
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  // No WhatsApp provider is connected: this local build shows the code on screen.
  const code = (await page.locator('[role=status] p.font-mono').textContent())!.trim();
  await page.getByLabel('Verification code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL(/\/platform$/);
  await sweep(page, context, baseURL!, [
    ['/platform', 'platform-home'], ['/platform/tenants'], ['/platform/analytics'], ['/platform/feed'], ['/platform/plans'], ['/platform/security'], ['/platform/settings'],
  ]);
});

test('the storefront and marketing site stay light even with dark chosen', async ({ page, context, baseURL }) => {
  await setup(context, baseURL!, 'dark');
  await page.goto('/s/noura-salon');
  expect(await page.locator('.storefront').first().evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(DARK_CANVAS);
  await page.goto('/');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(LIGHT_CANVAS);
});
