// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * Configuration management for gz-gateway.
 *
 * Loads config from `~/.gz-gateway/config.json`, merges with defaults,
 * resolves environment variables for API keys, and validates providers.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  DEFAULT_CONFIG,
  type GatewayConfig,
  type ProviderConfig,
  type ChatCompletionResponse,
} from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve `${ENV_VAR}` placeholders in a string.
 *
 * `"${OPENAI_API_KEY}"` → value of `process.env.OPENAI_API_KEY`.
 * If the env var is unset the raw placeholder is returned unchanged.
 */
function resolveEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, envName: string) => {
    return process.env[envName] ?? `\${${envName}}`;
  });
}

/**
 * Recursively walk an object and resolve `${…}` env-var placeholders
 * in every string leaf.
 */
function deepResolveEnv<T>(obj: T): T {
  if (typeof obj === 'string') return resolveEnv(obj) as T;
  if (Array.isArray(obj)) return obj.map(deepResolveEnv) as T;
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = deepResolveEnv(v);
    }
    return out as T;
  }
  return obj;
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Validation error thrown when the config is invalid. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`[gz-gateway config] ${message}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validate that every provider has the required fields.
 * Throws `ConfigError` on the first invalid provider.
 */
function validateProviders(providers: ProviderConfig[]): void {
  const seenIds = new Set<string>();
  const seenModels = new Set<string>();

  for (const [i, p] of providers.entries()) {
    const prefix = `providers[${i}]`;

    if (!p.id) throw new ConfigError(`${prefix}.id is required`);
    if (!p.name) throw new ConfigError(`${prefix}.name is required`);
    if (!p.baseUrl) throw new ConfigError(`${prefix}.baseUrl is required`);
    if (!p.apiKey) {
      throw new ConfigError(
        `${prefix}.apiKey is required — set it in config or via env var`,
      );
    }
    if (!p.models?.length) {
      throw new ConfigError(`${prefix}.models must list at least one model`);
    }
    if (p.priority < 0) {
      throw new ConfigError(`${prefix}.priority must be >= 0`);
    }
    if (p.rateLimit.requestsPerMinute <= 0) {
      throw new ConfigError(
        `${prefix}.rateLimit.requestsPerMinute must be > 0`,
      );
    }

    // Duplicate id check
    if (seenIds.has(p.id)) {
      throw new ConfigError(`${prefix}.id "${p.id}" is a duplicate`);
    }
    seenIds.add(p.id);

    // Duplicate model check across providers
    for (const m of p.models) {
      if (seenModels.has(m)) {
        throw new ConfigError(
          `${prefix}: model "${m}" is already declared in another provider`,
        );
      }
      seenModels.add(m);
    }
  }
}

/**
 * Validate the full GatewayConfig.
 * Returns the (possibly mutated) config on success.
 */
function validateConfig(config: GatewayConfig): void {
  if (config.port < 1 || config.port > 65535) {
    throw new ConfigError(`port must be between 1 and 65535, got ${config.port}`);
  }
  if (!config.host) {
    throw new ConfigError('host is required');
  }
  if (config.failover.maxRetries < 0) {
    throw new ConfigError('failover.maxRetries must be >= 0');
  }
  if (config.failover.circuitBreaker.threshold <= 0) {
    throw new ConfigError('failover.circuitBreaker.threshold must be > 0');
  }
  validateProviders(config.providers);
}

// ── Deep merge ───────────────────────────────────────────────────────────────

/**
 * Recursively merge `override` into `base`, returning a new object.
 * Arrays are replaced (not concatenated).
 */
function deepMerge<T>(base: T, override: Partial<T>): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, val] of Object.entries(override)) {
    if (val === undefined) continue;
    const baseVal = (base as Record<string, unknown>)[key];
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else {
      result[key] = val;
    }
  }
  return result as T;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load and validate the gateway configuration.
 *
 * Resolution order:
 * 1. `DEFAULT_CONFIG` (hardcoded)
 * 2. `~/.gz-gateway/config.json` (user overrides — merged deeply)
 * 3. Environment variables in API key fields (`${ENV_VAR}` syntax)
 * 4. CLI options (passed as `overrides`) take highest priority
 *
 * @param configPath - Optional explicit path to the config file.
 * @param overrides  - Optional partial overrides applied last.
 * @returns          A fully resolved, validated `GatewayConfig`.
 */
export async function buildConfig(
  configPath?: string,
  overrides?: Partial<GatewayConfig>,
): Promise<GatewayConfig> {
  const filePath = resolve(
    configPath ?? `${homedir()}/.gz-gateway/config.json`,
  );

  let fileConfig: Partial<GatewayConfig> = {};
  try {
    const raw = await readFile(filePath, 'utf-8');
    fileConfig = JSON.parse(raw) as Partial<GatewayConfig>;
  } catch (err: unknown) {
    // ENOENT is expected on first run — every other error is suspicious.
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code !== 'ENOENT'
    ) {
      throw new ConfigError(`Failed to read config file at ${filePath}: ${err}`);
    }
  }

  // Merge: defaults ← file ← env-resolved ← CLI overrides
  let config = deepMerge(DEFAULT_CONFIG, fileConfig);
  config = deepResolveEnv(config);
  if (overrides) config = deepMerge(config, overrides);

  validateConfig(config);
  return config;
}

/**
 * Create a fresh `GatewayState` from a validated config.
 * Imported here to avoid circular deps — types.ts doesn't depend on state.
 */
export function createState(config: GatewayConfig) {
  // Dynamic import avoided — state is plain data, inline the shape.
  const now = Date.now();
  return {
    startedAt: now,
    rateLimits: new Map<string, { requests: number; tokens: number; resetAt: number }>(),
    perKeyRateLimits: new Map<string, { requests: number; tokens: number; resetAt: number }>(),
    circuits: new Map<string, {
      state: 'closed' | 'open' | 'half-open';
      failures: number;
      lastFailure: number;
      successCount: number;
    }>(),
    cache: new Map<string, { key: string; response: ChatCompletionResponse; createdAt: number; hits: number }>(),
    costs: [] as Array<{
      timestamp: number;
      provider: string;
      model: string;
      apiKeyHash: string;
      promptTokens: number;
      completionTokens: number;
      cost: number;
      latencyMs: number;
      cached: boolean;
    }>,
    stats: {
      totalRequests: 0,
      totalCost: 0,
      totalLatencyMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      requestsByProvider: {} as Record<string, number>,
      requestsByModel: {} as Record<string, number>,
      errorsByType: {} as Record<string, number>,
    },
    roundRobinIndex: 0,
    config,
  } as const;
}
