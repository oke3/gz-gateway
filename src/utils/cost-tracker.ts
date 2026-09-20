// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * Cost tracking — records every completed request for analytics and billing.
 *
 * Architecture:
 *   - In-memory ring buffer with automatic 30-day cleanup.
 *   - Period filtering: 1h, 24h, 7d, 30d, all.
 *   - Cost calculation: (prompt_tokens / 1000) * inputCost + (completion_tokens / 1000) * outputCost.
 *   - Aggregation by model, provider, and day.
 *
 * Usage:
 *   const tracker = createCostTracker();
 *   tracker.record({ timestamp: Date.now(), provider: 'openai', model: 'gpt-4o', ... });
 *   const stats = tracker.getStats('24h');
 */

import type { CostRecord, GatewayStats } from '../core/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type TimePeriod = '1h' | '24h' | '7d' | '30d' | 'all';

export interface DailyCost {
  date: string; // YYYY-MM-DD
  cost: number;
}

export interface CostTracker {
  /**
   * Record a completed request for cost tracking.
   */
  record(entry: CostRecord): void;

  /**
   * Get aggregated gateway statistics for a time period.
   */
  getStats(period?: TimePeriod): GatewayStats;

  /**
   * Get cost breakdown by model.
   */
  getModelCosts(): Record<string, number>;

  /**
   * Get cost breakdown by provider.
   */
  getProviderCosts(): Record<string, number>;

  /**
   * Get daily cost breakdown for the last 30 days.
   */
  getDailyCosts(): DailyCost[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum age of records to keep (30 days in ms). */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Cleanup interval: purge old records every 5 minutes. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Period boundaries in milliseconds. */
const PERIOD_MS: Record<Exclude<TimePeriod, 'all'>, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an in-memory cost tracker.
 *
 * Records are stored in a flat array. Old records are cleaned up
 * periodically to prevent unbounded memory growth. The tracker
 * provides O(n) aggregation over the filtered record set.
 */
export function createCostTracker(): CostTracker {
  // ── State ──
  const records: CostRecord[] = [];

  // ── Cleanup timer ──
  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - MAX_AGE_MS;
    // Remove records older than 30 days.
    // Since records are appended in order, we can find the first valid index.
    let startIndex = 0;
    while (startIndex < records.length && records[startIndex].timestamp < cutoff) {
      startIndex += 1;
    }
    if (startIndex > 0) {
      records.splice(0, startIndex);
    }
  }, CLEANUP_INTERVAL_MS);

  // Allow the process to exit even if the timer is active.
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  // ── Internal helpers ──

  /**
   * Filter records by time period.
   */
  function filterByPeriod(period: TimePeriod): CostRecord[] {
    if (period === 'all') return records;

    const cutoff = Date.now() - PERIOD_MS[period];
    return records.filter((r) => r.timestamp >= cutoff);
  }

  /**
   * Format a timestamp as YYYY-MM-DD.
   */
  function toDateKey(timestamp: number): string {
    const d = new Date(timestamp);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // ── Public API ──

  function record(entry: CostRecord): void {
    records.push(entry);
  }

  function getStats(period: TimePeriod = 'all'): GatewayStats {
    const filtered = filterByPeriod(period);

    let totalCost = 0;
    let totalLatencyMs = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    const requestsByProvider: Record<string, number> = {};
    const requestsByModel: Record<string, number> = {};
    const errorsByType: Record<string, number> = {};

    for (const r of filtered) {
      totalCost += r.cost;
      totalLatencyMs += r.latencyMs;

      if (r.cached) {
        cacheHits += 1;
      } else {
        cacheMisses += 1;
      }

      // Count by provider.
      requestsByProvider[r.provider] = (requestsByProvider[r.provider] ?? 0) + 1;

      // Count by model.
      requestsByModel[r.model] = (requestsByModel[r.model] ?? 0) + 1;
    }

    const totalRequests = filtered.length;
    const cacheHitRate =
      totalRequests > 0 ? cacheHits / totalRequests : 0;
    const avgLatencyMs =
      totalRequests > 0 ? totalLatencyMs / totalRequests : 0;

    return {
      totalRequests,
      totalCost,
      cacheHitRate,
      avgLatencyMs,
      requestsByProvider,
      requestsByModel,
      errorsByType,
      uptime: 0, // Caller should set this from GatewayState.startedAt.
    };
  }

  function getModelCosts(): Record<string, number> {
    const costs: Record<string, number> = {};

    for (const r of records) {
      costs[r.model] = (costs[r.model] ?? 0) + r.cost;
    }

    return costs;
  }

  function getProviderCosts(): Record<string, number> {
    const costs: Record<string, number> = {};

    for (const r of records) {
      costs[r.provider] = (costs[r.provider] ?? 0) + r.cost;
    }

    return costs;
  }

  function getDailyCosts(): DailyCost[] {
    const dailyMap = new Map<string, number>();

    // Aggregate costs by day.
    for (const r of records) {
      const day = toDateKey(r.timestamp);
      dailyMap.set(day, (dailyMap.get(day) ?? 0) + r.cost);
    }

    // Convert to sorted array (oldest first).
    const result: DailyCost[] = [];
    for (const [date, cost] of dailyMap) {
      result.push({ date, cost });
    }
    result.sort((a, b) => a.date.localeCompare(b.date));

    return result;
  }

  return { record, getStats, getModelCosts, getProviderCosts, getDailyCosts };
}

// ── Cost Calculation Helper ──────────────────────────────────────────────────

/**
 * Calculate the cost of a request in USD.
 *
 * Formula: (prompt_tokens / 1000) * inputCost + (completion_tokens / 1000) * outputCost
 *
 * @param promptTokens    - Number of tokens in the prompt.
 * @param completionTokens - Number of tokens in the completion.
 * @param inputCostPer1k  - Cost per 1,000 input tokens in USD.
 * @param outputCostPer1k - Cost per 1,000 output tokens in USD.
 * @returns The total cost in USD.
 */
export function calculateCost(
  promptTokens: number,
  completionTokens: number,
  inputCostPer1k: number,
  outputCostPer1k: number,
): number {
  const inputCost = (promptTokens / 1000) * inputCostPer1k;
  const outputCost = (completionTokens / 1000) * outputCostPer1k;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}
