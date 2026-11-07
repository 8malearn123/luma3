import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { deleteDocument, documentPatch, downloadDocument, updateDocument } from '@/server/domains/hr/files';

/** GET the document file (owner only, audited). */
export const GET = route({
  auth: 'tenant', capability: 'staff_file.manage',
  handler: async ({ tenant, actor, params }) => downloadDocument(tenant, actor, requireUuidParam(params, 'staffId'), requireUuidParam(params, 'docId')),
});
export const PATCH = route({
  auth: 'tenant', capability: 'staff_file.manage', input: documentPatch,
  handler: async ({ tenant, actor, params, input }) => ({ data: await updateDocument(tenant, actor, requireUuidParam(params, 'staffId'), requireUuidParam(params, 'docId'), input) }),
});
export const DELETE = route({
  auth: 'tenant', capability: 'staff_file.manage',
  handler: async ({ tenant, actor, params }) => ({ data: await deleteDocument(tenant, actor, requireUuidParam(params, 'staffId'), requireUuidParam(params, 'docId')) }),
});
