import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import sharp from 'sharp';
import { z } from 'zod';
import { withSystem, withTenant } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { notifyUsers } from '../../infra/notify';
import { storage } from '../../infra/storage';
import type { TenantAccess } from '../../tenancy/access';
import { DATE_RE } from './common';
import { expiryThreshold, maskIdNumber } from './rules';

/**
 * The staff file (owner only — `staff_file.manage` is owner-only and cannot
 * be delegated). Employee number, nationality, residence, ID/iqama/border
 * number (masked; revealing it is audited), its expiry, the hire date
 * (staff_pay_profiles.employment_start), admin notes and private documents
 * with expiry dates. The staff member sees her own non-sensitive fields.
 */

export const MAX_DOC_BYTES = 10 * 1024 * 1024;

export const staffFileInput = z.object({
  employee_number: z.string().trim().min(1).max(40).nullable().optional(),
  nationality: z.string().trim().max(60).nullable().optional(),
  residence: z.string().trim().max(200).nullable().optional(),
  id_type: z.enum(['national_id', 'iqama', 'border_number']).nullable().optional(),
  id_number: z.string().trim().regex(/^[A-Za-z0-9-]{4,30}$/).nullable().optional(),
  id_expiry: z.string().regex(DATE_RE).nullable().optional(),
  hire_date: z.string().regex(DATE_RE).nullable().optional(),
  admin_notes: z.string().trim().max(4000).nullable().optional(),
}).strict();

async function readFile(access: TenantAccess, staffId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const staff = await trx.selectFrom('staff_profiles').select(['id', 'display_name']).where('id', '=', staffId).executeTakeFirst();
    if (!staff) throw Errors.notFound('staff');
    const [f, pay, docs] = await Promise.all([
      trx.selectFrom('staff_files').selectAll().where('staff_id', '=', staffId).executeTakeFirst(),
      trx.selectFrom('staff_pay_profiles').select(['employment_start']).where('staff_id', '=', staffId).executeTakeFirst(),
      trx.selectFrom('staff_documents').select(['id', 'title', 'mime', 'bytes', 'expires_on', 'created_at']).where('staff_id', '=', staffId).where('deleted_at', 'is', null).orderBy('created_at', 'desc').execute(),
    ]);
    return { staff, f, hire: pay?.employment_start ?? null, docs };
  });
}

/** Owner: the full file, with the ID number masked. */
export async function getStaffFile(access: TenantAccess, staffId: string) {
  const { staff, f, hire, docs } = await readFile(access, staffId);
  return {
    staff_id: staff.id, staff_name: staff.display_name, employee_number: f?.employee_number ?? null, nationality: f?.nationality ?? null, residence: f?.residence ?? null,
    id_type: f?.id_type ?? null, id_number_masked: maskIdNumber(f?.id_number ?? null), has_id_number: !!f?.id_number, id_expiry: f?.id_expiry ?? null,
    hire_date: hire, admin_notes: f?.admin_notes ?? null, updated_at: f?.updated_at ?? null,
    documents: docs.map((d) => ({ ...d, url: `/api/v1/t/${access.slug}/hr/staff-files/${staffId}/documents/${d.id}` })),
  };
}

/** Owner: every staff file in one list (expiry overview). */
export async function listStaffFiles(access: TenantAccess) {
  return withTenant(access.tenantId, async (trx) => {
    const staff = await trx.selectFrom('staff_profiles as s').leftJoin('staff_files as f', 'f.staff_id', 's.id').leftJoin('staff_pay_profiles as p', 'p.staff_id', 's.id')
      .select(['s.id as staff_id', 's.display_name as staff_name', 's.is_active', 'f.employee_number', 'f.nationality', 'f.id_type', 'f.id_expiry', 'p.employment_start as hire_date'])
      .where('s.archived_at', 'is', null).orderBy('s.sort').execute();
    const docs = await trx.selectFrom('staff_documents').select(['staff_id', 'expires_on']).where('deleted_at', 'is', null).where('expires_on', 'is not', null).execute();
    return staff.map((s) => ({ ...s, next_document_expiry: docs.filter((d) => d.staff_id === s.staff_id).map((d) => d.expires_on!).sort()[0] ?? null, document_count: docs.filter((d) => d.staff_id === s.staff_id).length }));
  });
}

export async function updateStaffFile(access: TenantAccess, actor: AuditActor, staffId: string, input: z.infer<typeof staffFileInput>) {
  await withTenant(access.tenantId, async (trx) => {
    const staff = await trx.selectFrom('staff_profiles').select('id').where('id', '=', staffId).executeTakeFirst();
    if (!staff) throw Errors.notFound('staff');
    const { hire_date, ...fields } = input;
    const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v === '' ? null : v]));
    if (input.employee_number) {
      const dup = await trx.selectFrom('staff_files').select('staff_id').where('employee_number', '=', input.employee_number).where('staff_id', '!=', staffId).executeTakeFirst();
      if (dup) throw Errors.conflict('employee_number_taken', 'This employee number is already used');
    }
    await trx.insertInto('staff_files').values({ tenant_id: access.tenantId, staff_id: staffId, ...set, updated_by: actor.userId })
      .onConflict((oc) => oc.columns(['tenant_id', 'staff_id']).doUpdateSet({ ...set, updated_by: actor.userId })).execute();
    if (hire_date !== undefined) {
      await trx.insertInto('staff_pay_profiles').values({ tenant_id: access.tenantId, staff_id: staffId, employment_start: hire_date, updated_by: actor.userId })
        .onConflict((oc) => oc.columns(['tenant_id', 'staff_id']).doUpdateSet({ employment_start: hire_date, updated_by: actor.userId })).execute();
    }
    // The ID number itself never goes into the audit log.
    await audit(trx, actor, 'hr.staff_file_updated', { tenantId: access.tenantId, targetType: 'staff', targetId: staffId, data: { fields: Object.keys(input) } });
  });
  return getStaffFile(access, staffId);
}

/** Owner: the unmasked ID number; every reveal is audited. */
export async function revealIdNumber(access: TenantAccess, actor: AuditActor, staffId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const f = await trx.selectFrom('staff_files').select(['id_type', 'id_number']).where('staff_id', '=', staffId).executeTakeFirst();
    if (!f?.id_number) throw Errors.notFound('id_number');
    await audit(trx, actor, 'hr.staff_id_revealed', { tenantId: access.tenantId, targetType: 'staff', targetId: staffId, data: { id_type: f.id_type } });
    return { id_type: f.id_type, id_number: f.id_number };
  });
}

/** The staff member's own file: non-sensitive fields only (no ID number, no admin notes, no files). */
export async function ownStaffFile(access: TenantAccess) {
  if (!access.staffProfileId) throw Errors.notFound('staff');
  const { f, hire, docs } = await readFile(access, access.staffProfileId);
  return {
    employee_number: f?.employee_number ?? null, nationality: f?.nationality ?? null, id_type: f?.id_type ?? null, id_expiry: f?.id_expiry ?? null, hire_date: hire,
    documents: docs.map((d) => ({ id: d.id, title: d.title, expires_on: d.expires_on })),
  };
}

// ── Documents ───────────────────────────────────────────────────────────────
/** Validates the content: PDF by signature, images decoded and re-encoded to WebP (metadata dropped). */
async function normalizeDocument(data: Buffer): Promise<{ data: Buffer; mime: 'application/pdf' | 'image/webp'; ext: string }> {
  if (!data.length) throw Errors.invalid('empty_file');
  if (data.length > MAX_DOC_BYTES) throw Errors.invalid('file_too_large', 'Maximum 10 MB');
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return { data, mime: 'application/pdf', ext: 'pdf' };
  try {
    const out = await sharp(data, { limitInputPixels: 40_000_000, animated: false }).rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    return { data: out, mime: 'image/webp', ext: 'webp' };
  } catch {
    throw Errors.invalid('unsupported_file', 'Use a PDF or an image');
  }
}

export async function uploadDocument(access: TenantAccess, actor: AuditActor, staffId: string, input: { data: Buffer; title: string; expires_on: string | null }) {
  const title = input.title.trim();
  if (!title || title.length > 120) throw Errors.invalid('document_title_required', 'Give the document a title');
  if (input.expires_on && (!DATE_RE.test(input.expires_on) || !DateTime.fromISO(input.expires_on).isValid)) throw Errors.invalid('invalid_date');
  const doc = await normalizeDocument(input.data);
  const id = randomUUID();
  const key = `tenants/${access.tenantId}/staff-documents/${id}.${doc.ext}`;
  await withTenant(access.tenantId, async (trx) => {
    const s = await trx.selectFrom('staff_profiles').select('id').where('id', '=', staffId).executeTakeFirst();
    if (!s) throw Errors.notFound('staff');
  });
  await storage().put(key, doc.data, doc.mime);
  try {
    return await withTenant(access.tenantId, async (trx) => {
      const r = await trx.insertInto('staff_documents').values({
        id, tenant_id: access.tenantId, staff_id: staffId, title, storage_key: key, mime: doc.mime, bytes: doc.data.length, expires_on: input.expires_on, uploaded_by: actor.userId,
      }).returning(['id', 'title', 'mime', 'bytes', 'expires_on', 'created_at']).executeTakeFirstOrThrow();
      await audit(trx, actor, 'hr.staff_document_uploaded', { tenantId: access.tenantId, targetType: 'staff', targetId: staffId, data: { document_id: id, title, expires_on: input.expires_on } });
      return r;
    });
  } catch (e) {
    await storage().delete(key);
    throw e;
  }
}

export async function downloadDocument(access: TenantAccess, actor: AuditActor, staffId: string, docId: string) {
  const d = await withTenant(access.tenantId, async (trx) => {
    const row = await trx.selectFrom('staff_documents').select(['id', 'storage_key', 'mime', 'title']).where('id', '=', docId).where('staff_id', '=', staffId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!row) throw Errors.notFound('document');
    await audit(trx, actor, 'hr.staff_document_viewed', { tenantId: access.tenantId, targetType: 'staff', targetId: staffId, data: { document_id: docId } });
    return row;
  });
  const data = await storage().get(d.storage_key);
  if (!data) throw Errors.notFound('document');
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': d.mime, 'Content-Length': String(data.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="document-${d.id}.${d.mime === 'application/pdf' ? 'pdf' : 'webp'}"`,
    },
  });
}

export const documentPatch = z.object({ title: z.string().trim().min(1).max(120).optional(), expires_on: z.string().regex(DATE_RE).nullable().optional() }).strict();

export async function updateDocument(access: TenantAccess, actor: AuditActor, staffId: string, docId: string, patch: z.infer<typeof documentPatch>) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('staff_documents').set(patch).where('id', '=', docId).where('staff_id', '=', staffId).where('deleted_at', 'is', null)
      .returning(['id', 'title', 'mime', 'bytes', 'expires_on', 'created_at']).executeTakeFirst();
    if (!r) throw Errors.notFound('document');
    await audit(trx, actor, 'hr.staff_document_updated', { tenantId: access.tenantId, targetType: 'staff', targetId: staffId, data: { document_id: docId, ...patch } });
    return r;
  });
}

export async function deleteDocument(access: TenantAccess, actor: AuditActor, staffId: string, docId: string) {
  const key = await withTenant(access.tenantId, async (trx) => {
    const r = await trx.updateTable('staff_documents').set({ deleted_at: new Date(), deleted_by: actor.userId }).where('id', '=', docId).where('staff_id', '=', staffId).where('deleted_at', 'is', null)
      .returning('storage_key').executeTakeFirst();
    if (!r) throw Errors.notFound('document');
    await audit(trx, actor, 'hr.staff_document_deleted', { tenantId: access.tenantId, targetType: 'staff', targetId: staffId, data: { document_id: docId } });
    return r.storage_key;
  });
  await storage().delete(key);
  return { deleted: true };
}

// ── Expiry alerts ───────────────────────────────────────────────────────────
/**
 * Alerts the owner(s) when an ID/iqama or a document expires within 60, 30 or
 * 7 days — once per threshold (notification dedupe key), so a missed day still
 * alerts and nothing repeats.
 */
export async function runExpiryAlerts(now = new Date()) {
  const due = await withSystem('hr: staff files and documents nearing expiry', async (trx) => {
    const horizon = DateTime.fromJSDate(now).plus({ days: 61 }).toISODate()!;
    const past = DateTime.fromJSDate(now).minus({ days: 1 }).toISODate()!;
    const ids = await trx.selectFrom('staff_files as f').innerJoin('staff_profiles as s', 's.id', 'f.staff_id').innerJoin('tenants as t', 't.id', 'f.tenant_id')
      .select(['f.tenant_id', 'f.staff_id', 's.display_name', 'f.id_type', 'f.id_expiry as expires_on', 't.slug', 't.timezone'])
      .where('f.id_expiry', 'is not', null).where('f.id_expiry', '<=', horizon).where('f.id_expiry', '>=', past).where('s.archived_at', 'is', null).execute();
    const docs = await trx.selectFrom('staff_documents as d').innerJoin('staff_profiles as s', 's.id', 'd.staff_id').innerJoin('tenants as t', 't.id', 'd.tenant_id')
      .select(['d.id', 'd.tenant_id', 'd.staff_id', 's.display_name', 'd.title', 'd.expires_on', 't.slug', 't.timezone'])
      .where('d.deleted_at', 'is', null).where('d.expires_on', 'is not', null).where('d.expires_on', '<=', horizon).where('d.expires_on', '>=', past).where('s.archived_at', 'is', null).execute();
    return { ids, docs };
  });
  let sent = 0;
  const items = [
    ...due.ids.map((r) => ({ ...r, ref: `id:${r.staff_id}`, label_ar: r.id_type === 'iqama' ? 'الإقامة' : r.id_type === 'border_number' ? 'رقم الحدود' : 'الهوية', label_en: r.id_type === 'iqama' ? 'Iqama' : r.id_type === 'border_number' ? 'Border number' : 'ID' })),
    ...due.docs.map((r) => ({ ...r, ref: `doc:${r.id}`, label_ar: r.title, label_en: r.title })),
  ];
  for (const it of items) {
    const today = DateTime.fromJSDate(now, { zone: it.timezone }).toISODate()!;
    const t = expiryThreshold(it.expires_on!, today);
    if (t == null) continue;
    await withTenant(it.tenant_id, async (trx) => {
      const owners = await trx.selectFrom('tenant_memberships').select('user_id').where('role', '=', 'owner').where('status', '=', 'active').execute();
      await notifyUsers(trx, it.tenant_id, owners.map((o) => o.user_id), {
        kind: 'hr.document_expiring',
        title_ar: `${it.display_name}: ${it.label_ar} تنتهي خلال ${t} يوم (${it.expires_on})`,
        title_en: `${it.display_name}: ${it.label_en} expires within ${t} days (${it.expires_on})`,
        target_path: `/app/${it.slug}/team?tab=files&file=${it.staff_id}`,
        data: { staff_id: it.staff_id, expires_on: it.expires_on, threshold: t },
        dedupe_key: `hr-expiry:${it.ref}:${it.expires_on}:${t}`,
      });
    });
    sent++;
  }
  return { checked: items.length, alerts: sent };
}
