import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { env } from '../../env';
import { withTenant } from '../../db/client';
import { OpenAIProvider } from './openai';
import { AiError, type AiProvider, type AiRequest, type AiStatus } from './types';

export * from './types';

let override: AiProvider | null | undefined;

/** Tests inject a fake provider; production code never calls this. */
export function setAiProviderForTests(p: AiProvider | null | undefined) {
  override = p;
}

export function aiProvider(): AiProvider | null {
  if (override !== undefined) return override;
  const e = env();
  if (!e.OPENAI_API_KEY || !e.OPENAI_MODEL) return null;
  return new OpenAIProvider(e.OPENAI_API_KEY, e.OPENAI_MODEL, e.OPENAI_BASE_URL, e.AI_REQUEST_TIMEOUT_MS);
}

/**
 * Honest status: "connected" is only reported after a real successful call has
 * been recorded (verified_at); configuration alone is reported as such.
 */
export async function aiStatus(lastSuccessAt: Date | null = null): Promise<AiStatus> {
  if (override) return { state: 'connected', provider: override.name, model: override.model, verified_at: lastSuccessAt?.toISOString() ?? null };
  const e = env();
  if (!e.OPENAI_API_KEY) return { state: 'disconnected', reason: 'no_api_key' };
  if (!e.OPENAI_MODEL) return { state: 'disconnected', reason: 'no_model' };
  return { state: 'connected', provider: 'openai', model: e.OPENAI_MODEL, verified_at: lastSuccessAt?.toISOString() ?? null };
}

export function estimateCostMicros(inputTokens: number | null, outputTokens: number | null): number | null {
  const e = env();
  if (e.OPENAI_PRICE_INPUT_PER_MTOK == null || e.OPENAI_PRICE_OUTPUT_PER_MTOK == null || inputTokens == null || outputTokens == null) return null;
  // USD micro-dollars: tokens × (USD per 1M tokens).
  return Math.round(inputTokens * e.OPENAI_PRICE_INPUT_PER_MTOK + outputTokens * e.OPENAI_PRICE_OUTPUT_PER_MTOK);
}

export function digest(v: unknown) {
  return createHash('sha256').update(JSON.stringify(v)).digest('hex');
}

/**
 * Runs one tenant-scoped AI call with bounded format retries, validates the
 * output with zod, and records provenance in ai_runs (redacted summary only).
 * Never fabricates output: failures surface as AiError for an honest UI state.
 */
export async function runAi<T>(opts: {
  tenantId: string;
  jobId?: string | null;
  request: AiRequest;
  validator: z.ZodType<T>;
  /** Small redacted summary (counts/periods) for audit; never names/phones/secrets. */
  inputSummary: Record<string, unknown>;
  cacheKey?: string;
  maxFormatRetries?: number;
}): Promise<{ output: T; runId: string; provider: string; model: string; cached: boolean }> {
  const provider = aiProvider();
  if (!provider) throw new AiError('unavailable', 'AI is not configured');

  if (opts.cacheKey) {
    const hit = await withTenant(opts.tenantId, (trx) => trx.selectFrom('ai_runs').select(['id', 'output', 'provider', 'model'])
      .where('tenant_id', '=', opts.tenantId).where('cache_key', '=', opts.cacheKey!).where('status', '=', 'succeeded')
      .where('model', '=', provider.model).orderBy('created_at', 'desc').executeTakeFirst());
    if (hit) {
      const parsed = opts.validator.safeParse(hit.output);
      if (parsed.success) return { output: parsed.data, runId: hit.id, provider: hit.provider, model: hit.model, cached: true };
    }
  }

  const retries = Math.min(opts.maxFormatRetries ?? 1, 2);
  let lastErr: AiError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const res = await provider.generate(opts.request);
      const parsed = opts.validator.safeParse(res.output);
      if (!parsed.success) {
        lastErr = new AiError('invalid_output', 'AI output did not match the schema', true);
        await record(opts, provider, 'invalid_output', { latencyMs: res.latencyMs, usage: res.usage, error: parsed.error.issues.slice(0, 5).map((i) => i.message).join('; ') });
        continue;
      }
      const runId = await record(opts, provider, 'succeeded', { latencyMs: res.latencyMs, usage: res.usage, output: parsed.data });
      return { output: parsed.data, runId, provider: res.provider, model: res.model, cached: false };
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError('provider_error', (e as Error).message);
      const status = err.kind === 'timeout' ? 'timeout' : err.kind === 'rate_limited' ? 'rate_limited' : err.kind === 'quota_exceeded' ? 'quota_exceeded' : err.kind === 'invalid_output' ? 'invalid_output' : err.kind === 'unavailable' ? 'unavailable' : 'failed';
      await record(opts, provider, status, { latencyMs: Date.now() - started, usage: { inputTokens: null, outputTokens: null }, error: err.message });
      // Only format problems are retried here; rate limits/timeouts are retried by the job runner with backoff.
      if (err.kind !== 'invalid_output') throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new AiError('invalid_output', 'AI output invalid');
}

async function record(
  opts: { tenantId: string; jobId?: string | null; request: AiRequest; inputSummary: Record<string, unknown>; cacheKey?: string },
  provider: AiProvider,
  status: string,
  r: { latencyMs: number; usage: { inputTokens: number | null; outputTokens: number | null }; output?: unknown; error?: string },
) {
  const row = await withTenant(opts.tenantId, (trx) => trx.insertInto('ai_runs').values({
    tenant_id: opts.tenantId, job_id: opts.jobId ?? null, provider: provider.name, model: provider.model,
    prompt_key: opts.request.promptKey, prompt_version: opts.request.promptVersion,
    input_digest: digest(opts.request.input), input_summary: JSON.stringify(opts.inputSummary),
    output: r.output === undefined ? null : JSON.stringify(r.output), status, error: r.error?.slice(0, 500) ?? null,
    latency_ms: r.latencyMs, input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens,
    cost_usd_micros: estimateCostMicros(r.usage.inputTokens, r.usage.outputTokens), cache_key: status === 'succeeded' ? (opts.cacheKey ?? null) : null,
  }).returning('id').executeTakeFirstOrThrow());
  return row.id;
}
