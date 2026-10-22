import { afterAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/server/env';
import * as cron from '@/app/api/v1/internal/cron/route';

const call = (auth?: string) => cron.GET(new Request('http://localhost/api/v1/internal/cron', { headers: auth ? { authorization: auth } : {} }));

describe('scheduled job endpoint (serverless worker)', () => {
  afterAll(() => { delete process.env.CRON_SECRET; resetEnvCache(); });

  it('does not exist without CRON_SECRET or with a wrong secret', async () => {
    delete process.env.CRON_SECRET; resetEnvCache();
    expect((await call('Bearer anything')).status).toBe(404);
    process.env.CRON_SECRET = 'cron-secret-cron-secret-0123456789'; resetEnvCache();
    expect((await call()).status).toBe(404);
    expect((await call('Bearer cron-secret-cron-secret-012345678X')).status).toBe(404);
  });

  it('runs periodic tasks at most once per interval across calls', async () => {
    process.env.CRON_SECRET = 'cron-secret-cron-secret-0123456789'; resetEnvCache();
    const first = await (await call('Bearer cron-secret-cron-secret-0123456789')).json();
    expect(first.ok).toBe(true);
    expect(first.periodic.length).toBeGreaterThan(0);
    const second = await (await call('Bearer cron-secret-cron-secret-0123456789')).json();
    expect(second.periodic).toEqual([]);
  });
});
