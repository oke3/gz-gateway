// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * Provider registry — manages provider configs, health checks, and model routing.
 *
 * Responsibilities:
 *   - Map model strings to their owning provider(s).
 *   - Track per-provider health via consecutive failure counting.
 *   - Mark providers unhealthy after 3 consecutive failures.
 *   - Auto-recover providers after 60 seconds of silence.
 *
 * Usage:
 *   const registry = createProviderRegistry(providers);
 *   const provider = registry.getProvider('gpt-4o');
 *   if (!provider) throw new Error('Model not found');
 *   registry.reportHealth('openai', false); // on failure
 */

import type { ProviderConfig } from '../core/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Internal health state for a provider. */
interface ProviderHealth {
  /** Whether the provider is considered healthy. */
  healthy: boolean;
  /** Number of consecutive failures since last success. */
  consecutiveFailures: number;
  /** Epoch ms of the last recorded failure. */
  lastFailureAt: number;
  /** Epoch ms of the last recorded success. */
  lastSuccessAt: number;
}

export interface ProviderRegistry {
  /**
   * Look up a provider by model string.
   * Returns the first enabled, healthy provider that lists the model.
   * Returns `null` if no matching provider is found.
   */
  getProvider(model: string): ProviderConfig | null;

  /**
   * Get all enabled, healthy providers.
   */
  getAvailableProviders(): ProviderConfig[];

  /**
   * Report a health outcome for a provider.
   *
   * @param providerId - The provider identifier.
   * @param healthy    - `true` for success, `false` for failure.
   */
  reportHealth(providerId: string, healthy: boolean): void;

  /**
   * Get all providers that support a given model (enabled + healthy).
   */
  getModelProviders(model: string): ProviderConfig[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Number of consecutive failures before a provider is marked unhealthy. */
const FAILURE_THRESHOLD = 3;

/** Time in ms after which a provider can auto-recover. */
const RECOVERY_WINDOW_MS = 60_000;

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a provider registry that tracks health and maps models to providers.
 *
 * Providers are indexed by model for O(1) lookup. Health state is tracked
 * separately and does not modify the original config objects.
 */
export function createProviderRegistry(
  providers: ProviderConfig[],
): ProviderRegistry {
  // ── State ──

  /** Health state per provider id. */
  const health = new Map<string, ProviderHealth>();

  /**
   * Model → provider index mapping.
   * Multiple providers can support the same model (for failover).
   * Indices reference the original `providers` array.
   */
  const modelIndex = new Map<string, number[]>();

  // Build the model index from all providers (including disabled ones —
  // we filter at query time so the index stays stable).
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    // Initialize health state.
    health.set(p.id, {
      healthy: true,
      consecutiveFailures: 0,
      lastFailureAt: 0,
      lastSuccessAt: Date.now(),
    });

    // Index each model.
    for (const model of p.models) {
      const indices = modelIndex.get(model);
      if (indices) {
        indices.push(i);
      } else {
        modelIndex.set(model, [i]);
      }
    }
  }

  // ── Internal helpers ──

  /**
   * Check if a provider is considered available (enabled + healthy).
   */
  function isAvailable(provider: ProviderConfig): boolean {
    if (!provider.enabled) return false;

    const h = health.get(provider.id);
    if (!h) return false;

    // If already healthy, return true.
    if (h.healthy) return true;

    // Auto-recovery: if enough time has passed since the last failure,
    // transition back to healthy (half-open behavior).
    if (h.lastFailureAt > 0) {
      const elapsed = Date.now() - h.lastFailureAt;
      if (elapsed >= RECOVERY_WINDOW_MS) {
        h.healthy = true;
        h.consecutiveFailures = 0;
        return true;
      }
    }

    return false;
  }

  // ── Public API ──

  function getProvider(model: string): ProviderConfig | null {
    const indices = modelIndex.get(model);
    if (!indices || indices.length === 0) return null;

    // Return the first available provider.
    // Sort by priority within the candidates for consistent ordering.
    const candidates = indices
      .map((i) => providers[i])
      .filter((p) => isAvailable(p))
      .sort((a, b) => a.priority - b.priority);

    return candidates[0] ?? null;
  }

  function getAvailableProviders(): ProviderConfig[] {
    return providers
      .filter((p) => isAvailable(p))
      .sort((a, b) => a.priority - b.priority);
  }

  function reportHealth(providerId: string, isHealthy: boolean): void {
    const h = health.get(providerId);
    if (!h) return; // Unknown provider — ignore.

    const now = Date.now();

    if (isHealthy) {
      // Reset failure tracking on success.
      h.healthy = true;
      h.consecutiveFailures = 0;
      h.lastSuccessAt = now;
    } else {
      // Increment failure counter.
      h.consecutiveFailures += 1;
      h.lastFailureAt = now;

      // Mark unhealthy if threshold reached.
      if (h.consecutiveFailures >= FAILURE_THRESHOLD) {
        h.healthy = false;
      }
    }
  }

  function getModelProviders(model: string): ProviderConfig[] {
    const indices = modelIndex.get(model);
    if (!indices || indices.length === 0) return [];

    return indices
      .map((i) => providers[i])
      .filter((p) => isAvailable(p))
      .sort((a, b) => a.priority - b.priority);
  }

  return { getProvider, getAvailableProviders, reportHealth, getModelProviders };
}
