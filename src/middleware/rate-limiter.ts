// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * Token-bucket rate limiter with per-IP and per-API-key tracking.
 *
 * Architecture:
 *   - Two independent buckets: global (all traffic) and per-key (per API key or IP).
 *   - Sliding-window counter with automatic cleanup of expired entries.
 *   - Thread-safe via synchronous Map operations (Bun is single-threaded per worker).
 *
 * Usage:
 *   const limiter = createRateLimiter({ global: { rpm: 60, tpm: 100_000 }, perKey: { rpm: 30, tpm: 50_000 } });
 *   if (!limiter.check('ip:1.2.3.4', 1)) { /* rate limited *\/ }
 */

import type { RateLimitBucket } from '../core/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Global rate limit (applies to all traffic combined). */
  global: { rpm: number; tpm: number };
  /** Per-key rate limit (applies to each unique API key or IP). */
  perKey: { rpm: number; tpm: number };
}

export interface RateLimitStatus {
  /** Number of tokens remaining in the current window. */
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
  /** Whether the request was allowed. */
  allowed: boolean;
}

export interface RateLimiter {
  /**
   * Check whether a request is allowed under both global and per-key limits.
   *
   * @param key   - Unique identifier (e.g. `"ip:1.2.3.4"` or `"key:sk-..."`).
   * @param tokens - Number of tokens to consume (defaults to 1 for request counting).
   * @returns `true` if allowed, `false` if rate-limited.
   */
  check(key: string, tokens?: number): boolean;

  /** Get the current status of a key's rate-limit bucket. */
  getStatus(key: string): RateLimitStatus;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Cleanup interval: evict expired buckets every 60 seconds. */
const CLEANUP_INTERVAL_MS = 60_000;

/** Window duration: 1 minute sliding window. */
const WINDOW_MS = 60_000;

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a token-bucket rate limiter.
 *
 * The limiter maintains two maps:
 *   1. `globalBucket` — single bucket for all traffic.
 *   2. `keyBuckets` — one bucket per unique key (IP or API key).
 *
 * Both buckets use a fixed 60-second sliding window. When the window expires,
 * the bucket resets. Excess entries are cleaned up periodically to prevent
 * unbounded memory growth.
 */
export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  // ── State ──
  const globalBucket: RateLimitBucket = {
    requests: 0,
    tokens: 0,
    resetAt: Date.now() + WINDOW_MS,
  };

  const keyBuckets = new Map<string, RateLimitBucket>();

  // ── Cleanup timer ──
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of keyBuckets) {
      if (bucket.resetAt <= now) {
        keyBuckets.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // Allow the process to exit even if the timer is active.
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  // ── Internal helpers ──

  /**
   * Reset a bucket if its window has expired.
   * Returns the (possibly refreshed) bucket.
   */
  function refreshBucket(bucket: RateLimitBucket, now: number): RateLimitBucket {
    if (bucket.resetAt <= now) {
      bucket.requests = 0;
      bucket.tokens = 0;
      bucket.resetAt = now + WINDOW_MS;
    }
    return bucket;
  }

  /**
   * Check and consume tokens from a bucket.
   * Returns `true` if the request fits within limits.
   */
  function consumeBucket(
    bucket: RateLimitBucket,
    maxRequests: number,
    maxTokens: number,
    tokens: number,
    now: number,
  ): boolean {
    refreshBucket(bucket, now);

    // Check both request count and token count.
    if (bucket.requests >= maxRequests || bucket.tokens + tokens > maxTokens) {
      return false;
    }

    bucket.requests += 1;
    bucket.tokens += tokens;
    return true;
  }

  /**
   * Get or create a bucket for a given key.
   */
  function getOrCreateBucket(key: string, now: number): RateLimitBucket {
    let bucket = keyBuckets.get(key);
    if (!bucket) {
      bucket = {
        requests: 0,
        tokens: 0,
        resetAt: now + WINDOW_MS,
      };
      keyBuckets.set(key, bucket);
    }
    return refreshBucket(bucket, now);
  }

  // ── Public API ──

  function check(key: string, tokens: number = 1): boolean {
    const now = Date.now();

    // 1. Global limit check
    if (
      !consumeBucket(
        globalBucket,
        config.global.rpm,
        config.global.tpm,
        tokens,
        now,
      )
    ) {
      return false;
    }

    // 2. Per-key limit check
    const keyBucket = getOrCreateBucket(key, now);
    if (
      !consumeBucket(
        keyBucket,
        config.perKey.rpm,
        config.perKey.tpm,
        tokens,
        now,
      )
    ) {
      // Roll back the global consumption — the request was rejected.
      globalBucket.requests -= 1;
      globalBucket.tokens -= tokens;
      return false;
    }

    return true;
  }

  function getStatus(key: string): RateLimitStatus {
    const now = Date.now();
    const keyBucket = getOrCreateBucket(key, now);
    const remaining = Math.max(
      0,
      config.perKey.rpm - keyBucket.requests,
    );

    return {
      remaining,
      resetAt: keyBucket.resetAt,
      allowed: remaining > 0,
    };
  }

  return { check, getStatus };
}
