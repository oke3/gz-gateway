// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * OpenAI-compatible /v1/chat/completions route handler.
 *
 * Pipeline: validate -> resolve provider -> rate limit -> cache check ->
 *           circuit breaker -> forward -> track cost -> cache -> respond.
 */

import { createHash } from 'node:crypto';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderConfig,
  GatewayConfig,
} from '../core/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface HandlerState {
  startedAt: number;
  rateLimits: Map<string, { requests: number; tokens: number; resetAt: number }>;
  perKeyRateLimits: Map<string, { requests: number; tokens: number; resetAt: number }>;
  circuits: Map<string, {
    state: 'closed' | 'open' | 'half-open';
    failures: number;
    lastFailure: number;
    successCount: number;
  }>;
  cache: Map<string, { key: string; response: ChatCompletionResponse; createdAt: number; hits: number }>;
  costs: Array<{
    timestamp: number; provider: string; model: string; apiKeyHash: string;
    promptTokens: number; completionTokens: number; cost: number;
    latencyMs: number; cached: boolean;
  }>;
  stats: {
    totalRequests: number;
    totalCost: number;
    totalLatencyMs: number;
    cacheHits: number;
    cacheMisses: number;
    requestsByProvider: Record<string, number>;
    requestsByModel: Record<string, number>;
    errorsByType: Record<string, number>;
  };
  roundRobinIndex: number;
  config: GatewayConfig;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hashString(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function buildCacheKey(req: ChatCompletionRequest): string {
  const payload = JSON.stringify({
    model: req.model,
    messages: req.messages,
    temperature: req.temperature,
    max_tokens: req.max_tokens,
    top_p: req.top_p,
    frequency_penalty: req.frequency_penalty,
    presence_penalty: req.presence_penalty,
    stop: req.stop,
    tools: req.tools,
    tool_choice: req.tool_choice,
  });
  return hashString(payload);
}

function hashApiKey(authorization: string | undefined): string {
  if (!authorization) return 'anon';
  return hashString(authorization);
}

function estimateTokens(req: ChatCompletionRequest): number {
  // Rough heuristic: ~4 chars per token, count all message content
  let chars = 0;
  for (const msg of req.messages) {
    if (typeof msg.content === 'string') chars += msg.content.length;
  }
  // Add 20% overhead for formatting/tokens
  return Math.ceil((chars / 4) * 1.2);
}

// ── JSON Response Helper ─────────────────────────────────────────────────────

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Access-Control-Allow-Origin', '*');
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

// ── Rate limiting ────────────────────────────────────────────────────────────

function checkRateLimit(
  buckets: Map<string, { requests: number; tokens: number; resetAt: number }>,
  key: string,
  limit: { requestsPerMinute: number; tokensPerMinute: number },
  estimatedTokens: number,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { requests: 0, tokens: 0, resetAt: now + 60_000 };
    buckets.set(key, bucket);
  }

  if (bucket.requests >= limit.requestsPerMinute) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }

  if (bucket.tokens + estimatedTokens > limit.tokensPerMinute) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }

  bucket.requests += 1;
  bucket.tokens += estimatedTokens;
  return { allowed: true, retryAfterMs: 0 };
}

// ── Circuit breaker ──────────────────────────────────────────────────────────

type CircuitMap = Map<string, {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  lastFailure: number;
  successCount: number;
}>;

function getCircuit(
  circuits: CircuitMap,
  providerId: string,
): { state: string; allowRequest: boolean } {
  const circuit = circuits.get(providerId);
  if (!circuit) return { state: 'closed', allowRequest: true };
  return { state: circuit.state, allowRequest: circuit.state !== 'open' };
}

function recordSuccess(circuits: CircuitMap, providerId: string): void {
  const circuit = circuits.get(providerId);
  if (!circuit) return;
  if (circuit.state === 'half-open') {
    circuit.successCount += 1;
    if (circuit.successCount >= 3) {
      circuit.state = 'closed';
      circuit.failures = 0;
      circuit.successCount = 0;
    }
  } else {
    circuit.failures = 0;
  }
}

function recordFailure(
  circuits: CircuitMap,
  providerId: string,
  threshold: number,
): void {
  const circuit = circuits.get(providerId);
  if (!circuit) return;
  circuit.failures += 1;
  circuit.lastFailure = Date.now();
  if (circuit.state === 'half-open') {
    circuit.state = 'open';
    circuit.successCount = 0;
  } else if (circuit.failures >= threshold) {
    circuit.state = 'open';
  }
}

// ── Load balancing ───────────────────────────────────────────────────────────

function resolveProvider(
  config: GatewayConfig,
  state: HandlerState,
  model: string,
): ProviderConfig | null {
  const eligible = config.providers.filter(
    (p) => p.enabled && p.models.includes(model),
  );
  if (eligible.length === 0) return null;

  const { threshold, resetMs } = config.failover.circuitBreaker;
  const available = eligible.filter((p) => {
    return getCircuit(state.circuits, p.id).allowRequest;
  });
  if (available.length === 0) return null;

  // Ensure circuits exist for timeout transition
  for (const p of available) {
    if (!state.circuits.has(p.id)) {
      state.circuits.set(p.id, {
        state: 'closed', failures: 0, lastFailure: 0, successCount: 0,
      });
    }
  }

  switch (config.loadBalancing.strategy) {
    case 'priority':
      return [...available].sort((a, b) => a.priority - b.priority)[0]!;
    case 'round-robin': {
      const idx = state.roundRobinIndex % available.length;
      state.roundRobinIndex = (state.roundRobinIndex + 1) % available.length;
      return available[idx]!;
    }
    case 'least-cost':
      return [...available].sort(
        (a, b) => a.costPer1kTokens.input - b.costPer1kTokens.input,
      )[0]!;
    case 'least-latency':
      return [...available].sort((a, b) => a.priority - b.priority)[0]!;
    default:
      return available[0]!;
  }
}

// ── Provider forwarding ──────────────────────────────────────────────────────

function stripGatewayFields(
  req: ChatCompletionRequest,
): Record<string, unknown> {
  const { 'x-gateway-cache': _, 'x-gateway-timeout': __, ...clean } =
    req as unknown as Record<string, unknown>;
  return clean;
}

interface ProviderResult {
  status: number;
  body: string;
}

async function forwardToProvider(
  provider: ProviderConfig,
  req: ChatCompletionRequest,
  timeoutMs: number,
): Promise<ProviderResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(provider.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + provider.apiKey,
        ...provider.headers,
      },
      body: JSON.stringify(stripGatewayFields(req)),
      signal: controller.signal,
    });
    return { status: upstream.status, body: await upstream.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function forwardStreaming(
  provider: ProviderConfig,
  req: ChatCompletionRequest,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(provider.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + provider.apiKey,
        ...provider.headers,
      },
      body: JSON.stringify(stripGatewayFields(req)),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleChatCompletion(
  _req: Request,
  body: unknown,
  config: GatewayConfig,
  state: HandlerState,
  rawAuth: string | undefined,
): Promise<Response> {
  const start = Date.now();

  // 1. Validate
  if (!body || typeof body !== 'object') {
    return jsonResponse(400, {
      error: { code: 'invalid_request', message: 'Request body must be a JSON object.' },
    });
  }
  const parsed = body as Record<string, unknown>;
  if (!parsed.model || typeof parsed.model !== 'string') {
    return jsonResponse(400, {
      error: { code: 'invalid_request', message: 'model is required and must be a string.' },
    });
  }
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return jsonResponse(400, {
      error: { code: 'invalid_request', message: 'messages must be a non-empty array.' },
    });
  }
  const chatReq = parsed as unknown as ChatCompletionRequest;

  // 2. Resolve provider
  const provider = resolveProvider(config, state, chatReq.model);
  if (!provider) {
    return jsonResponse(404, {
      error: {
        code: 'model_not_found',
        message: 'No enabled provider found for model "' + chatReq.model + '".',
      },
    });
  }

  // 3. Rate limit
  if (config.rateLimiting.enabled) {
    const estimated = estimateTokens(chatReq);
    const keyHash = hashApiKey(rawAuth);

    const globalCheck = checkRateLimit(
      state.rateLimits, '_global', config.rateLimiting.global, estimated,
    );
    if (!globalCheck.allowed) {
      return jsonResponse(429, {
        error: {
          code: 'rate_limit_exceeded',
          message: 'Global rate limit exceeded. Retry after ' + Math.ceil(globalCheck.retryAfterMs / 1000) + 's.',
        },
      }, { 'Retry-After': String(Math.ceil(globalCheck.retryAfterMs / 1000)) });
    }

    if (rawAuth) {
      const keyCheck = checkRateLimit(
        state.perKeyRateLimits, keyHash, config.rateLimiting.perApiKey, estimated,
      );
      if (!keyCheck.allowed) {
        return jsonResponse(429, {
          error: {
            code: 'rate_limit_exceeded',
            message: 'API key rate limit exceeded. Retry after ' + Math.ceil(keyCheck.retryAfterMs / 1000) + 's.',
          },
        }, { 'Retry-After': String(Math.ceil(keyCheck.retryAfterMs / 1000)) });
      }
    }
  }

  // 4. Cache check
  const cacheEnabled = config.caching.enabled && chatReq['x-gateway-cache'] !== false;
  const streamEnabled = chatReq.stream === true;

  if (cacheEnabled && !streamEnabled) {
    const key = buildCacheKey(chatReq);
    const entry = state.cache.get(key);
    if (entry && Date.now() - entry.createdAt < config.caching.ttlSeconds * 1000) {
      entry.hits += 1;
      state.stats.cacheHits += 1;
      const elapsed = Date.now() - start;
      return jsonResponse(200, {
        ...entry.response,
        'x-gateway-cache-hit': true,
        'x-gateway-latency-ms': elapsed,
      }, { 'X-Gateway-Cache': 'HIT' });
    }
    state.stats.cacheMisses += 1;
  }

  // 5. Forward (streaming)
  const timeoutMs = chatReq['x-gateway-timeout'] ?? 120_000;

  if (streamEnabled) {
    const upstreamRes = await forwardStreaming(provider, chatReq, timeoutMs);
    recordSuccess(state.circuits, provider.id);
    state.stats.totalRequests += 1;
    state.stats.requestsByProvider[provider.id] =
      (state.stats.requestsByProvider[provider.id] ?? 0) + 1;
    state.stats.requestsByModel[chatReq.model] =
      (state.stats.requestsByModel[chatReq.model] ?? 0) + 1;

    const headers = new Headers();
    headers.set('Content-Type', 'text/event-stream');
    headers.set('Cache-Control', 'no-cache');
    headers.set('Connection', 'keep-alive');
    headers.set('X-Gateway-Provider', provider.id);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(upstreamRes.body, { status: upstreamRes.status, headers });
  }

  // 5b. Forward (non-streaming with retry)
  let result: ProviderResult | null = null;
  const retries = config.failover.enabled ? config.failover.maxRetries : 0;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      result = await forwardToProvider(provider, chatReq, timeoutMs);
      if (result.status >= 200 && result.status < 300) {
        recordSuccess(state.circuits, provider.id);
        break;
      }
      lastError = 'Provider responded with status ' + result.status;
      recordFailure(state.circuits, provider.id, config.failover.circuitBreaker.threshold);
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      recordFailure(state.circuits, provider.id, config.failover.circuitBreaker.threshold);
    }
  }

  if (!result || result.status < 200 || result.status >= 300) {
    state.stats.errorsByType['provider_error'] =
      (state.stats.errorsByType['provider_error'] ?? 0) + 1;
    return jsonResponse(502, {
      error: { code: 'provider_error', message: lastError ?? 'All providers failed.' },
    });
  }

  // 6. Parse response
  let response: ChatCompletionResponse;
  try {
    response = JSON.parse(result.body) as ChatCompletionResponse;
  } catch {
    return jsonResponse(502, {
      error: { code: 'provider_error', message: 'Provider returned invalid JSON.' },
    });
  }

  const elapsed = Date.now() - start;

  // 7. Cost
  const promptTokens = response.usage?.prompt_tokens ?? 0;
  const completionTokens = response.usage?.completion_tokens ?? 0;
  const cost =
    (promptTokens * provider.costPer1kTokens.input +
      completionTokens * provider.costPer1kTokens.output) / 1000;

  // 8. Enrich
  response['x-gateway-cost'] = cost;
  response['x-gateway-latency-ms'] = elapsed;
  response['x-gateway-cache-hit'] = false;
  response['x-gateway-provider'] = provider.id;

  // 9. Cache
  if (cacheEnabled) {
    const key = buildCacheKey(chatReq);
    if (state.cache.size >= config.caching.maxEntries) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of state.cache) {
        if (v.createdAt < oldestTime) {
          oldestTime = v.createdAt;
          oldestKey = k;
        }
      }
      if (oldestKey) state.cache.delete(oldestKey);
    }
    state.cache.set(key, {
      key, response, createdAt: Date.now(), hits: 0,
    });
  }

  // 10. Track cost
  state.costs.push({
    timestamp: Date.now(),
    provider: provider.id,
    model: chatReq.model,
    apiKeyHash: hashApiKey(rawAuth),
    promptTokens,
    completionTokens,
    cost,
    latencyMs: elapsed,
    cached: false,
  });

  // 11. Update stats
  state.stats.totalRequests += 1;
  state.stats.totalCost += cost;
  state.stats.totalLatencyMs += elapsed;
  state.stats.requestsByProvider[provider.id] =
    (state.stats.requestsByProvider[provider.id] ?? 0) + 1;
  state.stats.requestsByModel[chatReq.model] =
    (state.stats.requestsByModel[chatReq.model] ?? 0) + 1;

  return jsonResponse(200, response, {
    'X-Gateway-Provider': provider.id,
    'X-Gateway-Cost': String(cost),
    'X-Gateway-Latency-Ms': String(elapsed),
  });
}
