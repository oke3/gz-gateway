// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * Load balancer — selects the best provider for a given model.
 *
 * Strategies:
 *   - round-robin   → Cycle through available providers in order.
 *   - least-cost     → Pick the cheapest provider for the model.
 *   - least-latency  → Pick the provider with the lowest recent latency.
 *   - priority       → Pick the highest-priority (lowest number) provider.
 *
 * Usage:
 *   const lb = createLoadBalancer('priority', registry);
 *   const provider = lb.select('gpt-4o');
 */

import type { ProviderConfig } from '../core/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type LoadBalancingStrategy =
  | 'round-robin'
  | 'least-cost'
  | 'least-latency'
  | 'priority';

export interface ProviderRegistry {
  /** Get all available (enabled + healthy) providers that support a model. */
  getModelProviders(model: string): ProviderConfig[];
}

export interface LoadBalancer {
  /**
   * Select the best provider for a given model.
   * Returns `null` if no providers are available for the model.
   */
  select(model: string): ProviderConfig | null;
}

// ── Latency Tracking ─────────────────────────────────────────────────────────

/** Maximum number of latency samples to keep per provider. */
const MAX_LATENCY_SAMPLES = 100;

/** Per-provider latency ring buffer. */
const latencyBuffers = new Map<string, number[]>();

/**
 * Record a latency sample for a provider.
 */
export function recordLatency(providerId: string, latencyMs: number): void {
  let buffer = latencyBuffers.get(providerId);
  if (!buffer) {
    buffer = [];
    latencyBuffers.set(providerId, buffer);
  }

  buffer.push(latencyMs);

  // Evict oldest sample if buffer is full.
  if (buffer.length > MAX_LATENCY_SAMPLES) {
    buffer.shift();
  }
}

/**
 * Get the average latency for a provider.
 * Returns `Infinity` if no samples are available.
 */
function getAverageLatency(providerId: string): number {
  const buffer = latencyBuffers.get(providerId);
  if (!buffer || buffer.length === 0) return Infinity;

  let sum = 0;
  for (const sample of buffer) {
    sum += sample;
  }
  return sum / buffer.length;
}

// ── Strategy Implementations ─────────────────────────────────────────────────

/**
 * Round-robin: cycle through providers in index order.
 * Uses a per-load-balancer counter that wraps around.
 */
function selectRoundRobin(
  providers: ProviderConfig[],
  counter: { value: number },
): ProviderConfig {
  if (providers.length === 0) {
    throw new Error('No providers available for round-robin selection');
  }

  const index = counter.value % providers.length;
  counter.value = (counter.value + 1) % providers.length;
  return providers[index];
}

/**
 * Least-cost: pick the provider with the lowest combined input + output cost.
 */
function selectLeastCost(providers: ProviderConfig[]): ProviderConfig {
  if (providers.length === 0) {
    throw new Error('No providers available for least-cost selection');
  }

  return providers.reduce((best, current) => {
    const bestCost = best.costPer1kTokens.input + best.costPer1kTokens.output;
    const currentCost =
      current.costPer1kTokens.input + current.costPer1kTokens.output;
    return currentCost < bestCost ? current : best;
  });
}

/**
 * Least-latency: pick the provider with the lowest recent average latency.
 * Falls back to priority if no latency data is available.
 */
function selectLeastLatency(providers: ProviderConfig[]): ProviderConfig {
  if (providers.length === 0) {
    throw new Error('No providers available for least-latency selection');
  }

  return providers.reduce((best, current) => {
    const bestLatency = getAverageLatency(best.id);
    const currentLatency = getAverageLatency(current.id);

    // If both have no data, prefer higher priority (lower number).
    if (bestLatency === Infinity && currentLatency === Infinity) {
      return current.priority < best.priority ? current : best;
    }

    // If only one has data, prefer the one with data.
    if (currentLatency < bestLatency) return current;
    if (bestLatency < currentLatency) return best;

    // Tie — prefer higher priority.
    return current.priority < best.priority ? current : best;
  });
}

/**
 * Priority: pick the provider with the lowest priority number.
 */
function selectPriority(providers: ProviderConfig[]): ProviderConfig {
  if (providers.length === 0) {
    throw new Error('No providers available for priority selection');
  }

  return providers.reduce((best, current) =>
    current.priority < best.priority ? current : best,
  );
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a load balancer with the specified strategy.
 *
 * The load balancer queries the registry for available providers
 * that support the requested model, then applies the strategy
 * to select the best one.
 */
export function createLoadBalancer(
  strategy: LoadBalancingStrategy,
  registry: ProviderRegistry,
): LoadBalancer {
  // Round-robin counter (shared across calls).
  const roundRobinCounter = { value: 0 };

  function select(model: string): ProviderConfig | null {
    const providers = registry.getModelProviders(model);

    // No available providers — return null.
    if (providers.length === 0) return null;

    // Single provider — skip strategy logic.
    if (providers.length === 1) return providers[0];

    // Apply strategy.
    switch (strategy) {
      case 'round-robin':
        return selectRoundRobin(providers, roundRobinCounter);

      case 'least-cost':
        return selectLeastCost(providers);

      case 'least-latency':
        return selectLeastLatency(providers);

      case 'priority':
        return selectPriority(providers);

      default:
        // Exhaustive check — TypeScript will error if a case is missing.
        return selectPriority(providers);
    }
  }

  return { select };
}
