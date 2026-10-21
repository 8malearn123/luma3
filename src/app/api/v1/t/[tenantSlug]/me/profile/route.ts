import { route } from '@/server/http/route';
import { updateOwnProfile } from '@/server/domains/team/service';
import { ownProfilePatch } from '@/shared/schemas/team';

/** PATCH own staff profile — specialists may change only allowlisted fields. */
export const PATCH = route({
  auth: 'tenant', capability: 'staff.edit_own_profile', input: ownProfilePatch,
  handler: async ({ tenant, actor, input }) => ({ data: await updateOwnProfile(tenant, actor, input) }),
});
