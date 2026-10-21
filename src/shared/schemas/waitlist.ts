import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const waitlistJoinInput = z.object({
  service_id: z.string().uuid(),
  staff_id: z.string().uuid().nullable().optional(),
  branch_id: z.string().uuid().nullable().optional(),
  desired_from: date,
  desired_to: date,
  time_windows: z.array(z.object({ weekday: z.number().int().min(0).max(6).optional(), from: hhmm, to: hhmm }).strict()).max(14).optional(),
  /** Required to receive offers; entries without consent stay on the list but are never contacted. */
  notify_consent: z.boolean(),
}).strict();

export const groupSessionInput = z.object({
  branch_id: z.string().uuid(),
  service_id: z.string().uuid(),
  staff_id: z.string().uuid(),
  resource_id: z.string().uuid().nullable().optional(),
  starts_at: z.string().datetime({ offset: true }),
  capacity: z.number().int().min(1).max(500),
  price_minor: z.number().int().min(0).max(100_000_000).optional(),
  title_ar: z.string().trim().max(160).optional(),
  title_en: z.string().trim().max(160).optional(),
}).strict();

export const groupBookInput = z.object({ seats: z.number().int().min(1).max(20).default(1) }).strict();
