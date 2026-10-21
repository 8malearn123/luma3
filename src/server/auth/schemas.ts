import { z } from 'zod';

export const zLocale = z.enum(['ar', 'en']);
export const zIdentifier = z.string().trim().min(3).max(254);
export const zPassword = z.string().min(1).max(200);

export const registerSchema = z.object({
  identifier: zIdentifier,
  password: zPassword,
  display_name: z.string().trim().min(1).max(120),
  locale: zLocale.default('ar'),
});
export const verifySchema = z.object({ identifier: zIdentifier, code: z.string().trim().regex(/^\d{6}$/) });
export const loginSchema = z.object({ identifier: zIdentifier, password: zPassword });
export const recoveryRequestSchema = z.object({ identifier: zIdentifier, locale: zLocale.default('ar') });
export const recoveryResetSchema = z.object({ identifier: zIdentifier, code: z.string().trim().regex(/^\d{6}$/), new_password: zPassword });
export const changePasswordSchema = z.object({ current_password: zPassword, new_password: zPassword });
export const reauthSchema = z.object({ password: zPassword });
