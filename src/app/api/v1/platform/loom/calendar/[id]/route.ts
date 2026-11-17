import { platformRoute } from '@/server/domains/platform/guard';
import { isUuid } from '@/server/db/client';
import { Errors } from '@/server/http/errors';
import { calendarReviewInput, reviewPlatformEvent } from '@/loom';

/** PATCH /api/v1/platform/loom/calendar/{id} — verify (note + optional corrected dates) | withdraw | restore. Audited. */
export const PATCH = platformRoute({
  platformCapability: 'platform.loom.manage', stepUp: true, input: calendarReviewInput,
  handler: async ({ input, actor, params }) => {
    if (!isUuid(params.id)) throw Errors.notFound('calendar_event');
    return { data: await reviewPlatformEvent(actor, params.id, input) };
  },
});
