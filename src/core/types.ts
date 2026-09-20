// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * Core types for gz-gateway — OpenAI-compatible AI gateway proxy.
 *
 * Every interface mirrors the OpenAI Chat Completions API shape
 * and adds gateway-specific extension fields prefixed with `x-gateway-*`.
 */

// ── Request/Response (OpenAI-compatible) ─────────────────────────────────────

/** A single message in a chat completion request. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/** OpenAI-compatible chat completion request with gateway extension fields. */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;

  // ── Gateway extensions (override per-request) ──
  /** Override cache behaviour per-request (true = force cache, false = skip). */
  'x-gateway-cache'?: boolean;
  /** Override timeout in milliseconds per-request. */
  'x-gateway-timeout'?: number;
}

/** OpenAI-compatible chat completion response with gateway metadata. */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };

  // ── Gateway extensions ──
  /** Total cost of this request in USD. */
  'x-gateway-cost'?: number;
  /** End-to-end latency in milliseconds. */
  'x-gateway-latency-ms'?: number;
  /** Whether this response was served from cache. */
  'x-gateway-cache-hit'?: boolean;
  /** Provider that actually served this request. */
  'x-gateway-provider'?: string;
}

// ── Streaming (SSE) ─────────────────────────────────────────────────────────

/** A single SSE chunk streamed back to the client. */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ── Provider ─────────────────────────────────────────────────────────────────

/** Configuration for a single upstream LLM provider. */
export interface ProviderConfig {
  /** Unique provider identifier (e.g. "openai", "anthropic"). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Provider type — determines request/response translation if needed. */
  type: 'openai' | 'anthropic' | 'google' | 'deepseek' | 'groq' | 'custom';
  /** Base URL for the provider API (e.g. "https://api.openai.com/v1"). */
  baseUrl: string;
  /** API key (resolved from env at load time). */
  apiKey: string;
  /** Models exposed by this provider. */
  models: string[];
  /** Priority for load balancing — lower = preferred. */
  priority: number;
  /** Rate limit imposed by the provider. */
  rateLimit: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
  /** Cost per 1 000 tokens in USD. */
  costPer1kTokens: {
    input: number;
    output: number;
  };
  /** Whether this provider is active. */
  enabled: boolean;
  /** Optional extra headers sent with every upstream request. */
  headers?: Record<string, string>;
}

// ── Gateway Config ───────────────────────────────────────────────────────────

/** Top-level gateway configuration. */
export interface GatewayConfig {
  port: number;
  host: string;
  providers: ProviderConfig[];
  rateLimiting: {
    enabled: boolean;
    global: { requestsPerMinute: number; tokensPerMinute: number };
    perApiKey: { requestsPerMinute: number; tokensPerMinute: number };
  };
  caching: {
    enabled: boolean;
    ttlSeconds: number;
    maxEntries: number;
    keyPattern: 'exact' | 'semantic';
  };
  failover: {
    enabled: boolean;
    maxRetries: number;
    retryDelayMs: number;
    circuitBreaker: {
      /** Number of consecutive failures before the circuit opens. */
      threshold: number;
      /** Time in ms before a half-open probe is attempted. */
      resetMs: number;
    };
  };
  loadBalancing: {
    strategy: 'round-robin' | 'least-cost' | 'least-latency' | 'priority';
  };
  logging: {
    enabled: boolean;
    level: 'debug' | 'info' | 'warn' | 'error';
  };
}

// ── Internal Types ───────────────────────────────────────────────────────────

/** Sliding-window rate-limit bucket (per key or per provider). */
export interface RateLimitBucket {
  requests: number;
  tokens: number;
  /** Epoch ms when the bucket resets. */
  resetAt: number;
}

/** Circuit breaker state for a single provider. */
export interface CircuitState {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  /** Epoch ms of the last failure. */
  lastFailure: number;
  /** Consecutive successes in half-open state (resets on failure). */
  successCount: number;
}

/** A single cached chat completion response. */
export interface CacheEntry {
  /** Hash key derived from the request body. */
  key: string;
  response: ChatCompletionResponse;
  createdAt: number;
  hits: number;
}

/** Record of a single completed request for cost tracking. */
export interface CostRecord {
  timestamp: number;
  provider: string;
  model: string;
  apiKeyHash: string;
  promptTokens: number;
  completionTokens: number;
  /** Cost in USD. */
  cost: number;
  latencyMs: number;
  cached: boolean;
}

/** Aggregated gateway statistics. */
export interface GatewayStats {
  totalRequests: number;
  totalCost: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  requestsByProvider: Record<string, number>;
  requestsByModel: Record<string, number>;
  errorsByType: Record<string, number>;
  /** Gateway uptime in seconds. */
  uptime: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

/** Default gateway configuration. */
export const DEFAULT_CONFIG: GatewayConfig = {
  port: 8000,
  host: '0.0.0.0',
  providers: [],
  rateLimiting: {
    enabled: true,
    global: { requestsPerMinute: 60, tokensPerMinute: 100_000 },
    perApiKey: { requestsPerMinute: 30, tokensPerMinute: 50_000 },
  },
  caching: {
    enabled: false,
    ttlSeconds: 3600,
    maxEntries: 1_000,
    keyPattern: 'exact',
  },
  failover: {
    enabled: true,
    maxRetries: 2,
    retryDelayMs: 500,
    circuitBreaker: {
      threshold: 5,
      resetMs: 30_000,
    },
  },
  loadBalancing: {
    strategy: 'priority',
  },
  logging: {
    enabled: true,
    level: 'info',
  },
};

// ── Runtime state ────────────────────────────────────────────────────────────

/** Mutable runtime state shared across request handlers. */
export interface GatewayState {
  /** Epoch ms when the server started. */
  startedAt: number;
  /** Per-provider rate-limit buckets, keyed by provider id. */
  rateLimits: Map<string, RateLimitBucket>;
  /** Per-API-key rate-limit buckets, keyed by the API key hash. */
  perKeyRateLimits: Map<string, RateLimitBucket>;
  /** Circuit breaker state per provider. */
  circuits: Map<string, CircuitState>;
  /** In-memory LRU cache for chat completions. */
  cache: Map<string, CacheEntry>;
  /** Cost tracking records (ring buffer). */
  costs: CostRecord[];
  /** Running counters. */
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
  /** Round-robin index (used by the round-robin load-balancing strategy). */
  roundRobinIndex: number;
}
