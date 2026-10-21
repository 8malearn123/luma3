import { AiError, type AiProvider, type AiRequest, type AiResponse } from './types';

/**
 * OpenAI Responses API adapter with strict JSON-schema structured output.
 * Server-side only; the API key never leaves the server and is never logged.
 */
export class OpenAIProvider implements AiProvider {
  readonly name = 'openai';
  constructor(private apiKey: string, readonly model: string, private baseUrl: string, private defaultTimeoutMs: number) {}

  async generate(req: AiRequest): Promise<AiResponse> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), req.timeoutMs ?? this.defaultTimeoutMs);
    const onAbort = () => controller.abort(new Error('cancelled'));
    req.signal?.addEventListener('abort', onAbort);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: [
            { role: 'system', content: req.system },
            { role: 'user', content: JSON.stringify(req.input) },
          ],
          text: { format: { type: 'json_schema', name: req.schemaName, schema: req.jsonSchema, strict: true } },
          ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
        }),
        signal: controller.signal,
      });
    } catch (e) {
      const reason = String((controller.signal.reason as Error | undefined)?.message ?? (e as Error).message);
      if (reason === 'cancelled') throw new AiError('cancelled', 'Request cancelled');
      if (reason === 'timeout' || (e as Error).name === 'AbortError') throw new AiError('timeout', 'AI provider timed out', true);
      throw new AiError('unavailable', 'AI provider unreachable', true);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }

    const body = await res.json().catch(() => null) as any;
    if (!res.ok) {
      const code = body?.error?.code ?? body?.error?.type ?? '';
      if (res.status === 401 || res.status === 403) throw new AiError('unavailable', 'AI provider rejected the credentials');
      if (res.status === 429 && /quota/i.test(String(code))) throw new AiError('quota_exceeded', 'AI quota exhausted');
      if (res.status === 429) throw new AiError('rate_limited', 'AI provider rate limited', true);
      if (res.status >= 500) throw new AiError('provider_error', `AI provider error ${res.status}`, true);
      throw new AiError('provider_error', `AI request rejected (${res.status})`);
    }
    const text: string | undefined = body?.output_text
      ?? body?.output?.flatMap((o: any) => o?.content ?? []).find((c: any) => c?.type === 'output_text')?.text;
    if (!text) throw new AiError('invalid_output', 'AI returned no text output', true);
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new AiError('invalid_output', 'AI output was not valid JSON', true);
    }
    return {
      output,
      usage: { inputTokens: body?.usage?.input_tokens ?? null, outputTokens: body?.usage?.output_tokens ?? null },
      latencyMs: Date.now() - started,
      provider: this.name,
      model: body?.model ?? this.model,
    };
  }
}
