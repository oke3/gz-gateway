// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * Request proxying — forwards chat completion requests to upstream LLM providers.
 *
 * Responsibilities:
 *   - Transform OpenAI-format requests into provider-specific formats.
 *   - Handle response normalization back to OpenAI format.
 *   - Timeout support (configurable per-request).
 *   - Retry with exponential backoff on transient failures.
 *
 * Supported providers:
 *   - openai   → passthrough (already OpenAI format)
 *   - anthropic → Messages API format
 *   - google   → Gemini API format
 *   - deepseek → OpenAI-compatible (passthrough)
 *   - groq     → OpenAI-compatible (passthrough)
 *   - custom   → passthrough
 *
 * Usage:
 *   const { response, latencyMs } = await proxyRequest(provider, request);
 */

import type {
  ProviderConfig,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../core/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProxyResult {
  response: ChatCompletionResponse;
  latencyMs: number;
}

export interface ProxyConfig {
  /** Default timeout in ms (overridable per-request via x-gateway-timeout). */
  defaultTimeoutMs: number;
  /** Maximum number of retry attempts. */
  maxRetries: number;
  /** Base delay in ms for exponential backoff. */
  retryDelayMs: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  defaultTimeoutMs: 30_000,
  maxRetries: 2,
  retryDelayMs: 500,
};

/** HTTP status codes that are safe to retry. */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

// ── Format Transformers ──────────────────────────────────────────────────────

/**
 * Transform an OpenAI-format request into Anthropic Messages API format.
 *
 * Anthropic differences:
 *   - Uses `system` as a top-level field (not a message).
 *   - Uses `max_tokens` (required).
 *   - Message content can be a string or array of content blocks.
 */
function toAnthropicFormat(
  request: ChatCompletionRequest,
): Record<string, unknown> {
  const systemMessages = request.messages.filter((m) => m.role === 'system');
  const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

  return {
    model: request.model,
    max_tokens: request.max_tokens ?? 4096,
    system: systemMessages.map((m) => m.content ?? '').join('\n') || undefined,
    messages: nonSystemMessages.map((m) => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: m.content ?? '',
    })),
    temperature: request.temperature,
    top_p: request.top_p,
    stop_sequences: request.stop
      ? Array.isArray(request.stop)
        ? request.stop
        : [request.stop]
      : undefined,
  };
}

/**
 * Transform an OpenAI-format request into Google Gemini API format.
 *
 * Gemini differences:
 *   - Uses `contents` array with `role` and `parts`.
 *   - System instruction is a separate top-level field.
 *   - Generation config is nested under `generationConfig`.
 */
function toGoogleFormat(
  request: ChatCompletionRequest,
): Record<string, unknown> {
  const systemMessages = request.messages.filter((m) => m.role === 'system');
  const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

  return {
    model: request.model,
    contents: nonSystemMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content ?? '' }],
    })),
    systemInstruction:
      systemMessages.length > 0
        ? { parts: [{ text: systemMessages.map((m) => m.content ?? '').join('\n') }] }
        : undefined,
    generationConfig: {
      temperature: request.temperature,
      topP: request.top_p,
      maxOutputTokens: request.max_tokens,
      stopSequences: request.stop
        ? Array.isArray(request.stop)
          ? request.stop
          : [request.stop]
        : undefined,
    },
  };
}

/**
 * Parse an Anthropic response and normalize to OpenAI format.
 */
function normalizeAnthropicResponse(
  raw: Record<string, unknown>,
  model: string,
  latencyMs: number,
): ChatCompletionResponse {
  const content = raw.content as Array<{ type: string; text: string }> | undefined;
  const text = content?.map((c) => c.text).join('') ?? '';
  const stopReason = raw.stop_reason as string | undefined;

  let finishReason: ChatCompletionResponse['choices'][0]['finish_reason'] = 'stop';
  if (stopReason === 'max_tokens') finishReason = 'length';
  else if (stopReason === 'tool_use') finishReason = 'tool_calls';

  const usage = raw.usage as { input_tokens: number; output_tokens: number } | undefined;

  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
    'x-gateway-latency-ms': latencyMs,
  };
}

/**
 * Parse a Google Gemini response and normalize to OpenAI format.
 */
function normalizeGoogleResponse(
  raw: Record<string, unknown>,
  model: string,
  latencyMs: number,
): ChatCompletionResponse {
  const candidates = raw.candidates as Array<{
    content?: { parts?: Array<{ text: string }> };
    finishReason?: string;
  }> | undefined;

  const text = candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  const finishReason = candidates?.[0]?.finishReason;

  let normalizedFinish: ChatCompletionResponse['choices'][0]['finish_reason'] = 'stop';
  if (finishReason === 'MAX_TOKENS') normalizedFinish = 'length';

  const usage = raw.usageMetadata as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  } | undefined;

  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: normalizedFinish,
      },
    ],
    usage: {
      prompt_tokens: usage?.promptTokenCount ?? 0,
      completion_tokens: usage?.candidatesTokenCount ?? 0,
      total_tokens: usage?.totalTokenCount ?? 0,
    },
    'x-gateway-latency-ms': latencyMs,
  };
}

// ── Core Proxy ───────────────────────────────────────────────────────────────

/**
 * Send an HTTP request with a timeout.
 *
 * Uses `AbortController` to enforce the timeout. The timeout is reset
 * on each chunk received (for streaming), but for non-streaming we
 * use a hard deadline.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Proxy a chat completion request to the specified provider.
 *
 * Handles:
 *   1. Format transformation (OpenAI → provider-native).
 *   2. Upstream HTTP request with timeout.
 *   3. Response normalization (provider-native → OpenAI).
 *   4. Retry with exponential backoff on transient errors.
 */
export async function proxyRequest(
  provider: ProviderConfig,
  request: ChatCompletionRequest,
  config: Partial<ProxyConfig> = {},
): Promise<ProxyResult> {
  const cfg = { ...DEFAULT_PROXY_CONFIG, ...config };
  const timeoutMs =
    (request['x-gateway-timeout'] as number | undefined) ?? cfg.defaultTimeoutMs;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    // Exponential backoff: 500ms, 1000ms, 2000ms, ...
    if (attempt > 0) {
      const delay = cfg.retryDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const start = Date.now();

    try {
      // ── Build upstream request ──
      let upstreamBody: Record<string, unknown>;
      let upstreamPath: string;

      switch (provider.type) {
        case 'anthropic':
          upstreamBody = toAnthropicFormat(request);
          upstreamPath = '/v1/messages';
          break;
        case 'google':
          upstreamBody = toGoogleFormat(request);
          upstreamPath = `/v1beta/models/${request.model}:generateContent`;
          break;
        default:
          // openai, deepseek, groq, custom — passthrough.
          upstreamBody = request as unknown as Record<string, unknown>;
          upstreamPath = '/v1/chat/completions';
          break;
      }

      const url = provider.baseUrl.replace(/\/+$/, '') + upstreamPath;

      // ── Build headers ──
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...provider.headers,
      };

      // Provider-specific auth headers.
      if (provider.type === 'anthropic') {
        headers['x-api-key'] = provider.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else if (provider.type === 'google') {
        // Google uses query param for API key.
        const separator = url.includes('?') ? '&' : '?';
        upstreamBody.key = provider.apiKey;
      } else {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }

      // ── Send request ──
      const upstreamResponse = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(upstreamBody),
        },
        timeoutMs,
      );

      const latencyMs = Date.now() - start;

      // ── Handle upstream errors ──
      if (!upstreamResponse.ok) {
        const errorBody = await upstreamResponse.text();
        const error = new Error(
          `Upstream ${provider.id} returned ${upstreamResponse.status}: ${errorBody}`,
        );
        (error as Error & { status: number }).status = upstreamResponse.status;

        // Only retry on transient errors.
        if (RETRYABLE_STATUS_CODES.has(upstreamResponse.status)) {
          lastError = error;
          continue;
        }

        // Non-retryable error — throw immediately.
        throw error;
      }

      // ── Parse and normalize response ──
      const rawResponse = (await upstreamResponse.json()) as Record<string, unknown>;

      let normalized: ChatCompletionResponse;

      switch (provider.type) {
        case 'anthropic':
          normalized = normalizeAnthropicResponse(rawResponse, request.model, latencyMs);
          break;
        case 'google':
          normalized = normalizeGoogleResponse(rawResponse, request.model, latencyMs);
          break;
        default:
          // OpenAI-compatible — use as-is, add latency header.
          normalized = {
            ...(rawResponse as unknown as ChatCompletionResponse),
            'x-gateway-latency-ms': latencyMs,
            'x-gateway-provider': provider.id,
          };
          break;
      }

      normalized['x-gateway-provider'] = provider.id;
      return { response: normalized, latencyMs };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;

      // If it's an AbortError (timeout), check if we should retry.
      if (error.name === 'AbortError') {
        if (attempt < cfg.maxRetries) continue;
      }

      // Network errors are retryable.
      if (attempt < cfg.maxRetries && isRetryableError(error)) {
        continue;
      }

      throw error;
    }
  }

  // All retries exhausted.
  throw lastError ?? new Error('Proxy request failed after all retries');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determine if an error is retryable (network-level failures).
 */
function isRetryableError(error: Error): boolean {
  const retryablePatterns = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'socket hang up',
  ];

  const message = error.message.toLowerCase();
  return retryablePatterns.some(
    (pattern) =>
      message.includes(pattern.toLowerCase()) ||
      error.name === 'AbortError',
  );
}
