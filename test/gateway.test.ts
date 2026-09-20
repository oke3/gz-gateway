// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_CONFIG, type GatewayConfig } from '../src/core/types.js';
import { createCache, deriveCacheKey } from '../src/middleware/cache.js';
import { createCircuitBreaker } from '../src/middleware/circuit-breaker.js';
import { createRateLimiter } from '../src/middleware/rate-limiter.js';
import { createCostTracker, calculateCost } from '../src/utils/cost-tracker.js';
import {
  createLoadBalancer,
  recordLatency,
  type ProviderRegistry,
} from '../src/utils/load-balancer.js';
import type { ProviderConfig, ChatCompletionRequest, ChatCompletionResponse } from '../src/core/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-1234567890abcdef',
    models: ['gpt-4o', 'gpt-4o-mini'],
    priority: 1,
    rateLimit: { requestsPerMinute: 60, tokensPerMinute: 150_000 },
    costPer1kTokens: { input: 0.0025, output: 0.01 },
    enabled: true,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<ChatCompletionResponse> = {}): ChatCompletionResponse {
  return {
    id: 'chatcmpl-test-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello!' }],
    ...overrides,
  };
}

// ── Config Tests ─────────────────────────────────────────────────────────────

describe('DEFAULT_CONFIG', () => {
  it('has valid port range', () => {
    expect(DEFAULT_CONFIG.port).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_CONFIG.port).toBeLessThanOrEqual(65535);
  });

  it('has a non-empty host', () => {
    expect(DEFAULT_CONFIG.host).toBeTruthy();
  });

  it('has valid failover settings', () => {
    expect(DEFAULT_CONFIG.failover.maxRetries).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CONFIG.failover.circuitBreaker.threshold).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.failover.circuitBreaker.resetMs).toBeGreaterThan(0);
  });

  it('has valid rate limiting settings', () => {
    expect(DEFAULT_CONFIG.rateLimiting.global.requestsPerMinute).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.rateLimiting.global.tokensPerMinute).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.rateLimiting.perApiKey.requestsPerMinute).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.rateLimiting.perApiKey.tokensPerMinute).toBeGreaterThan(0);
  });

  it('has valid caching settings', () => {
    expect(DEFAULT_CONFIG.caching.ttlSeconds).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.caching.maxEntries).toBeGreaterThan(0);
    expect(['exact', 'semantic']).toContain(DEFAULT_CONFIG.caching.keyPattern);
  });

  it('has valid load balancing strategy', () => {
    expect(['round-robin', 'least-cost', 'least-latency', 'priority']).toContain(
      DEFAULT_CONFIG.loadBalancing.strategy,
    );
  });
});

// ── Cache Tests ──────────────────────────────────────────────────────────────

describe('ResponseCache', () => {
  let cache: ReturnType<typeof createCache>;

  beforeEach(() => {
    cache = createCache({ ttlSeconds: 60, maxEntries: 10 });
  });

  it('returns null on cache miss', () => {
    const key = deriveCacheKey(makeRequest());
    expect(cache.get(key)).toBeNull();
  });

  it('stores and retrieves a response', () => {
    const req = makeRequest();
    const key = deriveCacheKey(req);
    const res = makeResponse();

    cache.set(key, res);
    const hit = cache.get(key);

    expect(hit).not.toBeNull();
    expect(hit!.response.id).toBe(res.id);
    expect(hit!.hits).toBe(1);
  });

  it('tracks hit count', () => {
    const req = makeRequest();
    const key = deriveCacheKey(req);
    cache.set(key, makeResponse());

    cache.get(key);
    cache.get(key);
    const entry = cache.get(key);

    expect(entry!.hits).toBe(3);
  });

  it('evicts LRU entries when full', () => {
    const smallCache = createCache({ ttlSeconds: 60, maxEntries: 3 });

    for (let i = 0; i < 5; i++) {
      const key = deriveCacheKey(makeRequest({ messages: [{ role: 'user', content: `msg-${i}` }] }));
      smallCache.set(key, makeResponse({ id: `resp-${i}` }));
    }

    const stats = smallCache.stats();
    expect(stats.size).toBeLessThanOrEqual(3);
  });

  it('returns expired entries as misses', async () => {
    // Use a very short TTL (1 second) and wait for it to expire
    const shortCache = createCache({ ttlSeconds: 1, maxEntries: 10 });
    const key = deriveCacheKey(makeRequest());

    shortCache.set(key, makeResponse());

    // Entry should be valid immediately
    expect(shortCache.get(key)).not.toBeNull();

    // Wait for TTL to expire, then check
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const hit = shortCache.get(key);
    expect(hit).toBeNull();
  });

  it('reports correct stats', () => {
    const key = deriveCacheKey(makeRequest());
    cache.set(key, makeResponse());

    cache.get(key); // hit
    cache.get('nonexistent'); // miss

    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });

  it('clears all entries', () => {
    const key = deriveCacheKey(makeRequest());
    cache.set(key, makeResponse());
    expect(cache.stats().size).toBe(1);

    cache.clear();
    expect(cache.stats().size).toBe(0);
    expect(cache.stats().hits).toBe(0);
    expect(cache.stats().misses).toBe(0);
  });

  it('produces consistent cache keys for same input', () => {
    const req = makeRequest();
    const key1 = deriveCacheKey(req);
    const key2 = deriveCacheKey(makeRequest());
    expect(key1).toBe(key2);
  });

  it('produces different cache keys for different inputs', () => {
    const key1 = deriveCacheKey(makeRequest({ messages: [{ role: 'user', content: 'Hello' }] }));
    const key2 = deriveCacheKey(makeRequest({ messages: [{ role: 'user', content: 'Goodbye' }] }));
    expect(key1).not.toBe(key2);
  });
});

// ── Circuit Breaker Tests ────────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  it('starts in closed state (allows requests)', () => {
    const cb = createCircuitBreaker({ threshold: 3, resetMs: 1000 });
    expect(cb.allow('openai')).toBe(true);
  });

  it('stays closed below failure threshold', () => {
    const cb = createCircuitBreaker({ threshold: 3, resetMs: 1000 });
    cb.recordFailure('openai');
    cb.recordFailure('openai');
    expect(cb.getState('openai').state).toBe('closed');
    expect(cb.allow('openai')).toBe(true);
  });

  it('opens after reaching failure threshold', () => {
    const cb = createCircuitBreaker({ threshold: 3, resetMs: 1000 });
    cb.recordFailure('openai');
    cb.recordFailure('openai');
    cb.recordFailure('openai');
    expect(cb.getState('openai').state).toBe('open');
    expect(cb.allow('openai')).toBe(false);
  });

  it('transitions from open to half-open after resetMs', () => {
    const cb = createCircuitBreaker({ threshold: 2, resetMs: 50 });
    cb.recordFailure('openai');
    cb.recordFailure('openai');
    expect(cb.allow('openai')).toBe(false);

    // Wait for reset window
    return new Promise((resolve) => setTimeout(resolve, 60)).then(() => {
      expect(cb.allow('openai')).toBe(true);
      expect(cb.getState('openai').state).toBe('half-open');
    });
  });

  it('closes on successful probe in half-open', () => {
    const cb = createCircuitBreaker({ threshold: 2, resetMs: 50 });
    cb.recordFailure('openai');
    cb.recordFailure('openai');

    return new Promise((resolve) => setTimeout(resolve, 60)).then(() => {
      cb.allow('openai'); // transition to half-open
      cb.recordSuccess('openai');
      expect(cb.getState('openai').state).toBe('closed');
    });
  });

  it('re-opens on failure in half-open', () => {
    const cb = createCircuitBreaker({ threshold: 2, resetMs: 50 });
    cb.recordFailure('openai');
    cb.recordFailure('openai');

    return new Promise((resolve) => setTimeout(resolve, 60)).then(() => {
      cb.allow('openai'); // transition to half-open
      cb.recordFailure('openai');
      expect(cb.getState('openai').state).toBe('open');
    });
  });

  it('resets failure count on success in closed state', () => {
    const cb = createCircuitBreaker({ threshold: 3, resetMs: 1000 });
    cb.recordFailure('openai');
    cb.recordFailure('openai');
    cb.recordSuccess('openai');
    expect(cb.getState('openai').failures).toBe(0);
  });

  it('tracks independent circuits per provider', () => {
    const cb = createCircuitBreaker({ threshold: 1, resetMs: 1000 });
    cb.recordFailure('openai');
    expect(cb.allow('openai')).toBe(false);
    expect(cb.allow('anthropic')).toBe(true);
  });
});

// ── Rate Limiter Tests ───────────────────────────────────────────────────────

describe('RateLimiter', () => {
  it('allows requests within limits', () => {
    const limiter = createRateLimiter({
      global: { rpm: 10, tpm: 10_000 },
      perKey: { rpm: 5, tpm: 5_000 },
    });
    expect(limiter.check('key:123')).toBe(true);
  });

  it('denies requests exceeding per-key RPM', () => {
    const limiter = createRateLimiter({
      global: { rpm: 100, tpm: 100_000 },
      perKey: { rpm: 2, tpm: 50_000 },
    });
    expect(limiter.check('key:abc')).toBe(true);
    expect(limiter.check('key:abc')).toBe(true);
    expect(limiter.check('key:abc')).toBe(false);
  });

  it('denies requests exceeding global RPM', () => {
    const limiter = createRateLimiter({
      global: { rpm: 2, tpm: 100_000 },
      perKey: { rpm: 100, tpm: 100_000 },
    });
    expect(limiter.check('key:1')).toBe(true);
    expect(limiter.check('key:2')).toBe(true);
    expect(limiter.check('key:3')).toBe(false);
  });

  it('rolls back global consumption on per-key rejection', () => {
    const limiter = createRateLimiter({
      global: { rpm: 100, tpm: 100_000 },
      perKey: { rpm: 1, tpm: 50_000 },
    });
    expect(limiter.check('key:a')).toBe(true);
    expect(limiter.check('key:a')).toBe(false);

    // Global should still have capacity (only 1 consumed)
    expect(limiter.check('key:b')).toBe(true);
  });

  it('tracks separate buckets per key', () => {
    const limiter = createRateLimiter({
      global: { rpm: 100, tpm: 100_000 },
      perKey: { rpm: 1, tpm: 50_000 },
    });
    expect(limiter.check('key:alice')).toBe(true);
    expect(limiter.check('key:alice')).toBe(false);
    expect(limiter.check('key:bob')).toBe(true);
  });

  it('returns correct status', () => {
    const limiter = createRateLimiter({
      global: { rpm: 100, tpm: 100_000 },
      perKey: { rpm: 3, tpm: 50_000 },
    });
    limiter.check('key:x');
    limiter.check('key:x');

    const status = limiter.getStatus('key:x');
    expect(status.remaining).toBe(1);
    expect(status.allowed).toBe(true);
  });
});

// ── Cost Tracker Tests ───────────────────────────────────────────────────────

describe('CostTracker', () => {
  it('records cost entries', () => {
    const tracker = createCostTracker();
    tracker.record({
      timestamp: Date.now(),
      provider: 'openai',
      model: 'gpt-4o',
      apiKeyHash: 'abc123',
      promptTokens: 100,
      completionTokens: 50,
      cost: 0.001,
      latencyMs: 500,
      cached: false,
    });

    const stats = tracker.getStats();
    expect(stats.totalRequests).toBe(1);
    expect(stats.totalCost).toBe(0.001);
  });

  it('aggregates by provider', () => {
    const tracker = createCostTracker();
    const now = Date.now();
    tracker.record({ timestamp: now, provider: 'openai', model: 'gpt-4o', apiKeyHash: 'a', promptTokens: 100, completionTokens: 50, cost: 0.001, latencyMs: 200, cached: false });
    tracker.record({ timestamp: now, provider: 'anthropic', model: 'claude-3', apiKeyHash: 'b', promptTokens: 200, completionTokens: 100, cost: 0.003, latencyMs: 300, cached: false });

    const stats = tracker.getStats();
    expect(stats.requestsByProvider['openai']).toBe(1);
    expect(stats.requestsByProvider['anthropic']).toBe(1);
  });

  it('aggregates by model', () => {
    const tracker = createCostTracker();
    const now = Date.now();
    tracker.record({ timestamp: now, provider: 'openai', model: 'gpt-4o', apiKeyHash: 'a', promptTokens: 100, completionTokens: 50, cost: 0.001, latencyMs: 200, cached: false });
    tracker.record({ timestamp: now, provider: 'openai', model: 'gpt-4o-mini', apiKeyHash: 'a', promptTokens: 100, completionTokens: 50, cost: 0.0001, latencyMs: 150, cached: false });

    const stats = tracker.getStats();
    expect(stats.requestsByModel['gpt-4o']).toBe(1);
    expect(stats.requestsByModel['gpt-4o-mini']).toBe(1);
  });

  it('calculates cache hit rate', () => {
    const tracker = createCostTracker();
    const now = Date.now();
    tracker.record({ timestamp: now, provider: 'openai', model: 'gpt-4o', apiKeyHash: 'a', promptTokens: 100, completionTokens: 50, cost: 0.001, latencyMs: 200, cached: true });
    tracker.record({ timestamp: now, provider: 'openai', model: 'gpt-4o', apiKeyHash: 'a', promptTokens: 100, completionTokens: 50, cost: 0.001, latencyMs: 200, cached: true });
    tracker.record({ timestamp: now, provider: 'openai', model: 'gpt-4o', apiKeyHash: 'a', promptTokens: 100, completionTokens: 50, cost: 0.001, latencyMs: 200, cached: false });

    const stats = tracker.getStats();
    expect(stats.cacheHitRate).toBeCloseTo(2 / 3, 2);
  });

  it('returns model costs', () => {
    const tracker = createCostTracker();
    tracker.record({ timestamp: Date.now(), provider: 'openai', model: 'gpt-4o', apiKeyHash: 'a', promptTokens: 100, completionTokens: 50, cost: 0.005, latencyMs: 200, cached: false });
    tracker.record({ timestamp: Date.now(), provider: 'openai', model: 'gpt-4o-mini', apiKeyHash: 'a', promptTokens: 100, completionTokens: 50, cost: 0.0005, latencyMs: 100, cached: false });

    const modelCosts = tracker.getModelCosts();
    expect(modelCosts['gpt-4o']).toBe(0.005);
    expect(modelCosts['gpt-4o-mini']).toBe(0.0005);
  });

  it('returns provider costs', () => {
    const tracker = createCostTracker();
    tracker.record({ timestamp: Date.now(), provider: 'openai', model: 'gpt-4o', apiKeyHash: 'a', promptTokens: 100, completionTokens: 50, cost: 0.005, latencyMs: 200, cached: false });
    tracker.record({ timestamp: Date.now(), provider: 'anthropic', model: 'claude-3', apiKeyHash: 'b', promptTokens: 100, completionTokens: 50, cost: 0.003, latencyMs: 300, cached: false });

    const providerCosts = tracker.getProviderCosts();
    expect(providerCosts['openai']).toBe(0.005);
    expect(providerCosts['anthropic']).toBe(0.003);
  });

  it('returns daily costs', () => {
    const tracker = createCostTracker();
    tracker.record({ timestamp: Date.now(), provider: 'openai', model: 'gpt-4o', apiKeyHash: 'a', promptTokens: 100, completionTokens: 50, cost: 0.005, latencyMs: 200, cached: false });

    const daily = tracker.getDailyCosts();
    expect(daily.length).toBeGreaterThanOrEqual(1);
    expect(daily[0].cost).toBe(0.005);
  });

  it('filters stats by time period', () => {
    const tracker = createCostTracker();
    const now = Date.now();
    // Record one entry 2 hours ago and one now
    tracker.record({ timestamp: now - 7_200_000, provider: 'openai', model: 'gpt-4o', apiKeyHash: 'a', promptTokens: 100, completionTokens: 50, cost: 0.001, latencyMs: 200, cached: false });
    tracker.record({ timestamp: now, provider: 'openai', model: 'gpt-4o', apiKeyHash: 'a', promptTokens: 100, completionTokens: 50, cost: 0.002, latencyMs: 300, cached: false });

    const hourly = tracker.getStats('1h');
    expect(hourly.totalRequests).toBe(1);
    expect(hourly.totalCost).toBe(0.002);

    const all = tracker.getStats('all');
    expect(all.totalRequests).toBe(2);
  });
});

// ── Cost Calculation Tests ───────────────────────────────────────────────────

describe('calculateCost', () => {
  it('calculates cost correctly', () => {
    const cost = calculateCost(1000, 500, 0.01, 0.03);
    // (1000/1000)*0.01 + (500/1000)*0.03 = 0.01 + 0.015 = 0.025
    expect(cost).toBe(0.025);
  });

  it('rounds to 6 decimal places', () => {
    const cost = calculateCost(1, 1, 0.000001, 0.000003);
    expect(cost).toBeGreaterThanOrEqual(0);
    // Should not have more than 6 decimal places
    const decimals = cost.toString().split('.')[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });

  it('handles zero tokens', () => {
    expect(calculateCost(0, 0, 0.01, 0.03)).toBe(0);
  });
});

// ── Load Balancer Tests ──────────────────────────────────────────────────────

describe('LoadBalancer', () => {
  function makeRegistry(providers: ProviderConfig[]): ProviderRegistry {
    const available = providers.filter((p) => p.enabled);
    return {
      getModelProviders(_model: string): ProviderConfig[] {
        return [...available].sort((a, b) => a.priority - b.priority);
      },
    };
  }

  const providerA = makeProvider({ id: 'openai', priority: 1, costPer1kTokens: { input: 0.01, output: 0.03 } });
  const providerB = makeProvider({ id: 'deepseek', priority: 2, costPer1kTokens: { input: 0.0001, output: 0.0002 }, models: ['gpt-4o'] });
  const providerC = makeProvider({ id: 'groq', priority: 3, costPer1kTokens: { input: 0.0005, output: 0.0008 }, models: ['gpt-4o'] });

  it('selects by priority (default)', () => {
    const registry = makeRegistry([providerC, providerA, providerB]);
    const lb = createLoadBalancer('priority', registry);
    const selected = lb.select('gpt-4o');
    expect(selected?.id).toBe('openai');
  });

  it('selects by round-robin', () => {
    const registry = makeRegistry([providerA, providerB, providerC]);
    const lb = createLoadBalancer('round-robin', registry);

    const first = lb.select('gpt-4o');
    const second = lb.select('gpt-4o');
    const third = lb.select('gpt-4o');
    const fourth = lb.select('gpt-4o');

    // Should cycle through providers
    expect(first?.id).not.toBe(second?.id);
    expect(second?.id).not.toBe(third?.id);
    expect(fourth?.id).toBe(first?.id); // wraps around
  });

  it('selects by least-cost', () => {
    const registry = makeRegistry([providerA, providerB, providerC]);
    const lb = createLoadBalancer('least-cost', registry);
    const selected = lb.select('gpt-4o');
    // DeepSeek has lowest combined cost (0.0001 + 0.0002 = 0.0003)
    expect(selected?.id).toBe('deepseek');
  });

  it('selects by least-latency', () => {
    // Record latency data
    recordLatency('openai', 100);
    recordLatency('openai', 200);
    recordLatency('deepseek', 50);
    recordLatency('deepseek', 70);

    const registry = makeRegistry([providerA, providerB, providerC]);
    const lb = createLoadBalancer('least-latency', registry);
    const selected = lb.select('gpt-4o');
    // DeepSeek has lower average latency (60 vs 150)
    expect(selected?.id).toBe('deepseek');
  });

  it('returns null when no providers available', () => {
    const emptyRegistry: ProviderRegistry = {
      getModelProviders: () => [],
    };
    const lb = createLoadBalancer('priority', emptyRegistry);
    expect(lb.select('gpt-4o')).toBeNull();
  });

  it('returns single provider directly', () => {
    const registry = makeRegistry([providerA]);
    const lb = createLoadBalancer('round-robin', registry);
    const selected = lb.select('gpt-4o');
    expect(selected?.id).toBe('openai');
  });
});

// ── Config Validation Tests ──────────────────────────────────────────────────

describe('Config validation', () => {
  it('DEFAULT_CONFIG has all required fields', () => {
    expect(DEFAULT_CONFIG).toHaveProperty('port');
    expect(DEFAULT_CONFIG).toHaveProperty('host');
    expect(DEFAULT_CONFIG).toHaveProperty('providers');
    expect(DEFAULT_CONFIG).toHaveProperty('rateLimiting');
    expect(DEFAULT_CONFIG).toHaveProperty('caching');
    expect(DEFAULT_CONFIG).toHaveProperty('failover');
    expect(DEFAULT_CONFIG).toHaveProperty('loadBalancing');
    expect(DEFAULT_CONFIG).toHaveProperty('logging');
  });

  it('rate limiting has correct sub-fields', () => {
    expect(DEFAULT_CONFIG.rateLimiting).toHaveProperty('enabled');
    expect(DEFAULT_CONFIG.rateLimiting).toHaveProperty('global');
    expect(DEFAULT_CONFIG.rateLimiting).toHaveProperty('perApiKey');
    expect(DEFAULT_CONFIG.rateLimiting.global).toHaveProperty('requestsPerMinute');
    expect(DEFAULT_CONFIG.rateLimiting.global).toHaveProperty('tokensPerMinute');
  });

  it('caching has correct sub-fields', () => {
    expect(DEFAULT_CONFIG.caching).toHaveProperty('enabled');
    expect(DEFAULT_CONFIG.caching).toHaveProperty('ttlSeconds');
    expect(DEFAULT_CONFIG.caching).toHaveProperty('maxEntries');
    expect(DEFAULT_CONFIG.caching).toHaveProperty('keyPattern');
  });

  it('failover has circuit breaker config', () => {
    expect(DEFAULT_CONFIG.failover).toHaveProperty('enabled');
    expect(DEFAULT_CONFIG.failover).toHaveProperty('maxRetries');
    expect(DEFAULT_CONFIG.failover).toHaveProperty('retryDelayMs');
    expect(DEFAULT_CONFIG.failover).toHaveProperty('circuitBreaker');
    expect(DEFAULT_CONFIG.failover.circuitBreaker).toHaveProperty('threshold');
    expect(DEFAULT_CONFIG.failover.circuitBreaker).toHaveProperty('resetMs');
  });

  it('logging has level setting', () => {
    expect(DEFAULT_CONFIG.logging).toHaveProperty('enabled');
    expect(DEFAULT_CONFIG.logging).toHaveProperty('level');
    expect(['debug', 'info', 'warn', 'error']).toContain(DEFAULT_CONFIG.logging.level);
  });
});
