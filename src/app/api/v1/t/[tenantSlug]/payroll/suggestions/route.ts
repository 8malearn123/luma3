import { route } from '@/server/http/route';
import { decideSuggestions, listSuggestions, suggestionDecisionInput, suggestionListInput } from '@/server/domains/hr/deductions';

/** GET lateness/absence/unpaid-leave deduction suggestions of a month (plus older pending ones). */
export const GET = route({
  auth: 'tenant', capability: 'payroll.view', input: suggestionListInput,
  handler: async ({ tenant, input }) => ({ data: await listSuggestions(tenant, input) }),
});
/** POST approve (→ payroll deduction) or reject suggestions. */
export const POST = route({
  auth: 'tenant', capability: 'payroll.manage', input: suggestionDecisionInput,
  handler: async ({ tenant, actor, input }) => ({ data: await decideSuggestions(tenant, actor, input) }),
});
