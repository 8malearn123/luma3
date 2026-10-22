import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { db, withTenant, type Tx } from '../../db/client';
import { Errors, isPgCode } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import type { SessionUser } from '../../auth/service';
import { DEFAULT_LAYOUT } from '@/shared/builder/blocks';
import { NEUTRAL_BRAND } from '@/shared/builder/theme';
import { DEFAULT_PAGES } from '../builder/generator';
import type { createBusinessSchema } from '@/shared/onboarding';
import type { z } from 'zod';

const RESERVED_SLUGS = new Set([
  'app', 'api', 'platform', 'admin', 's', 'preview', 'auth', 'account', 'discover', 'pricing', 'onboarding', 'staff',
  'luma', 'www', 'help', 'support', 'static', 'assets', 'login', 'register', 'settings', 'billing', 'status', 'mail',
]);
const MAX_OWNED_BUSINESSES = 5;

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;

/**
 * Creates a business workspace and assigns the caller as its owner in ONE
 * trusted transaction. The role is set server-side; nothing about roles,
 * plans or tenant ids is accepted from the browser.
 */
export async function createBusiness(user: SessionUser, input: CreateBusinessInput, actor: AuditActor) {
  if (RESERVED_SLUGS.has(input.slug)) throw Errors.conflict('slug_taken', 'This address is not available');

  const owned = await sql<{ n: number }>`select count(*)::int as n from app.memberships_for_user(${user.userId}) where role = 'owner'`.execute(db());
  if ((owned.rows[0]?.n ?? 0) >= MAX_OWNED_BUSINESSES) throw Errors.invalid('business_limit', 'You have reached the maximum number of businesses');

  const plan = await db().selectFrom('plans').select(['id', 'code', 'trial_days', 'status'])
    .where('code', '=', input.plan_code ?? 'sanaa').where('status', '=', 'active').executeTakeFirst();
  if (!plan) throw Errors.invalid('plan_unavailable', 'The selected plan is not available');

  const tenantId = randomUUID();
  const ownerIsProvider = input.owner_is_provider ?? input.business_type === 'expert';
  try {
    return await withTenant(tenantId, async (trx) => {
      await trx.insertInto('tenants').values({
        id: tenantId, slug: input.slug, name: input.name, business_type: input.business_type, city: input.city ?? null,
        status: 'onboarding', created_by: user.userId, is_demo: user.isDemo,
      }).execute();
      await trx.insertInto('tenant_settings').values({
        tenant_id: tenantId, contact_email: user.email, contact_phone: user.phone, time_format: user.timeFormat,
        // Experts often take bookings without a separate team calendar; defaults are editable.
        notify_channels: ['in_app'],
      }).execute();
      const branch = await trx.insertInto('branches').values({
        tenant_id: tenantId, name: input.branch_name || input.name, city: input.city ?? null, is_primary: true,
      }).returning('id').executeTakeFirstOrThrow();

      let staffProfileId: string | null = null;
      if (ownerIsProvider) {
        const sp = await trx.insertInto('staff_profiles').values({ tenant_id: tenantId, display_name: user.displayName, is_public: true })
          .returning('id').executeTakeFirstOrThrow();
        staffProfileId = sp.id;
        await trx.insertInto('staff_branch_assignments').values({ tenant_id: tenantId, staff_id: sp.id, branch_id: branch.id }).execute();
      }
      await trx.insertInto('tenant_memberships').values({
        tenant_id: tenantId, user_id: user.userId, role: 'owner', staff_profile_id: staffProfileId, created_by: user.userId,
      }).execute();

      const trialEnds = new Date(Date.now() + plan.trial_days * 86_400_000);
      const sub = await trx.insertInto('subscriptions').values({
        tenant_id: tenantId, plan_id: plan.id, status: 'trialing', trial_ends_at: trialEnds,
        current_period_start: new Date(), current_period_end: trialEnds,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('subscription_events').values({
        tenant_id: tenantId, subscription_id: sub.id, kind: 'trial_started', to_status: 'trialing', actor_user_id: user.userId,
        data: JSON.stringify({ plan: plan.code, trial_days: plan.trial_days }),
      }).execute();

      await initStorefront(trx, tenantId, user.userId);
      await trx.insertInto('onboarding_progress').values({
        tenant_id: tenantId,
        answers: JSON.stringify({ 1: { name: input.name, business_type: input.business_type, city: input.city, branch_name: input.branch_name, slug: input.slug } }),
        completed_steps: [1], current_step: 2, updated_by: user.userId,
      }).execute();
      await trx.insertInto('loyalty_programs').values({ tenant_id: tenantId }).execute();
      await trx.insertInto('marketing_preferences').values({ tenant_id: tenantId }).execute();

      await audit(trx, actor, 'tenant.created', { tenantId, targetType: 'tenant', targetId: tenantId, data: { slug: input.slug, plan: plan.code } });
      return { tenantId, slug: input.slug, branchId: branch.id, staffProfileId };
    });
  } catch (err) {
    if (isPgCode(err, '23505')) throw Errors.conflict('slug_taken', 'This address is already taken');
    throw err;
  }
}

/** Default brand (neutral, not LUMA's palette), layout and page drafts. */
async function initStorefront(trx: Tx, tenantId: string, userId: string) {
  await trx.insertInto('brand_settings').values({
    tenant_id: tenantId,
    colors: JSON.stringify(NEUTRAL_BRAND.colors),
    fonts: JSON.stringify(NEUTRAL_BRAND.fonts),
    radius: NEUTRAL_BRAND.radius, button_style: NEUTRAL_BRAND.button_style, card_style: NEUTRAL_BRAND.card_style,
    density: NEUTRAL_BRAND.density, spacing_scale: NEUTRAL_BRAND.spacing_scale, updated_by: userId,
  }).execute();
  await trx.insertInto('site_drafts').values({ tenant_id: tenantId, layout: JSON.stringify(DEFAULT_LAYOUT), updated_by: userId }).execute();
  for (const p of DEFAULT_PAGES) {
    const page = await trx.insertInto('store_pages').values({
      tenant_id: tenantId, kind: p.kind, slug: p.slug, title_ar: p.title_ar, title_en: p.title_en,
      show_in_nav: p.nav, show_in_footer: p.footer, sort: p.sort,
    }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('page_drafts').values({ tenant_id: tenantId, page_id: page.id, blocks: JSON.stringify([]), updated_by: userId }).execute();
  }
}

export async function slugAvailable(slug: string) {
  if (RESERVED_SLUGS.has(slug)) return false;
  const r = await sql<{ id: string }>`select id from app.resolve_tenant_slug(${slug})`.execute(db());
  return r.rows.length === 0;
}
