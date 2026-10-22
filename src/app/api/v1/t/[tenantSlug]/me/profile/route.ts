import { route } from '@/server/http/route';
import { getOwnProfile, updateOwnProfile } from '@/server/domains/team/service';
import { ownProfilePatch } from '@/shared/schemas/team';

/** GET own linked staff profile (404 when the account is not linked to one). */
export const GET = route({
  auth: 'tenant', capability: ['staff.edit_own_profile', 'schedule.view_own'],
  handler: async ({ tenant }) => ({ data: await getOwnProfile(tenant) }),
});

/** PATCH own staff profile — specialists may change only allowlisted fields. */
export const PATCH = route({
  auth: 'tenant', capability: 'staff.edit_own_profile', input: ownProfilePatch,
  handler: async ({ tenant, actor, input }) => ({ data: await updateOwnProfile(tenant, actor, input) }),
});
