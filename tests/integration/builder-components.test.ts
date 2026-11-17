import { afterEach, describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import { TestClient } from '../helpers/http';
import { withTenant, db } from '@/server/db/client';
import { getPublishedStorefront } from '@/server/domains/storefront/service';
import { setComponent } from '@/server/domains/platform/templates';
import { makeBlock, type PageBlock } from '@/shared/builder/blocks';
import * as services from '@/app/api/v1/t/[tenantSlug]/services/route';
import * as serviceArchive from '@/app/api/v1/t/[tenantSlug]/services/[id]/archive/route';
import * as staff from '@/app/api/v1/t/[tenantSlug]/staff/route';
import * as schedule from '@/app/api/v1/t/[tenantSlug]/staff/[id]/schedule/route';
import * as builder from '@/app/api/v1/t/[tenantSlug]/builder/route';
import * as pageBlocks from '@/app/api/v1/t/[tenantSlug]/builder/pages/[pageId]/blocks/route';
import * as publishRoute from '@/app/api/v1/t/[tenantSlug]/builder/publish/route';
import * as rollbackRoute from '@/app/api/v1/t/[tenantSlug]/builder/versions/[versionId]/rollback/route';
import * as bookingStatus from '@/app/api/v1/t/[tenantSlug]/builder/booking-status/route';
import * as restoreRoute from '@/app/api/v1/t/[tenantSlug]/builder/versions/[versionId]/restore-draft/route';

/**
 * LUMA-AUDIT-019 (platform component switches) and LUMA-AUDIT-031 (version
 * rollback/restore run the same reference + capability checks as publish).
 */
const platformActor = { userId: null, kind: 'platform' as const };

async function newBiz(plan = 'sanaa') {
  const owner = await signup('Owner');
  const biz = await createBusinessFor(owner, { plan_code: plan });
  return { owner, biz, p: { tenantSlug: biz.slug } };
}

async function addBookableService(c: TestClient, biz: { slug: string; branchId: string }, name: string) {
  const p = { tenantSlug: biz.slug };
  const st = await c.call(staff.POST, { params: p, body: { display_name: `${name} specialist` } });
  expect(st.status).toBe(201);
  const sched = await c.call(schedule.PUT, { method: 'PUT', params: { ...p, id: st.body.data.id }, body: { branch_id: biz.branchId, ranges: [{ weekday: 0, start_time: '09:00', end_time: '18:00' }] } });
  expect(sched.status).toBe(200);
  const svc = await c.call(services.POST, { params: p, body: { name_ar: name, price_minor: 10000, duration_min: 45, staff: [{ staff_id: st.body.data.id }] } });
  expect(svc.status).toBe(201);
  return svc.body.data.id as string;
}

async function makeReady(c: TestClient, biz: { slug: string; branchId: string; tenantId: string }) {
  const serviceId = await addBookableService(c, biz, 'قص شعر');
  await withTenant(biz.tenantId, (trx) => trx.updateTable('tenant_settings').set({ booking_policy_confirmed_at: new Date(), booking_policy_text_ar: 'سياسة' }).where('tenant_id', '=', biz.tenantId).execute());
  return serviceId;
}

async function state(c: TestClient, slug: string) {
  const r = await c.call(builder.GET, { params: { tenantSlug: slug } });
  expect(r.status).toBe(200);
  return r.body.data;
}
const home = (s: any) => s.pages.find((x: any) => x.kind === 'home');
const putBlocks = (c: TestClient, slug: string, page: { id: string; version: number }, blocks: unknown) =>
  c.call(pageBlocks.PUT, { method: 'PUT', params: { tenantSlug: slug, pageId: page.id }, body: { version: page.version, blocks } });
const doPublish = (c: TestClient, slug: string) => c.call(publishRoute.POST, { params: { tenantSlug: slug }, body: {}, idempotencyKey: true });

afterEach(async () => {
  // builder_components is platform-wide: leave every component enabled for other tests.
  await db().deleteFrom('builder_components').execute();
});

describe('platform component switches (LUMA-AUDIT-019)', () => {
  it('a disabled component cannot be added (422), shows as unavailable, keeps existing drafts editable, and blocks publishing', async () => {
    const { owner, biz } = await newBiz();
    await makeReady(owner, biz);
    let s = await state(owner, biz.slug);
    const faq = makeBlock('faq');
    // Added while enabled.
    expect((await putBlocks(owner, biz.slug, home(s), [makeBlock('hero'), faq])).status).toBe(200);

    await setComponent('faq', platformActor, { is_enabled: false });
    s = await state(owner, biz.slug);
    expect(s.components.faq).toEqual({ available: false, reason: 'disabled', feature: null });
    expect(s.components.hero.available).toBe(true);
    expect(s.validation.issues.some((i: any) => i.code === 'component_disabled' && i.blockId === faq.id)).toBe(true);

    // Adding another one is refused.
    const add = await putBlocks(owner, biz.slug, home(s), [...home(s).blocks, makeBlock('faq')]);
    expect(add.status).toBe(422);
    expect(add.body.error.code).toBe('component_unavailable');
    expect(add.body.error.details.issues[0].code).toBe('component_disabled');

    // Editing the page that already holds it still saves, with a warning.
    const keep = await putBlocks(owner, biz.slug, home(s), [...home(s).blocks, makeBlock('text')]);
    expect(keep.status).toBe(200);
    expect(keep.body.data.warnings.some((w: any) => w.code === 'component_disabled' && w.blockId === faq.id)).toBe(true);

    // Publishing is refused until it is removed.
    const pub = await doPublish(owner, biz.slug);
    expect(pub.status).toBe(422);
    expect(pub.body.error.code).toBe('publish_validation_failed');
    expect(pub.body.error.details.issues.some((i: any) => i.code === 'component_disabled')).toBe(true);

    s = await state(owner, biz.slug);
    expect((await putBlocks(owner, biz.slug, home(s), home(s).blocks.filter((b: PageBlock) => b.type !== 'faq'))).status).toBe(200);
    expect((await doPublish(owner, biz.slug)).status).toBe(201);
  });

  it('min_plan_feature gates a component by plan', async () => {
    const { owner, biz } = await newBiz();
    await setComponent('instagram', platformActor, { is_enabled: true, min_plan_feature: 'feature.not_in_any_plan' });
    const s = await state(owner, biz.slug);
    expect(s.components.instagram).toEqual({ available: false, reason: 'plan', feature: 'feature.not_in_any_plan' });
    const r = await putBlocks(owner, biz.slug, home(s), [makeBlock('spacer'), makeBlock('instagram')]);
    expect(r.status).toBe(422);
    expect(r.body.error.details.issues[0].code).toBe('component_plan');
  });
});

describe('version rollback / restore validation (LUMA-AUDIT-031)', () => {
  it('rollback re-checks references, components and readiness like publish, and returns warnings', async () => {
    const { owner, biz, p } = await newBiz();
    const serviceA = await makeReady(owner, biz);
    let s = await state(owner, biz.slug);
    const feature = { ...makeBlock('service_feature'), props: { service_id: serviceA, layout: 'image_start', show_price: true } } as PageBlock;
    expect((await putBlocks(owner, biz.slug, home(s), [makeBlock('hero'), feature])).status).toBe(200);
    const v1 = await doPublish(owner, biz.slug);
    expect(v1.status).toBe(201);
    expect(v1.body.data.warnings).toEqual([]);

    s = await state(owner, biz.slug);
    expect((await putBlocks(owner, biz.slug, home(s), [makeBlock('text')])).status).toBe(200);
    expect((await doPublish(owner, biz.slug)).status).toBe(201);

    // The service featured in v1 is archived; with no other bookable service the store is not ready.
    expect((await owner.call(serviceArchive.POST, { params: { ...p, id: serviceA }, body: { archived: true } })).status).toBe(200);
    const notReady = await owner.call(rollbackRoute.POST, { params: { ...p, versionId: v1.body.data.version_id }, body: {}, idempotencyKey: true });
    expect(notReady.status).toBe(422);
    expect(notReady.body.error.code).toBe('not_ready');

    // Another bookable service: rollback succeeds and reports the archived reference.
    await addBookableService(owner, biz, 'صبغة');
    const rb = await owner.call(rollbackRoute.POST, { params: { ...p, versionId: v1.body.data.version_id }, body: {}, idempotencyKey: true });
    expect(rb.status).toBe(201);
    expect(rb.body.data.warnings).toEqual([expect.objectContaining({ kind: 'service', targetId: serviceA, code: 'archived' })]);

    // A component disabled by the platform blocks rolling back to a version that uses it.
    await setComponent('service_feature', platformActor, { is_enabled: false });
    const v2Id = (await getPublishedStorefront(biz.slug))!.version!.id;
    const blocked = await owner.call(rollbackRoute.POST, { params: { ...p, versionId: v1.body.data.version_id }, body: {}, idempotencyKey: true });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('publish_validation_failed');
    expect(blocked.body.error.details.issues.some((i: any) => i.code === 'component_disabled')).toBe(true);
    expect((await getPublishedStorefront(biz.slug))!.version!.id).toBe(v2Id); // nothing moved

    // Restore into the draft does not publish; it reports what the next publish will block on.
    const rd = await owner.call(restoreRoute.POST, { params: { ...p, versionId: v1.body.data.version_id }, body: {} });
    expect(rd.status).toBe(200);
    expect(rd.body.data.published).toBe(false);
    expect(rd.body.data.warnings.some((w: any) => w.code === 'archived' && w.targetId === serviceA)).toBe(true);
    expect(rd.body.data.issues.some((i: any) => i.code === 'component_disabled')).toBe(true);
  });

  it('rollback refuses a version whose stored references no longer belong to the business', async () => {
    const { owner, biz, p } = await newBiz();
    await makeReady(owner, biz);
    const s = await state(owner, biz.slug);
    expect((await putBlocks(owner, biz.slug, home(s), [makeBlock('hero')])).status).toBe(200);
    const v1 = await doPublish(owner, biz.slug);
    expect(v1.status).toBe(201);
    // Simulate a snapshot pointing at a foreign service (e.g. stored before tenant checks existed).
    const foreign = { ...makeBlock('service_feature'), props: { service_id: '00000000-0000-4000-8000-000000000001', layout: 'image_start', show_price: true } };
    await withTenant(biz.tenantId, async (trx) => {
      const v1User = await trx.selectFrom('site_versions').select('published_by').where('id', '=', v1.body.data.version_id).executeTakeFirstOrThrow();
      const v = await trx.selectFrom('site_versions').select('snapshot').where('id', '=', v1.body.data.version_id).executeTakeFirstOrThrow();
      const snap = v.snapshot as any;
      snap.pages.find((x: any) => x.kind === 'home').blocks.push(foreign);
      await trx.insertInto('site_versions').values({ tenant_id: biz.tenantId, version_number: 99, snapshot: JSON.stringify(snap), schema_version: snap.schema_version, published_by: v1User.published_by }).execute();
    });
    const bad = await withTenant(biz.tenantId, (trx) => trx.selectFrom('site_versions').select('id').where('version_number', '=', 99).executeTakeFirstOrThrow());
    const r = await owner.call(rollbackRoute.POST, { params: { ...p, versionId: bad.id }, body: {}, idempotencyKey: true });
    expect(r.status).toBe(422);
    expect(r.body.error.details.issues.some((i: any) => i.code === 'invalid_reference')).toBe(true);
  });
});

describe('live store with nothing bookable (LUMA-AUDIT-017)', () => {
  it('reports booking status for the live store and the impact of archiving its last bookable service', async () => {
    const { owner, biz, p } = await newBiz();
    const serviceId = await makeReady(owner, biz);
    const s = await state(owner, biz.slug);
    expect((await putBlocks(owner, biz.slug, home(s), [makeBlock('hero')])).status).toBe(200);
    expect((await doPublish(owner, biz.slug)).status).toBe(201);

    const now = await owner.call(bookingStatus.GET, { params: p });
    expect(now.status).toBe(200);
    expect(now.body.data).toMatchObject({ live: true, bookable_services: 1, booking_available: true, warn: false });
    const whatIf = await owner.call(bookingStatus.GET, { params: p, query: { exclude_service: serviceId } });
    expect(whatIf.body.data).toMatchObject({ live: true, bookable_services: 0, warn: true });

    expect((await owner.call(serviceArchive.POST, { params: { ...p, id: serviceId }, body: { archived: true } })).status).toBe(200);
    const after = await owner.call(bookingStatus.GET, { params: p });
    expect(after.body.data).toMatchObject({ live: true, booking_available: false, warn: true });
  });
});
