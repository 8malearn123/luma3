import { z } from 'zod';

const txt = (n: number) => z.string().trim().max(n);

export const staffInput = z.object({
  display_name: txt(120).min(1),
  display_name_en: txt(120).optional().nullable(),
  title_ar: txt(120).optional().nullable(),
  title_en: txt(120).optional().nullable(),
  bio_ar: txt(2000).optional().nullable(),
  bio_en: txt(2000).optional().nullable(),
  photo_asset_id: z.string().uuid().nullable().optional(),
  is_public: z.boolean().default(true),
  branch_ids: z.array(z.string().uuid()).max(20).optional(),
  service_ids: z.array(z.string().uuid()).max(300).optional(),
});

export const staffPatch = staffInput.partial().extend({ is_active: z.boolean().optional() });

/** Fields a specialist may change on her own profile. */
export const ownProfilePatch = z.object({
  bio_ar: txt(2000).optional().nullable(),
  bio_en: txt(2000).optional().nullable(),
  photo_asset_id: z.string().uuid().nullable().optional(),
}).strict();

export const inviteInput = z.object({
  identifier: z.string().trim().min(3).max(254),
  role: z.enum(['manager', 'receptionist', 'specialist', 'finance']),
  granted_capabilities: z.array(z.string()).max(30).default([]),
  staff_profile_id: z.string().uuid().nullable().optional(),
  expires_in_days: z.number().int().min(1).max(14).default(7),
});

export const membershipPatch = z.object({
  role: z.enum(['manager', 'receptionist', 'specialist', 'finance']).optional(),
  granted_capabilities: z.array(z.string()).max(30).optional(),
  revoked_capabilities: z.array(z.string()).max(30).optional(),
  status: z.enum(['active', 'suspended', 'removed']).optional(),
  staff_profile_id: z.string().uuid().nullable().optional(),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const weeklyHoursInput = z.object({
  branch_id: z.string().uuid(),
  ranges: z.array(z.object({ weekday: z.number().int().min(0).max(6), start_time: hhmm, end_time: hhmm })).max(42),
  breaks: z.array(z.object({ weekday: z.number().int().min(0).max(6), start_time: hhmm, end_time: hhmm, label: txt(60).optional() })).max(42).default([]),
});

export const overrideInput = z.object({
  branch_id: z.string().uuid(),
  on_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(['off', 'replace', 'extra']),
  start_time: hhmm.optional(),
  end_time: hhmm.optional(),
  note: txt(200).optional(),
});

export const timeBlockInput = z.object({
  branch_id: z.string().uuid(),
  staff_id: z.string().uuid().optional(),
  resource_id: z.string().uuid().optional(),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
  reason: txt(200).optional(),
});

export const leaveInput = z.object({
  staff_id: z.string().uuid().optional(),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
  leave_type: z.enum(['annual', 'sick', 'personal', 'other']).default('annual'),
  reason: txt(500).optional(),
});

export const leaveDecision = z.object({ decision: z.enum(['approved', 'rejected']), note: txt(500).optional() });
