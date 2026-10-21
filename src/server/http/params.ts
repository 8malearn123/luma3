import { isUuid } from '../db/client';
import { Errors } from './errors';

/** Path ids are validated before touching the database; malformed ids are plain 404s. */
export function requireUuidParam(params: Record<string, string>, key: string): string {
  const v = params[key];
  if (!isUuid(v)) throw Errors.notFound();
  return v;
}
