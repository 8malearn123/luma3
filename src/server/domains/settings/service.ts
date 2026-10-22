import { sql } from 'kysely';
import type { z } from 'zod';
import { withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { channelStatus } from '../../infra/messaging';
import type { TenantAccess } from '../../tenancy/access';
import { normalizePhone } from '@/shared/phone';
import type {
  bookingPolicyInput, displayInput, legalTaxInput, notificationsInput, policyConfirmInput, profileInput,
} from '@/shared/schemas/settings';

/**
 * Tenant settings (business profile, booking policy, legal & tax, notification
 * channels, display). Every write is versioned by tenant_settings.version:
 * a stale version → 409 version_conflict, never a silent overwrite.
 */
export const BOOKING_POLICY_FIELDS = [
  'slot_increment_min', 'min_notice_min', 'max_advance_days', 'hold_ttl_sec', 'no_show_grace_min', 'max_gap_between_items_min', 'any_staff_rule',
  'free_cancellation_hours', 'late_cancellation_fee_bp', 'deposit_mode', 'deposit_percent_bp', 'deposit_fixed_minor', 'allow_full_prepay',
  'allow_pay_on_site', 'booking_requires_account', 'booking_policy_text_ar', 'booking_policy_text_en',
] as const;

async function writeVersioned(trx: Tx, tenantId: string, version: number, patch: Record<string, unknown>) {
  const r = await trx.updateTable('tenant_settings').set({ ...patch, version: sql`version + 1` })
    .where('tenant_id', '=', tenantId).where('version', '=', version).returning('version').executeTakeFirst();
  if (!r) {
    const cur = await trx.selectFrom('tenant_settings').select('version').where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!cur) throw Errors.notFound('settings');
    throw Errors.versionConflict(cur.version);
  }
  return r.version;
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>) {
  return Object.keys(after).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
}

export async function getSettings(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const tenant = await trx.selectFrom('tenants').select(['id', 'slug', 'name', 'city', 'default_locale', 'timezone', 'currency', 'status', 'business_type'])
      .where('id', '=', access.tenantId).executeTakeFirstOrThrow();
    const s = await trx.selectFrom('tenant_settings').selectAll().where('tenant_id', '=', access.tenantId).executeTakeFirst();
    if (!s) throw Errors.notFound('settings');
    return {
      tenant,
      settings: { ...s, social_links: (s.social_links ?? {}) as Record<string, string> },
      channel_status: { in_app: 'connected' as const, email: channelStatus('email'), sms: channelStatus('sms'), whatsapp: channelStatus('whatsapp') },
    };
  });
}

export async function updateProfile(access: TenantAccess, actor: AuditActor, input: z.infer<typeof profileInput>) {
  const phone = input.contact_phone ? normalizePhone(input.contact_phone) : null;
  const whatsapp = input.contact_whatsapp ? normalizePhone(input.contact_whatsapp) : null;
  if (input.contact_phone && !phone) throw Errors.invalid('invalid_phone', 'Enter a valid phone number');
  if (input.contact_whatsapp && !whatsapp) throw Errors.invalid('invalid_phone', 'Enter a valid WhatsApp number');
  const social = Object.fromEntries(Object.entries(input.social_links ?? {}).filter(([, v]) => !!v));
  return withTenant(access.tenantId, async (trx) => {
    const before = await trx.selectFrom('tenants').select(['name', 'city', 'default_locale', 'timezone']).where('id', '=', access.tenantId).executeTakeFirstOrThrow();
    const version = await writeVersioned(trx, access.tenantId, input.version, {
      contact_phone: phone, contact_whatsapp: whatsapp, contact_email: input.contact_email ? input.contact_email.toLowerCase() : null,
      ...(input.social_links !== undefined ? { social_links: JSON.stringify(social) } : {}),
    });
    const tenantPatch = { name: input.name, city: input.city ?? null, default_locale: input.default_locale, timezone: input.timezone };
    await trx.updateTable('tenants').set(tenantPatch).where('id', '=', access.tenantId).execute();
    await audit(trx, actor, 'settings.profile_updated', { tenantId: access.tenantId, targetType: 'tenant', targetId: access.tenantId, data: { changed: changedKeys(before, tenantPatch) } });
    return { version };
  });
}

/**
 * Booking/payment/cancellation terms. Changing any term clears the owner's
 * "I have reviewed the booking & payment policy" confirmation, so the
 * readiness checklist asks for a fresh review of the new terms.
 */
export async function updateBookingPolicy(access: TenantAccess, actor: AuditActor, input: z.infer<typeof bookingPolicyInput>) {
  const { version: expected, ...values } = input;
  return withTenant(access.tenantId, async (trx) => {
    const before = await trx.selectFrom('tenant_settings').select([...BOOKING_POLICY_FIELDS]).where('tenant_id', '=', access.tenantId).executeTakeFirstOrThrow();
    const patch = { ...values, booking_policy_text_ar: values.booking_policy_text_ar ?? null, booking_policy_text_en: values.booking_policy_text_en ?? null };
    const changed = changedKeys(before as Record<string, unknown>, patch);
    const version = await writeVersioned(trx, access.tenantId, expected, { ...patch, ...(changed.length ? { booking_policy_confirmed_at: null } : {}) });
    await audit(trx, actor, 'settings.booking_policy_updated', { tenantId: access.tenantId, targetType: 'tenant_settings', targetId: access.tenantId, data: { changed } });
    return { version, confirmation_cleared: changed.length > 0 };
  });
}

export async function confirmBookingPolicy(access: TenantAccess, actor: AuditActor, input: z.infer<typeof policyConfirmInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const at = new Date();
    const version = await writeVersioned(trx, access.tenantId, input.version, { booking_policy_confirmed_at: at });
    await audit(trx, actor, 'settings.booking_policy_confirmed', { tenantId: access.tenantId, targetType: 'tenant_settings', targetId: access.tenantId });
    return { version, booking_policy_confirmed_at: at };
  });
}

/** Legal identity and tax rules are settings only; no tax/e-invoicing compliance is claimed. */
export async function updateLegalTax(access: TenantAccess, actor: AuditActor, input: z.infer<typeof legalTaxInput>) {
  const { version: expected, ...v } = input;
  return withTenant(access.tenantId, async (trx) => {
    const version = await writeVersioned(trx, access.tenantId, expected, {
      legal_name: v.legal_name ?? null, tax_number: v.tax_number ?? null, legal_address: v.legal_address ?? null,
      tax_rate_bp: v.tax_rate_bp, prices_include_tax: v.prices_include_tax, tax_label: v.tax_label ?? null,
    });
    await audit(trx, actor, 'settings.legal_tax_updated', { tenantId: access.tenantId, targetType: 'tenant_settings', targetId: access.tenantId, data: { tax_rate_bp: v.tax_rate_bp, prices_include_tax: v.prices_include_tax } });
    return { version };
  });
}

/** In-app is always on; other channels are preferences that still depend on a connected provider. */
export async function updateNotifications(access: TenantAccess, actor: AuditActor, input: z.infer<typeof notificationsInput>) {
  const channels = [...new Set(['in_app', ...input.notify_channels])];
  return withTenant(access.tenantId, async (trx) => {
    const version = await writeVersioned(trx, access.tenantId, input.version, { notify_channels: channels });
    await audit(trx, actor, 'settings.notifications_updated', { tenantId: access.tenantId, targetType: 'tenant_settings', targetId: access.tenantId, data: { channels } });
    return { version, notify_channels: channels, provider_status: { email: channelStatus('email'), sms: channelStatus('sms'), whatsapp: channelStatus('whatsapp') } };
  });
}

/** Display preference only; stored instants never change. */
export async function updateDisplay(access: TenantAccess, actor: AuditActor, input: z.infer<typeof displayInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const version = await writeVersioned(trx, access.tenantId, input.version, { time_format: input.time_format });
    await audit(trx, actor, 'settings.display_updated', { tenantId: access.tenantId, targetType: 'tenant_settings', targetId: access.tenantId, data: { time_format: input.time_format } });
    return { version };
  });
}
