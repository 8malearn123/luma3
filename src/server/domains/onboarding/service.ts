import { sql } from 'kysely';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { featureEnabled, type TenantAccess } from '../../tenancy/access';
import { assertTenantAssets, dominantColors } from '../assets/service';
import { brandFromAnswers, layoutFromAnswers, pagesFromAnswers, type DefaultPageKind } from '../builder/generator';
import { readBrand, writeBrand } from '../builder/brand';
import { STEP_SCHEMAS, type OnboardingAnswers, type StepNumber } from '@/shared/onboarding';
import { paletteFromSeeds, type ThemeColors } from '@/shared/builder/theme';
import { normalizePhone } from '@/shared/phone';

export async function getOnboarding(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const row = await trx.selectFrom('onboarding_progress').selectAll().where('tenant_id', '=', access.tenantId).executeTakeFirst();
    if (!row) throw Errors.notFound('onboarding');
    const brand = await trx.selectFrom('brand_settings').select(['pending_palette']).where('tenant_id', '=', access.tenantId).executeTakeFirst();
    return {
      answers: row.answers as OnboardingAnswers,
      completed_steps: row.completed_steps,
      current_step: row.current_step,
      draft_generated_at: row.draft_generated_at,
      version: row.version,
      pending_palette: brand?.pending_palette ?? null,
    };
  });
}

/**
 * Saves one step (optional steps may be saved empty = skipped). Uses optimistic
 * concurrency so two devices editing the same onboarding cannot silently
 * overwrite each other.
 */
export async function saveStep(access: TenantAccess, actor: AuditActor, step: number, raw: unknown, expectedVersion: number) {
  const schema = STEP_SCHEMAS[step as StepNumber];
  if (!schema) throw Errors.invalid('invalid_step');
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })));
  const data = parsed.data as Record<string, unknown>;

  return withTenant(access.tenantId, async (trx) => {
    const row = await trx.selectFrom('onboarding_progress').selectAll().where('tenant_id', '=', access.tenantId).forUpdate().executeTakeFirstOrThrow();
    if (row.version !== expectedVersion) throw Errors.versionConflict(row.version);
    const answers = { ...(row.answers as OnboardingAnswers), [step]: data } as OnboardingAnswers;
    await applyStepSideEffects(trx, access, step as StepNumber, answers);

    const completed = [...new Set([...row.completed_steps, step])].sort((a, b) => a - b);
    const next = Math.min(8, Math.max(row.current_step, step + 1));
    const updated = await trx.updateTable('onboarding_progress').set({
      answers: JSON.stringify(answers), completed_steps: completed, current_step: next, version: row.version + 1, updated_by: actor.userId,
    }).where('tenant_id', '=', access.tenantId).returning(['version', 'current_step', 'completed_steps']).executeTakeFirstOrThrow();
    await audit(trx, actor, 'onboarding.step_saved', { tenantId: access.tenantId, data: { step } });
    return updated;
  });
}

async function applyStepSideEffects(trx: Tx, access: TenantAccess, step: StepNumber, a: OnboardingAnswers) {
  const tenantId = access.tenantId;
  if (step === 1 && a[1]) {
    // The slug is fixed at creation (changing it would break links); name/city/branch are editable.
    await trx.updateTable('tenants').set({ name: a[1].name, city: a[1].city ?? null }).where('id', '=', tenantId).execute();
    if (a[1].branch_name) await trx.updateTable('branches').set({ name: a[1].branch_name, city: a[1].city ?? null }).where('tenant_id', '=', tenantId).where('is_primary', '=', true).execute();
  }
  if (step === 2 && a[2]?.logo_asset_id) {
    await assertTenantAssets(trx, tenantId, [a[2].logo_asset_id]);
  }
  if (step === 7 && a[7]) {
    const s = a[7];
    if (s.cover_asset_id) await assertTenantAssets(trx, tenantId, [s.cover_asset_id]);
    const phone = s.phone ? normalizePhone(s.phone) : null;
    const whatsapp = s.whatsapp ? normalizePhone(s.whatsapp) : null;
    if (s.phone && !phone) throw Errors.invalid('invalid_phone', 'Enter a valid phone number');
    if (s.whatsapp && !whatsapp) throw Errors.invalid('invalid_phone', 'Enter a valid WhatsApp number');
    await trx.updateTable('tenant_settings').set({
      contact_phone: phone, contact_whatsapp: whatsapp, contact_email: s.email || null,
      social_links: JSON.stringify(s.social ?? {}), legal_address: s.address ?? null,
    }).where('tenant_id', '=', tenantId).execute();
    const branch = await trx.selectFrom('branches').select('id').where('tenant_id', '=', tenantId).where('is_primary', '=', true).executeTakeFirstOrThrow();
    await trx.updateTable('branches').set({ address: s.address ?? null, latitude: s.latitude ?? null, longitude: s.longitude ?? null, phone }).where('id', '=', branch.id).execute();
    if (s.hours) {
      for (const h of s.hours) if (h.closes <= h.opens) throw Errors.invalid('invalid_hours', 'Closing time must be after opening time');
      await trx.deleteFrom('branch_hours').where('tenant_id', '=', tenantId).where('branch_id', '=', branch.id).execute();
      if (s.hours.length) {
        await trx.insertInto('branch_hours').values(s.hours.map((h) => ({ tenant_id: tenantId, branch_id: branch.id, weekday: h.weekday, opens: h.opens, closes: h.closes }))).execute();
      }
    }
  }
}

/** Palette suggestions from an uploaded logo; stored as pending until the owner accepts. */
export async function suggestPaletteFromLogo(access: TenantAccess, assetId: string, mood: 'soft' | 'bold' | 'classic' = 'classic') {
  const seeds = await dominantColors(access, assetId);
  if (!seeds.length) return { seeds, palette: null };
  const palette = paletteFromSeeds(seeds, mood);
  await withTenant(access.tenantId, (trx) => trx.updateTable('brand_settings').set({ pending_palette: JSON.stringify({ source: 'logo', asset_id: assetId, seeds, palette }) })
    .where('tenant_id', '=', access.tenantId).execute());
  return { seeds, palette };
}

/** Palette preview from colour choices (no side effects). */
export function suggestPalette(seeds: string[], mood: 'soft' | 'bold' | 'classic', excluded: string[]): ThemeColors {
  return paletteFromSeeds(seeds, mood, excluded);
}

/**
 * Generates the initial storefront draft from the answers with deterministic
 * rules. Creates catalog entries ONLY for services the owner typed in step 5
 * (as hidden-until-reviewed drafts if no price was given). Never publishes.
 */
export async function generateDraft(access: TenantAccess, actor: AuditActor) {
  return withTenant(access.tenantId, async (trx) => {
    const row = await trx.selectFrom('onboarding_progress').selectAll().where('tenant_id', '=', access.tenantId).forUpdate().executeTakeFirstOrThrow();
    const answers = row.answers as OnboardingAnswers & { _meta?: { services_created?: boolean } };

    const current = await readBrand(trx, access.tenantId);
    const brand = brandFromAnswers(answers, current.brand);
    await writeBrand(trx, access.tenantId, brand, current.version, actor.userId, { brand_character: { traits: answers[3]?.traits ?? [], reference_style: answers[3]?.reference_style ?? null, description: answers[3]?.description ?? null } });

    await trx.updateTable('site_drafts').set({ layout: JSON.stringify(layoutFromAnswers(answers)), version: sql`version + 1`, updated_by: actor.userId })
      .where('tenant_id', '=', access.tenantId).execute();

    const pages = await trx.selectFrom('store_pages').select(['id', 'kind']).where('tenant_id', '=', access.tenantId).where('status', '=', 'active').execute();
    const pageIds: Partial<Record<DefaultPageKind, string>> = {};
    for (const p of pages) if (p.kind !== 'custom') pageIds[p.kind as DefaultPageKind] = p.id;
    const blocksByKind = pagesFromAnswers(answers, { pageIds, productsEnabled: featureEnabled(access, 'feature.products') });
    for (const [kind, blocks] of Object.entries(blocksByKind)) {
      const id = pageIds[kind as DefaultPageKind];
      if (!id) continue;
      await trx.updateTable('page_drafts').set({ blocks: JSON.stringify(blocks), version: sql`version + 1`, updated_by: actor.userId })
        .where('tenant_id', '=', access.tenantId).where('page_id', '=', id).execute();
    }

    let createdServices = 0;
    if (!answers._meta?.services_created && answers[5]?.services?.length) {
      const existing = await trx.selectFrom('services').select(sql<number>`count(*)::int`.as('n')).where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow();
      const limit = access.plan.features.get('limit.services');
      const room = limit?.limit == null ? Infinity : Math.max(0, limit.limit - existing.n);
      const seeds = answers[5].services.slice(0, room === Infinity ? undefined : room);
      for (const [i, s] of seeds.entries()) {
        const priced = typeof s.price_sar === 'number';
        await trx.insertInto('services').values({
          tenant_id: access.tenantId, name_ar: s.name, price_minor: Math.round((s.price_sar ?? 0) * 100), duration_min: s.duration_min ?? 60,
          // Without an owner-entered price the service stays hidden and inactive until reviewed.
          is_active: priced, is_visible: priced, sort: i,
        }).execute();
        createdServices++;
      }
      answers._meta = { ...(answers._meta ?? {}), services_created: true };
    }
    await trx.updateTable('onboarding_progress').set({ answers: JSON.stringify(answers), draft_generated_at: new Date(), version: row.version + 1 })
      .where('tenant_id', '=', access.tenantId).execute();
    await audit(trx, actor, 'onboarding.draft_generated', { tenantId: access.tenantId, data: { services_created: createdServices, generator: 'deterministic_v1' } });
    return { generator: 'deterministic_v1', ai_used: false, services_created: createdServices };
  });
}

export type ReadinessItem = { key: string; ok: boolean; action_path: string };

/** Pre-publication checklist. Publishing is allowed only when every item passes. */
export async function readiness(access: TenantAccess): Promise<{ ready: boolean; items: ReadinessItem[] }> {
  return withTenant(access.tenantId, async (trx) => {
    const base = `/app/${access.slug}`;
    const bookable = await sql<{ n: number }>`
      select count(*)::int as n from services s
      where s.tenant_id = ${access.tenantId} and s.is_active and s.archived_at is null
        and exists (select 1 from service_staff ss join staff_profiles sp on sp.id = ss.staff_id
                    where ss.service_id = s.id and sp.is_active and sp.archived_at is null)`.execute(trx);
    const staffWithHours = await sql<{ n: number }>`
      select count(distinct w.staff_id)::int as n from working_hours w join staff_profiles sp on sp.id = w.staff_id
      where w.tenant_id = ${access.tenantId} and sp.is_active and sp.archived_at is null`.execute(trx);
    const settings = await trx.selectFrom('tenant_settings').select(['contact_phone', 'contact_email', 'contact_whatsapp', 'booking_policy_confirmed_at'])
      .where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow();
    const items: ReadinessItem[] = [
      { key: 'bookable_service', ok: (bookable.rows[0]?.n ?? 0) > 0, action_path: `${base}/services` },
      { key: 'provider', ok: (staffWithHours.rows[0]?.n ?? 0) > 0, action_path: `${base}/team` },
      { key: 'working_schedule', ok: (staffWithHours.rows[0]?.n ?? 0) > 0, action_path: `${base}/team` },
      { key: 'contact_details', ok: !!(settings.contact_phone || settings.contact_email || settings.contact_whatsapp), action_path: `${base}/settings` },
      { key: 'booking_policy', ok: !!settings.booking_policy_confirmed_at, action_path: `${base}/settings` },
    ];
    return { ready: items.every((i) => i.ok), items };
  });
}
