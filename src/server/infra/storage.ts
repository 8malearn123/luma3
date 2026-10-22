import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'kysely';
import { env } from '../env';
import { db } from '../db/client';

/**
 * Object storage adapter. The local driver stores files outside the web root
 * and they are only served through authorised routes. A production deployment
 * implements the same interface for S3-compatible storage (signed URLs).
 */
export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-z0-9][a-z0-9/_.-]{1,200}$/;

class LocalStorage implements Storage {
  constructor(private root: string) {}
  private resolve(key: string) {
    if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error('invalid storage key');
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('invalid storage key');
    return full;
  }
  async put(key: string, data: Buffer) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { mode: 0o640 });
  }
  async get(key: string) {
    try {
      return await readFile(this.resolve(key));
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await rm(this.resolve(key), { force: true });
  }
}

/** Files in PostgreSQL (STORAGE_DRIVER=db) for serverless hosts with no persistent disk. */
class DbStorage implements Storage {
  private check(key: string) {
    if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error('invalid storage key');
  }
  async put(key: string, data: Buffer, contentType: string) {
    this.check(key);
    await sql`insert into stored_files (key, content, content_type, bytes) values (${key}, ${data}, ${contentType}, ${data.length})
      on conflict (key) do update set content = excluded.content, content_type = excluded.content_type, bytes = excluded.bytes`.execute(db());
  }
  async get(key: string) {
    this.check(key);
    const r = await sql<{ content: Buffer }>`select content from stored_files where key = ${key}`.execute(db());
    return r.rows[0]?.content ?? null;
  }
  async delete(key: string) {
    this.check(key);
    await sql`delete from stored_files where key = ${key}`.execute(db());
  }
}

let instance: Storage | null = null;
export function storage(): Storage {
  if (!instance) {
    instance = env().STORAGE_DRIVER === 'db' ? new DbStorage() : new LocalStorage(path.resolve(process.cwd(), env().STORAGE_LOCAL_DIR));
  }
  return instance;
}

/** Test helper: forget the cached driver after changing STORAGE_DRIVER. */
export function resetStorage() {
  instance = null;
}
