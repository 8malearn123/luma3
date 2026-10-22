import { afterAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/server/env';
import { resetStorage, storage } from '@/server/infra/storage';

describe('database storage driver (STORAGE_DRIVER=db)', () => {
  afterAll(() => { delete process.env.STORAGE_DRIVER; resetEnvCache(); resetStorage(); });

  it('stores, overwrites, reads and deletes files; rejects unsafe keys', async () => {
    process.env.STORAGE_DRIVER = 'db';
    resetEnvCache(); resetStorage();
    const s = storage();
    const key = `tenants/${crypto.randomUUID()}/assets/x.webp`;
    await s.put(key, Buffer.from('one'), 'image/webp');
    await s.put(key, Buffer.from('two'), 'image/webp');
    expect((await s.get(key))?.toString()).toBe('two');
    await s.delete(key);
    expect(await s.get(key)).toBeNull();
    await expect(s.put('../etc/passwd', Buffer.from('x'), 'text/plain')).rejects.toThrow('invalid storage key');
  });
});
