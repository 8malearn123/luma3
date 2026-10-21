import { Errors } from '../../http/errors';

/** Offset pagination with an opaque cursor; fetch `limit + 1` rows and pass them to page(). */
export function offsetOf(cursor: string | undefined): number {
  if (!cursor) return 0;
  let o: unknown;
  try {
    o = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown }).o;
  } catch {
    throw Errors.invalid('invalid_cursor');
  }
  return typeof o === 'number' && Number.isInteger(o) && o >= 0 && o <= 100_000 ? o : 0;
}

export function page<T>(rows: T[], limit: number, offset: number) {
  const more = rows.length > limit;
  return {
    items: more ? rows.slice(0, limit) : rows,
    next_cursor: more ? Buffer.from(JSON.stringify({ o: offset + limit })).toString('base64url') : null,
  };
}

/** Escapes LIKE wildcards in user search input. */
export function likeTerm(q: string) {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
