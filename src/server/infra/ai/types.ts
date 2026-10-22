export type AiStatus =
  | { state: 'connected'; provider: string; model: string; verified_at: string | null }
  | { state: 'disconnected'; reason: 'no_api_key' | 'no_model' }
  | { state: 'misconfigured'; reason: string };

export type AiFailure = 'unavailable' | 'timeout' | 'rate_limited' | 'quota_exceeded' | 'invalid_output' | 'provider_error' | 'cancelled';

export class AiError extends Error {
  constructor(public kind: AiFailure, message: string, public retryable = false) {
    super(message);
  }
}

export type AiRequest = {
  promptKey: string;
  promptVersion: string;
  /** System instructions. Untrusted content must never be placed here. */
  system: string;
  /** Structured, redacted input. Untrusted text (web pages, customer messages) goes in clearly delimited fields. */
  input: Record<string, unknown>;
  /** JSON Schema for structured output (strict). */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputTokens?: number;
};

export type AiResponse = {
  output: unknown;
  usage: { inputTokens: number | null; outputTokens: number | null };
  latencyMs: number;
  provider: string;
  model: string;
};

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generate(req: AiRequest): Promise<AiResponse>;
}
