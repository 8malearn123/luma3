import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import type { TestClient } from '../helpers/http';
import { withSystem, withTenant } from '@/server/db/client';
import { getDraftStorefront, getPublishedStorefront } from '@/server/domains/storefront/service';
import { setInstagramProviderForTests, type InstagramProvider } from '@/server/domains/instagram/provider';
import { normalizeHandle } from '@/server/domains/instagram/service';
import { BLOCKS, collectReferences, makeBlock, validateBlocks } from '@/shared/builder/blocks';
import { beforeAfterItems, instagramView } from '@/ui/storefront/blocks/expert';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as schedule from '@/app/api/v1/t/[tenantSlug]/staff/[id]/schedule/route';
import * as builder from '@/app/api/v1/t/[tenantSlug]/builder/route';
import * as pageBlocks from '@/app/api/v1/t/[tenantSlug]/builder/pages/[pageId]/blocks/route';
import * as publishRoute from '@/app/api/v1/t/[tenantSlug]/builder/publish/route';
import * as portfolio from '@/app/api/v1/t/[tenantSlug]/portfolio/route';
import * as portfolioOne from '@/app/api/v1/t/[tenantSlug]/portfolio/[id]/route';
import * as instagram from '@/app/api/v1/t/[tenantSlug]/instagram/route';
import * as igConnect from '@/app/api/v1/t/[tenantSlug]/instagram/connect/route';
import * as igMedia from '@/app/api/v1/s/[slug]/instagram/[postId]/route';
import * as settingsRoute from '@/app/api/v1/t/[tenantSlug]/settings/route';

async function insertAsset(tenantId: string, visibility: 'public' | 'private' = 'public') {
  const id = randomUUID();
  await withTenant(tenantId, (trx) => trx.insertInto('assets').values({
    id, tenant_id: tenantId, kind: 'image', purpose: 'gallery', storage_key: `tenants/${tenantId}/${id}.webp`, mime: 'image/webp', bytes: 1000,
    width: 800, height: 1000, status: 'ready', visibility, alt_ar: 'صورة', alt_en: 'Image',
  }).execute());
  return id;
}

/** A published expert storefront (readiness: a scheduled specialist, a service and a confirmed policy). */
async function publishedExpert() {
  const owner = await signup('Expert');
  const biz = await createBusinessFor(owner, { business_type: 'expert', plan_code: 'wahaj' });
  const p = { tenantSlug: biz.slug };
  expect((await owner.call(schedule.PUT, { params: { ...p, id: biz.staffProfileId! }, body: { branch_id: biz.branchId, ranges: [{ weekday: 0, start_time: '09:00', end_time: '18:00' }] } })).status).toBe(200);
  expect((await owner.call(services.POST, { params: p, body: { name_ar: 'مكياج', price_minor: 30000, duration_min: 60, staff: [{ staff_id: biz.staffProfileId! }] } })).status).toBe(201);
  await withTenant(biz.tenantId, (trx) => trx.updateTable('tenant_settings').set({ booking_policy_confirmed_at: new Date(), booking_policy_text_ar: 'سياسة' }).where('tenant_id', '=', biz.tenantId).execute());
  return { owner, biz, p };
}

async function setHome(c: TestClient, slug: string, blocks: unknown) {
  const s = (await c.call(builder.GET, { params: { tenantSlug: slug } })).body.data;
  const home = s.pages.find((x: { kind: string }) => x.kind === 'home');
  return c.call(pageBlocks.PUT, { method: 'PUT', params: { tenantSlug: slug, pageId: home.id }, body: { version: home.version, blocks } });
}
const publish = async (c: TestClient, slug: string) => {
  const r = await c.call(publishRoute.POST, { params: { tenantSlug: slug }, body: {}, idempotencyKey: true });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
};

afterEach(() => setInstagramProviderForTests(null));

describe('before/after block', () => {
  it('validates its schema strictly', () => {
    const a = randomUUID(); const b = randomUUID();
    const ok = makeBlock('before_after', { props: { ...BLOCKS.before_after.defaults(), items: [{ before_asset_id: a, after_asset_id: b, caption: { ar: 'عروس' } }] } });
    expect(validateBlocks([ok]).issues).toEqual([]);
    expect(collectReferences([ok]).assets).toEqual(new Set([a, b]));
    const same = makeBlock('before_after', { props: { items: [{ before_asset_id: a, after_asset_id: a }] } });
    expect(validateBlocks([same]).issues[0]?.code).toBe('invalid_props');
    const extra = makeBlock('before_after', { props: { items: [{ before_asset_id: a, after_asset_id: b, html: '<script>' }] } });
    expect(validateBlocks([extra]).issues[0]?.code).toBe('invalid_props');
    const badStart = makeBlock('before_after', { props: { start: 99 } });
    expect(validateBlocks([badStart]).issues[0]?.code).toBe('invalid_props');
    const tooMany = makeBlock('before_after', { props: { items: Array.from({ length: 31 }, () => ({ before_asset_id: randomUUID(), after_asset_id: randomUUID() })) } });
    expect(validateBlocks([tooMany]).issues.length).toBeGreaterThan(0);
    // Not allowed inside columns (it needs the page width).
    const cols = makeBlock('columns', { children: [makeBlock('before_after')] });
    expect(validateBlocks([cols]).issues.some((i) => i.code === 'invalid_nesting')).toBe(true);
  });

  it('saves with this tenant\'s public images only and renders pairs and portfolio items publicly', async () => {
    const { owner, biz, p } = await publishedExpert();
    const [b1, a1, b2, a2] = await Promise.all([insertAsset(biz.tenantId), insertAsset(biz.tenantId), insertAsset(biz.tenantId), insertAsset(biz.tenantId)]);
    const priv = await insertAsset(biz.tenantId, 'private');
    const foreign = await (async () => { const o = await signup('Other'); const ob = await createBusinessFor(o); return insertAsset(ob.tenantId); })();

    // Private or foreign images can never be placed on a page.
    const withPrivate = makeBlock('before_after', { props: { items: [{ before_asset_id: priv, after_asset_id: a1 }] } });
    expect((await setHome(owner, biz.slug, [withPrivate])).status).toBe(422);
    const withForeign = makeBlock('before_after', { props: { items: [{ before_asset_id: foreign, after_asset_id: a1 }] } });
    expect((await setHome(owner, biz.slug, [withForeign])).status).toBe(422);

    // Portfolio («أعمالي»).
    const created = await owner.call(portfolio.POST, { params: p, body: { before_asset_id: b2, after_asset_id: a2, caption_ar: 'مكياج عروس', category: 'عرائس' } });
    expect(created.status).toBe(201);
    expect((await owner.call(portfolio.POST, { params: p, body: { before_asset_id: priv, after_asset_id: a2 } })).status).toBe(422);
    const hidden = await owner.call(portfolio.POST, { params: p, body: { before_asset_id: b1, after_asset_id: a1, category: 'سهرة' } });
    expect((await owner.call(portfolioOne.PATCH, { method: 'PATCH', params: { ...p, id: hidden.body.data.id }, body: { is_visible: false } })).status).toBe(200);

    const manual = makeBlock('before_after', { props: { ...BLOCKS.before_after.defaults(), items: [{ before_asset_id: b1, after_asset_id: a1, caption: { ar: 'قبل وبعد', en: 'Before/after' } }] } });
    const fromPortfolio = makeBlock('before_after', { props: { ...BLOCKS.before_after.defaults(), source: 'portfolio', category: 'عرائس' } });
    const saved = await setHome(owner, biz.slug, [manual, fromPortfolio]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await publish(owner, biz.slug);

    const data = (await getPublishedStorefront(biz.slug))!;
    expect(data.portfolio?.map((i) => i.id)).toEqual([created.body.data.id]); // hidden items are not public
    for (const id of [b1, a1, b2, a2]) expect(data.assets[id]).toBeTruthy();
    expect(beforeAfterItems(data, 'ar', manual.props as never)).toEqual([{ key: `0-${b1}`, before: b1, after: a1, caption: 'قبل وبعد', category: '' }]);
    expect(beforeAfterItems(data, 'en', fromPortfolio.props as never)).toEqual([{ key: created.body.data.id, before: b2, after: a2, caption: 'مكياج عروس', category: 'عرائس' }]);
    expect(beforeAfterItems(data, 'ar', { ...fromPortfolio.props, category: 'سهرة' } as never)).toEqual([]);
    // Nothing private leaks into the public read model.
    expect(JSON.stringify(data)).not.toContain(priv);

    // Another business cannot touch this portfolio.
    const stranger = await signup('Stranger');
    expect((await stranger.call(portfolio.GET, { params: p })).status).toBe(404);
  });
});

describe('instagram block', () => {
  it('falls back to the «تابعينا على إنستقرام» card without a connection; connecting needs the platform app', async () => {
    const { owner, biz, p } = await publishedExpert();
    const block = makeBlock('instagram');
    expect(validateBlocks([block]).issues).toEqual([]);
    expect((await setHome(owner, biz.slug, [block])).status).toBe(200);
    await publish(owner, biz.slug);

    // No handle anywhere: nothing to show publicly.
    let data = (await getPublishedStorefront(biz.slug))!;
    expect(data.instagram).toEqual({ handle: null, profile_url: null, connected: false, posts: [] });
    expect(instagramView(data, 6).mode).toBe('none');

    // The handle from the business's social links is enough for the follow card.
    await withTenant(biz.tenantId, (trx) => trx.updateTable('tenant_settings').set({ social_links: JSON.stringify({ instagram: '@luma.beauty' }) }).where('tenant_id', '=', biz.tenantId).execute());
    data = (await getPublishedStorefront(biz.slug))!;
    expect(instagramView(data, 6)).toEqual({ mode: 'follow', handle: 'luma.beauty', url: 'https://www.instagram.com/luma.beauty/', posts: [] });

    // An explicit handle wins; invalid handles are refused.
    expect((await owner.call(instagram.PUT, { method: 'PUT', params: p, body: { handle: 'https://instagram.com/<script>' } })).status).toBe(422);
    const set = await owner.call(instagram.PUT, { method: 'PUT', params: p, body: { handle: 'https://www.instagram.com/glow_by_sara/' } });
    expect(set.body.data).toMatchObject({ handle: 'glow_by_sara', status: 'not_connected', provider_configured: false });
    data = (await getPublishedStorefront(biz.slug))!;
    expect(instagramView(data, 6).handle).toBe('glow_by_sara');

    // No Meta credentials on this platform: connecting degrades gracefully (503, nothing stored).
    const conn = await owner.call(igConnect.POST, { params: p, body: { access_token: 'IGQV-test-token-123' } });
    expect(conn.status).toBe(503);
    expect(conn.body.error.code).toBe('instagram_not_configured');
    // The media proxy serves nothing for an unconnected account.
    expect((await owner.call(igMedia.GET, { params: { slug: biz.slug, postId: '123' } })).status).toBe(404);
    void settingsRoute;
  });

  it('shows cached posts from the official API when connected (token encrypted, never returned)', async () => {
    const { owner, biz, p } = await publishedExpert();
    const fake: InstagramProvider = {
      name: 'graph', isConfigured: () => true,
      fetchAccount: async () => ({ igUserId: '1789', username: 'glow_by_sara', expiresAt: null }),
      fetchRecentMedia: async () => [
        { id: '111', permalink: 'https://www.instagram.com/p/abc/', media_type: 'IMAGE', image_url: 'https://scontent.cdninstagram.com/v/1.jpg', caption: 'عروس اليوم', timestamp: '2026-11-01T10:00:00Z' },
        { id: '222', permalink: 'https://evil.example/p/x', media_type: 'IMAGE', image_url: 'https://scontent.cdninstagram.com/v/2.jpg', caption: null, timestamp: '2026-11-01T10:00:00Z' },
        { id: '333', permalink: 'https://www.instagram.com/p/def/', media_type: 'IMAGE', image_url: 'https://evil.example/3.jpg', caption: null, timestamp: '2026-11-01T10:00:00Z' },
      ],
    };
    setInstagramProviderForTests(fake);
    expect((await setHome(owner, biz.slug, [makeBlock('instagram')])).status).toBe(200);
    await publish(owner, biz.slug);
    const conn = await owner.call(igConnect.POST, { params: p, body: { access_token: 'IGQV-test-token-123' } });
    expect(conn.status).toBe(200);
    expect(conn.body.data).toMatchObject({ status: 'connected', handle: 'glow_by_sara', post_count: 1 });
    expect(JSON.stringify(conn.body)).not.toContain('IGQV');
    const stored = await withSystem('read token', (trx) => trx.selectFrom('instagram_connections').select('access_token_enc').where('tenant_id', '=', biz.tenantId).executeTakeFirstOrThrow());
    expect(stored.access_token_enc).not.toContain('IGQV');

    const data = (await getPublishedStorefront(biz.slug))!;
    const v = instagramView(data, 6);
    expect(v.mode).toBe('posts');
    expect(v.posts).toEqual([{ id: '111', permalink: 'https://www.instagram.com/p/abc/', caption: 'عروس اليوم', media_type: 'IMAGE', timestamp: '2026-11-01T10:00:00Z' }]);
    // Media URLs stay server-side (served through the proxy).
    expect(JSON.stringify(data)).not.toContain('cdninstagram');

    // Disconnecting returns to the follow card.
    expect((await owner.call(igConnect.DELETE, { method: 'DELETE', params: p })).status).toBe(200);
    expect(instagramView((await getPublishedStorefront(biz.slug))!, 6).mode).toBe('follow');
    // The builder canvas always has the data.
    expect((await getDraftStorefront(biz.tenantId, 'canvas'))!.instagram?.handle).toBe('glow_by_sara');
  });

  it('normalises handles', () => {
    expect(normalizeHandle('@Sara.Beauty')).toBe('Sara.Beauty');
    expect(normalizeHandle('https://instagram.com/sara_b?igsh=1')).toBe('sara_b');
    expect(normalizeHandle('https://evil.com/sara')).toBeNull();
    expect(normalizeHandle('bad handle')).toBeNull();
  });
});
