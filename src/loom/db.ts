/**
 * The only database surface Loom uses: the shared tenant-scoped client.
 * Loom code reads LUMA data exclusively through the connector (schema
 * loom_export) and writes exclusively to schema loom. See docs/LOOM_CORE.md.
 */
export { sql, withSystem, withTenant, type Tx } from '@/server/db/client';
export { audit, type AuditActor } from '@/server/infra/audit';
export { AppError, Errors } from '@/server/http/errors';
export { schedule } from '@/server/infra/outbox';
export { registerJob, registerPeriodic } from '@/server/jobs/registry';
