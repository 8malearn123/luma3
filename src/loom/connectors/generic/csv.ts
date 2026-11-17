import { StagedConnector } from './staged';

/**
 * CSV import connector (kind `csv_import`). Files are uploaded per entity
 * (templates.ts), validated against the template and the connection's
 * column mapping, and applied by a sync: each file is the full current state
 * of its entity, so records missing from a newer file version become
 * tombstones. The cursor per entity is the last applied file version.
 * Rows may also carry `_op=delete` for explicit deletions.
 */
export class CsvConnector extends StagedConnector {
  readonly kind = 'csv_import';
  readonly version = 'csv-1.0.0';
}
