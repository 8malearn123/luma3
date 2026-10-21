/**
 * Application errors carry a stable machine code (translated on the client via
 * the i18n dictionary under `errors.<code>`) and an HTTP status.
 *
 * Rule: a record that exists in another tenant is reported exactly like a
 * record that does not exist (404 not_found) so identifiers cannot be probed.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthenticated: (msg = 'Authentication required') => new AppError(401, 'unauthenticated', msg),
  forbidden: (msg = 'You do not have permission to perform this action', details?: Record<string, unknown>) =>
    new AppError(403, 'forbidden', msg, details),
  notFound: (what = 'resource') => new AppError(404, 'not_found', `${what} not found`),
  conflict: (code: string, msg?: string, details?: Record<string, unknown>) => new AppError(409, code, msg, details),
  versionConflict: (current?: number) =>
    new AppError(409, 'version_conflict', 'This record was changed by someone else. Reload to see the latest version.', {
      current_version: current,
    }),
  invalid: (code: string, msg?: string, details?: Record<string, unknown>) => new AppError(422, code, msg, details),
  validation: (issues: unknown) => new AppError(422, 'validation_failed', 'Some fields are invalid', { issues }),
  rateLimited: (retryAfterSec: number) =>
    new AppError(429, 'rate_limited', 'Too many requests. Please wait and try again.', { retry_after_sec: retryAfterSec }),
  unavailable: (code: string, msg?: string, details?: Record<string, unknown>) => new AppError(503, code, msg, details),
  planLimit: (feature: string, limit?: number | null) =>
    new AppError(403, 'plan_limit_reached', `Your plan does not allow more of: ${feature}`, { feature, limit }),
  planFeature: (feature: string) => new AppError(403, 'plan_feature_unavailable', `Your plan does not include: ${feature}`, { feature }),
};

type PgError = { code?: string; constraint?: string; detail?: string; message?: string };

/** Maps PostgreSQL errors to application errors without leaking internals. */
export function fromPgError(err: unknown): AppError | null {
  const e = err as PgError;
  if (!e || typeof e.code !== 'string') return null;
  switch (e.code) {
    case '23P01': // exclusion_violation
      return new AppError(409, 'slot_unavailable', 'That time is no longer available', { constraint: e.constraint });
    case '23505': // unique_violation
      return new AppError(409, 'duplicate', 'This already exists', { constraint: e.constraint });
    case '23503': // foreign_key_violation (incl. cross-tenant composite FKs)
      return new AppError(422, 'invalid_reference', 'A referenced record does not exist', { constraint: e.constraint });
    case '23514': // check_violation
      return new AppError(422, 'constraint_violation', 'The request violates a business rule', { constraint: e.constraint });
    case '42501': // insufficient_privilege / RLS
      return new AppError(404, 'not_found', 'resource not found');
    case '40001':
    case '40P01':
      return new AppError(409, 'concurrent_update', 'Another change happened at the same time. Please retry.');
    case '22P02':
      return new AppError(422, 'invalid_input', 'Invalid input format');
    case '57014':
      return new AppError(503, 'timeout', 'The operation took too long');
    default:
      return null;
  }
}

export function isPgCode(err: unknown, code: string) {
  return (err as PgError)?.code === code;
}
