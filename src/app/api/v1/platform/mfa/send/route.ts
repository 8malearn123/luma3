import { platformRoute } from '@/server/domains/platform/guard';
import { sendWhatsappCode } from '@/server/domains/platform/mfa';

/** POST /api/v1/platform/mfa/send — one-time code to the administrator's WhatsApp number. */
export const POST = platformRoute({
  mfaExempt: true,
  rateLimit: { scope: 'user', limit: 5, windowSec: 900, name: 'mfa-send' },
  handler: async ({ user, actor }) => ({ data: await sendWhatsappCode(user, actor) }),
});
