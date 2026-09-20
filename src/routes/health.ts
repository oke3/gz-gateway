// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * Health check and stats endpoints:
 *   GET /health        -> { status: "ok", uptime: number }
 *   GET /v1/stats      -> GatewayStats
 *   GET /v1/costs      -> cost breakdown by provider/model
 */

import type { GatewayStats, CostRecord } from '../core/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface HealthResponse {
  status: 'ok' | 'degraded';
  uptime: number;
  version: string;
}

interface CostBreakdown {
  byProvider: Record<string, { totalCost: number; totalTokens: number; requestCount: number }>;
  byModel: Record<string, { totalCost: number; totalTokens: number; requestCount: number }>;
  totalCost: number;
  totalTokens: number;
  recordCount: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * GET /health — lightweight liveness probe.
 */
export function handleHealth(startedAt: number): Response {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  const body: HealthResponse = {
    status: 'ok',
    uptime,
    version: '0.1.0',
  };
  return jsonOk(body);
}

/**
 * GET /v1/stats — aggregated gateway statistics.
 */
export function handleStats(
  startedAt: number,
  stats: {
    totalRequests: number;
    totalCost: number;
    totalLatencyMs: number;
    cacheHits: number;
    cacheMisses: number;
    requestsByProvider: Record<string, number>;
    requestsByModel: Record<string, number>;
    errorsByType: Record<string, number>;
  },
): Response {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  const totalCache = stats.cacheHits + stats.cacheMisses;
  const avgLatency =
    stats.totalRequests > 0
      ? Math.round(stats.totalLatencyMs / stats.totalRequests)
      : 0;

  const gatewayStats: GatewayStats = {
    totalRequests: stats.totalRequests,
    totalCost: Math.round(stats.totalCost * 1_000_000) / 1_000_000,
    cacheHitRate: totalCache > 0 ? Math.round((stats.cacheHits / totalCache) * 10000) / 10000 : 0,
    avgLatencyMs: avgLatency,
    requestsByProvider: { ...stats.requestsByProvider },
    requestsByModel: { ...stats.requestsByModel },
    errorsByType: { ...stats.errorsByType },
    uptime,
  };

  return jsonOk(gatewayStats);
}

/**
 * GET /v1/costs — cost breakdown by provider and model.
 * Optional query param: ?since=<epoch-ms> to filter records.
 */
export function handleCosts(
  costs: CostRecord[],
  searchParams: URLSearchParams,
): Response {
  let records = costs;
  const since = searchParams.get('since');
  if (since) {
    const sinceMs = Number(since);
    if (!isNaN(sinceMs)) {
      records = costs.filter((r) => r.timestamp >= sinceMs);
    }
  }

  const byProvider: Record<
    string,
    { totalCost: number; totalTokens: number; requestCount: number }
  > = {};
  const byModel: Record<
    string,
    { totalCost: number; totalTokens: number; requestCount: number }
  > = {};

  let totalCost = 0;
  let totalTokens = 0;

  for (const r of records) {
    const tokens = r.promptTokens + r.completionTokens;
    totalCost += r.cost;
    totalTokens += tokens;

    // By provider
    if (!byProvider[r.provider]) {
      byProvider[r.provider] = { totalCost: 0, totalTokens: 0, requestCount: 0 };
    }
    byProvider[r.provider].totalCost += r.cost;
    byProvider[r.provider].totalTokens += tokens;
    byProvider[r.provider].requestCount += 1;

    // By model
    const modelKey = r.provider + '/' + r.model;
    if (!byModel[modelKey]) {
      byModel[modelKey] = { totalCost: 0, totalTokens: 0, requestCount: 0 };
    }
    byModel[modelKey].totalCost += r.cost;
    byModel[modelKey].totalTokens += tokens;
    byModel[modelKey].requestCount += 1;
  }

  // Round costs to 6 decimal places
  for (const v of Object.values(byProvider)) {
    v.totalCost = Math.round(v.totalCost * 1_000_000) / 1_000_000;
  }
  for (const v of Object.values(byModel)) {
    v.totalCost = Math.round(v.totalCost * 1_000_000) / 1_000_000;
  }

  const breakdown: CostBreakdown = {
    byProvider,
    byModel,
    totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
    totalTokens,
    recordCount: records.length,
  };

  return jsonOk(breakdown);
}
