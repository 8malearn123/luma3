import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { addEvidence } from '@/server/domains/policy/incidents';
import { incidentEvidenceInput } from '@/shared/schemas/policy';

/** POST — attach a private evidence asset (uploaded with purpose=evidence) or a note. */
export const POST = route({
  auth: 'tenant', capability: ['incidents.submit', 'incidents.review'], input: incidentEvidenceInput,
  handler: async ({ tenant, actor, params, input }) => ({ status: 201, data: await addEvidence(tenant, actor, requireUuidParam(params, 'id'), input) }),
});
