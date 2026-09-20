// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * Hash-based response cache for identical chat completion requests.
 *
 * Architecture:
 *   - Cache key = SHA-256(model + sorted messages + temperature + max_tokens).
 *   - TTL-based expiration with automatic eviction.
 *   - LRU eviction when maxEntries is reached (least recently accessed evicted first).
 *   - In-memory Map — no persistence across restarts.
 *
 * Usage:
 *   const cache = createCache({ ttlSeconds: 3600, maxEntries: 1000 });
 *   const hit = cache.get(key);
 *   if (hit) return hit.response;
 *   const response = await fetchCompletion(req);
 *   cache.set(key, response);
 */

import { createHash } from 'node:crypto';
import type { CacheEntry, ChatCompletionRequest, ChatCompletionResponse } from '../core/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CacheConfig {
  /** Time-to-live in seconds. Entries older than this are evicted. */
  ttlSeconds: number;
  /** Maximum number of entries before LRU eviction kicks in. */
  maxEntries: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

export interface ResponseCache {
  /**
   * Retrieve a cached response by its hash key.
   * Returns `null` on miss or if the entry has expired.
   * Updates access time for LRU tracking on hit.
   */
  get(key: string): CacheEntry | null;

  /**
   * Store a response in the cache.
   * Triggers LRU eviction if the cache is full.
   */
  set(key: string, response: ChatCompletionResponse): void;

  /** Remove all entries from the cache. */
  clear(): void;

  /** Get cache statistics. */
  stats(): CacheStats;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a cache key from a chat completion request.
 *
 * The key is a SHA-256 hex digest of a canonical string:
 *   `model|sorted-messages-json|temperature|max_tokens`
 *
 * Messages are sorted by role+content to ensure that reordering
 * doesn't produce a different cache key (order-independent matching).
 * Fields that don't affect the response (stream, tools) are excluded.
 */
export function deriveCacheKey(request: ChatCompletionRequest): string {
  // Canonicalize messages: sort by role then content for stable hashing.
  const sortedMessages = [...request.messages]
    .sort((a, b) => {
      const roleCmp = a.role.localeCompare(b.role);
      if (roleCmp !== 0) return roleCmp;
      return (a.content ?? '').localeCompare(b.content ?? '');
    })
    .map((m) => `${m.role}:${m.content ?? ''}`);

  const canonical = [
    request.model,
    JSON.stringify(sortedMessages),
    String(request.temperature ?? 1.0),
    String(request.max_tokens ?? 4096),
  ].join('|');

  return createHash('sha256').update(canonical).digest('hex');
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an in-memory LRU response cache.
 *
 * Entries are stored in a Map and ordered by last access time.
 * On each `get()` hit, the entry is moved to the end (most-recently used).
 * On `set()` when full, the least-recently used entry (first in the Map) is evicted.
 */
export function createCache(config: CacheConfig): ResponseCache {
  // Map preserves insertion order — we exploit this for LRU.
  // Most-recently used entries are re-inserted at the end on access.
  const entries = new Map<string, CacheEntry>();

  let hits = 0;
  let misses = 0;

  // ── TTL in milliseconds ──
  const ttlMs = config.ttlSeconds * 1000;

  /**
   * Check if an entry has expired.
   */
  function isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.createdAt > ttlMs;
  }

  /**
   * Evict the least-recently used entry (first in the Map).
   */
  function evictLRU(): void {
    const firstKey = entries.keys().next().value;
    if (firstKey !== undefined) {
      entries.delete(firstKey);
    }
  }

  /**
   * Promote an entry to the most-recently used position.
   * Re-inserts it at the end of the Map.
   */
  function promote(key: string, entry: CacheEntry): void {
    entries.delete(key);
    entries.set(key, entry);
  }

  // ── Public API ──

  function get(key: string): CacheEntry | null {
    const entry = entries.get(key);

    if (!entry) {
      misses += 1;
      return null;
    }

    // Expired — remove and count as miss.
    if (isExpired(entry)) {
      entries.delete(key);
      misses += 1;
      return null;
    }

    // Hit — promote to MRU position and increment counter.
    entry.hits += 1;
    promote(key, entry);
    hits += 1;
    return entry;
  }

  function set(key: string, response: ChatCompletionResponse): void {
    // If key already exists, just update it.
    if (entries.has(key)) {
      const existing = entries.get(key)!;
      existing.response = response;
      existing.createdAt = Date.now();
      existing.hits = 0;
      promote(key, existing);
      return;
    }

    // Evict LRU entries until we have room.
    while (entries.size >= config.maxEntries) {
      evictLRU();
    }

    // Insert the new entry.
    entries.set(key, {
      key,
      response,
      createdAt: Date.now(),
      hits: 0,
    });
  }

  function clear(): void {
    entries.clear();
    hits = 0;
    misses = 0;
  }

  function stats(): CacheStats {
    return {
      hits,
      misses,
      size: entries.size,
    };
  }

  return { get, set, clear, stats };
}
