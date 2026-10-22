import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiError, aiStatus, runAi, setAiProviderForTests, type AiProvider } from '@/server/infra/ai';
import { withSystem, withTenant } from '@/server/db/client';
import { registerJob } from '@/server/jobs/registry';
import { runDueJobs } from '@/server/jobs/runner';
import { schedule } from '@/server/infra/outbox';
import { createBusinessFor, signup } from '../helpers/factory';

const req = { promptKey: 'test', promptVersion: '1', system: 's', input: { a: 1 }, jsonSchema: {}, schemaName: 't' };

describe('AI adapter', () => {
  afterEach(() => setAiProviderForTests(undefined));

  it('reports disconnected honestly when no key/model is configured', async () => {
    setAiProviderForTests(undefined);
    expect((await aiStatus()).state).toBe('disconnected');
    const biz = await createBusinessFor(await signup());
    await expect(runAi({ tenantId: biz.tenantId, request: req, validator: z.object({}), inputSummary: {} })).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('rejects schema-invalid output after bounded retries and records the runs', async () => {
    const biz = await createBusinessFor(await signup());
    let calls = 0;
    const fake: AiProvider = { name: 'fake', model: 'fake-1', generate: async () => { calls++; return { output: { wrong: true }, usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 1, provider: 'fake', model: 'fake-1' }; } };
    setAiProviderForTests(fake);
    await expect(runAi({ tenantId: biz.tenantId, request: req, validator: z.object({ title: z.string() }), inputSummary: {}, maxFormatRetries: 1 })).rejects.toMatchObject({ kind: 'invalid_output' });
    expect(calls).toBe(2);
    const runs = await withTenant(biz.tenantId, (trx) => trx.selectFrom('ai_runs').select('status').execute());
    expect(runs.map((r) => r.status)).toEqual(['invalid_output', 'invalid_output']);
  });

  it('surfaces rate limits and timeouts without fabricating output', async () => {
    const biz = await createBusinessFor(await signup());
    setAiProviderForTests({ name: 'fake', model: 'f', generate: async () => { throw new AiError('rate_limited', 'slow down', true); } });
    await expect(runAi({ tenantId: biz.tenantId, request: req, validator: z.any(), inputSummary: {} })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('caches by tenant-scoped key and never serves another tenant’s cache', async () => {
    const a = await createBusinessFor(await signup());
    const b = await createBusinessFor(await signup());
    let n = 0;
    setAiProviderForTests({ name: 'fake', model: 'f', generate: async () => ({ output: { v: ++n }, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, provider: 'fake', model: 'f' }) });
    const v = z.object({ v: z.number() });
    const r1 = await runAi({ tenantId: a.tenantId, request: req, validator: v, inputSummary: {}, cacheKey: 'same-key' });
    const r2 = await runAi({ tenantId: a.tenantId, request: req, validator: v, inputSummary: {}, cacheKey: 'same-key' });
    const r3 = await runAi({ tenantId: b.tenantId, request: req, validator: v, inputSummary: {}, cacheKey: 'same-key' });
    expect(r2.cached).toBe(true);
    expect(r2.output.v).toBe(r1.output.v);
    expect(r3.cached).toBe(false);
    expect(r3.output.v).not.toBe(r1.output.v);
  });
});

describe('job runner', () => {
  it('retries failures with backoff and stops after max attempts', async () => {
    let calls = 0;
    registerJob('test.flaky', async () => { calls++; throw new Error('boom'); });
    await withSystem('test', (trx) => schedule(trx, 'test.flaky', {}, { dedupeKey: `flaky-${Date.now()}`, maxAttempts: 2 }));
    await runDueJobs();
    await withSystem('test', (trx) => trx.updateTable('job_runs').set({ run_at: new Date(0) }).where('kind', '=', 'test.flaky').execute());
    await runDueJobs();
    const job = await withSystem('test', (trx) => trx.selectFrom('job_runs').selectAll().where('kind', '=', 'test.flaky').executeTakeFirstOrThrow());
    expect(calls).toBe(2);
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(2);
  });

  it('deduplicates scheduled jobs by key', async () => {
    const key = `dedupe-${Date.now()}`;
    await withSystem('test', async (trx) => { await schedule(trx, 'test.noop', {}, { dedupeKey: key }); await schedule(trx, 'test.noop', {}, { dedupeKey: key }); });
    const n = await withSystem('test', (trx) => trx.selectFrom('job_runs').select('id').where('dedupe_key', '=', key).execute());
    expect(n).toHaveLength(1);
  });
});
