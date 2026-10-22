import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env';

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

let instance: Storage | null = null;
export function storage(): Storage {
  if (!instance) instance = new LocalStorage(path.resolve(process.cwd(), env().STORAGE_LOCAL_DIR));
  return instance;
}
