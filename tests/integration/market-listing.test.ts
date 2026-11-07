import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '@/server/db/client';
import * as status from '@/app/api/v1/t/[tenantSlug]/marketplace/route';
import * as request from '@/app/api/v1/t/[tenantSlug]/marketplace/request/route';
import * as submit from '@/app/api/v1/t/[tenantSlug]/marketplace/verification/submit/route';
import * as ownDoc from '@/app/api/v1/t/[tenantSlug]/marketplace/verification/documents/[id]/route';
import * as listings from '@/app/api/v1/platform/marketplace/listings/route';
import * as reviewListing from '@/app/api/v1/platform/marketplace/listings/[tenantId]/review/route';
import * as verifications from '@/app/api/v1/platform/marketplace/verifications/route';
import * as verificationDetail from '@/app/api/v1/platform/marketplace/verifications/[tenantId]/route';
import * as reviewVerification from '@/app/api/v1/platform/marketplace/verifications/[tenantId]/review/route';
import * as platformDoc from '@/app/api/v1/platform/marketplace/documents/[id]/route';
import * as settings from '@/app/api/v1/platform/marketplace/settings/route';
import * as commission from '@/app/api/v1/platform/marketplace/tenants/[tenantId]/commission/route';
import * as summary from '@/app/api/v1/platform/marketplace/tenants/[tenantId]/route';
import * as search from '@/app/api/v1/market/search/route';
import { makeSalon } from '../helpers/salon';
import { TestClient } from '../helpers/http';
import { addMember, expireStepUp, platformUser, stepUp } from '../helpers/platform';
import { marketAdmin, publish, upload, uploadDoc, VALID_IBAN } from '../helpers/market';
import * as docs from '@/app/api/v1/t/[tenantSlug]/marketplace/verification/documents/route';

const listed = async (slug: string) => ((await new TestClient().call(search.GET, { query: { q: '', limit: '48' } })).body.data.items as Array<{ slug: string }>).some((i) => i.slug === slug);

describe('سوق لوما: verification and join requests', () => {
  it('verification by type → join request → rejection with reason → approval → hide/show', async () => {
    const s = await makeSalon();
    await publish(s);
    const p = { tenantSlug: s.slug };
    const admin = await marketAdmin();

    // Verification is required first (platform default).
    const early = await s.owner.call(request.POST, { params: p, body: {} });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('verification_required');

    // Missing documents, wrong kind for a salon, bad IBAN, bad file type.
    expect((await s.owner.call(submit.POST, { params: p, body: {} })).body.error.code).toBe('documents_missing');
    expect((await uploadDoc(s.owner, s.slug, 'freelance_document')).body.error.code).toBe('document_not_required');
    expect((await uploadDoc(s.owner, s.slug, 'iban', { iban: 'SA0000' })).body.error.code).toBe('invalid_iban');
    const html = await upload(s.owner, docs.POST, p, { kind: 'owner_id', file: new Blob(['<html><script>alert(1)</script>'], { type: 'application/pdf' }) });
    expect(html.body.error.code).toBe('unsupported_file');

    await uploadDoc(s.owner, s.slug, 'commercial_register');
    await uploadDoc(s.owner, s.slug, 'owner_id');
    const ib = await uploadDoc(s.owner, s.slug, 'iban', { iban: VALID_IBAN });
    expect(ib.status).toBe(201);
    const docsNow = ib.body.data.verification.documents as Array<{ id: string; kind: string; iban_masked: string | null }>;
    expect(docsNow.map((d) => d.kind).sort()).toEqual(['commercial_register', 'iban', 'owner_id']);
    expect(docsNow.find((d) => d.kind === 'iban')!.iban_masked).toBe('SA03 •••• 7519');
    expect(JSON.stringify(ib.body)).not.toContain(VALID_IBAN);
    const own = await s.owner.call(ownDoc.GET, { params: { ...p, id: docsNow[0]!.id } });
    expect(own.status).toBe(200);

    // A business cannot verify or approve itself, even with direct SQL in its own scope (DB guard).
    await expect(withTenant(s.tenantId, (trx) => sql`update tenant_verifications set status = 'verified' where tenant_id = ${s.tenantId}`.execute(trx))).rejects.toThrow();
    await expect(withTenant(s.tenantId, (trx) => sql`insert into marketplace_listings (tenant_id, status) values (${s.tenantId}, 'approved')`.execute(trx))).rejects.toThrow();

    expect((await s.owner.call(submit.POST, { params: p, body: {} })).status).toBe(200);
    // Locked while under review.
    expect((await uploadDoc(s.owner, s.slug, 'owner_id')).body.error.code).toBe('verification_under_review');

    // Platform queue + detail (full IBAN for reviewers) + document file.
    const q = await admin.call(verifications.GET, { query: { status: 'pending' } });
    expect(q.body.data.items.some((i: any) => i.tenant_id === s.tenantId)).toBe(true);
    const det = await admin.call(verificationDetail.GET, { params: { tenantId: s.tenantId } });
    expect(det.body.data.documents.find((d: any) => d.kind === 'iban').iban).toBe(VALID_IBAN);
    const file = await admin.call(platformDoc.GET, { params: { id: docsNow[0]!.id } });
    expect(file.status).toBe(200);
    expect(file.headers.get('cache-control')).toContain('no-store');

    // Reject needs a reason; then the business fixes and resubmits.
    expect((await admin.call(reviewVerification.POST, { params: { tenantId: s.tenantId }, body: { decision: 'reject' } })).status).toBe(422);
    const rej = await admin.call(reviewVerification.POST, { params: { tenantId: s.tenantId }, body: { decision: 'reject', reason: 'صورة الهوية غير واضحة' } });
    expect(rej.body.data.status).toBe('rejected');
    const st = await s.owner.call(status.GET, { params: p });
    expect(st.body.data.verification.status).toBe('rejected');
    expect(st.body.data.verification.rejection_reason).toBe('صورة الهوية غير واضحة');
    expect((await uploadDoc(s.owner, s.slug, 'owner_id')).status).toBe(201);
    await s.owner.call(submit.POST, { params: p, body: {} });
    expect((await admin.call(reviewVerification.POST, { params: { tenantId: s.tenantId }, body: { decision: 'approve' } })).body.data.status).toBe('verified');

    // Join request → rejected with reason → re-request → approved.
    expect((await s.owner.call(request.POST, { params: p, body: {} })).body.data.listing.status).toBe('pending');
    expect((await s.owner.call(request.POST, { params: p, body: {} })).body.error.code).toBe('already_requested');
    expect(await listed(s.slug)).toBe(false);
    const lq = await admin.call(listings.GET, { query: { status: 'pending' } });
    expect(lq.body.data.items.some((i: any) => i.tenant_id === s.tenantId)).toBe(true);
    await admin.call(reviewListing.POST, { params: { tenantId: s.tenantId }, body: { decision: 'reject', reason: 'أكملي صور الخدمات' } });
    const afterRej = await s.owner.call(status.GET, { params: p });
    expect(afterRej.body.data.listing).toMatchObject({ status: 'rejected', rejection_reason: 'أكملي صور الخدمات' });
    await s.owner.call(request.POST, { params: p, body: {} });
    await admin.call(reviewListing.POST, { params: { tenantId: s.tenantId }, body: { decision: 'approve' } });
    expect(await listed(s.slug)).toBe(true);
    const ok = await s.owner.call(status.GET, { params: p });
    expect(ok.body.data.visible).toBe(true);
    expect(ok.body.data.listing.commission_bp).toBe(1000);

    // The business hides itself any time, and comes back without a new review.
    await s.owner.call(status.PATCH, { params: p, method: 'PATCH', body: { hidden: true } });
    expect(await listed(s.slug)).toBe(false);
    await s.owner.call(status.PATCH, { params: p, method: 'PATCH', body: { hidden: false, tagline_ar: 'أجمل إطلالة' } });
    expect(await listed(s.slug)).toBe(true);
  });

  it('platform setting can drop the verification requirement; permissions are enforced', async () => {
    const admin = await marketAdmin();
    const s = await makeSalon();
    await publish(s);
    const p = { tenantSlug: s.slug };

    // Only the owner (business.manage) manages the marketplace listing.
    const manager = await addMember(s.owner, s.slug, 'manager');
    expect((await manager.call(status.GET, { params: p })).status).toBe(403);
    expect((await manager.call(request.POST, { params: p, body: {} })).status).toBe(403);
    // Another business cannot see this one's documents.
    const other = await makeSalon();
    expect((await other.owner.call(status.GET, { params: p })).status).toBe(404);

    // Platform: no platform role → 404; support_admin reviews but cannot set commission or settings.
    const plain = new TestClient();
    expect((await plain.call(listings.GET)).status).toBe(401);
    expect((await s.owner.call(listings.GET)).status).toBe(404);
    const support = await platformUser('support_admin');
    expect((await support.call(listings.GET)).status).toBe(200);
    await stepUp(support);
    expect((await support.call(commission.PUT, { method: 'PUT', params: { tenantId: s.tenantId }, body: { commission_bp: 500 } })).status).toBe(404);
    expect((await support.call(settings.PUT, { method: 'PUT', body: { require_verification: false } })).status).toBe(404);
    const reviewer = await platformUser('policy_reviewer');
    expect((await reviewer.call(verifications.GET)).status).toBe(404);

    // Commission & settings need step-up.
    const fresh = await platformUser('platform_owner', 'Owner 2');
    await expireStepUp(fresh.identifier);
    expect((await fresh.call(commission.PUT, { method: 'PUT', params: { tenantId: s.tenantId }, body: { commission_bp: 500 } })).status).toBe(401);
    await stepUp(admin);
    const c = await admin.call(commission.PUT, { method: 'PUT', params: { tenantId: s.tenantId }, body: { commission_bp: 750 } });
    expect(c.body.data.effective_bp).toBe(750);
    expect((await admin.call(summary.GET, { params: { tenantId: s.tenantId } })).body.data).toMatchObject({ commission_bp: 750, effective_bp: 750, listing_status: 'draft' });

    try {
      expect((await admin.call(settings.PUT, { method: 'PUT', body: { require_verification: false } })).body.data.require_verification).toBe(false);
      expect((await s.owner.call(request.POST, { params: p, body: {} })).status).toBe(200);
      await admin.call(reviewListing.POST, { params: { tenantId: s.tenantId }, body: { decision: 'approve' } });
      expect(await listed(s.slug)).toBe(true);
    } finally {
      await admin.call(settings.PUT, { method: 'PUT', body: { require_verification: true } });
    }
    // Back to required: the unverified business leaves the marketplace.
    expect(await listed(s.slug)).toBe(false);
  });
});
