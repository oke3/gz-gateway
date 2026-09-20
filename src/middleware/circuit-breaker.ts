// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * Circuit breaker pattern with three states:
 *
 *   closed  → Normal operation. Failures are counted.
 *   open    → Circuit is tripped. All requests are rejected immediately.
 *   half-open → One probe request is allowed through to test recovery.
 *
 * State transitions:
 *   closed  → open       : after `threshold` consecutive failures
 *   open    → half-open  : after `resetMs` milliseconds
 *   half-open → closed   : on the first successful probe
 *   half-open → open     : on any probe failure
 *
 * Usage:
 *   const cb = createCircuitBreaker({ threshold: 5, resetMs: 30_000 });
 *   if (!cb.allow('openai')) return fallback;
 *   try { const res = await callProvider(); cb.recordSuccess('openai'); return res; }
 *   catch { cb.recordFailure('openai'); throw err; }
 */

import type { CircuitState } from '../core/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before the circuit opens. */
  threshold: number;
  /** Time in ms before an open circuit transitions to half-open. */
  resetMs: number;
}

export interface CircuitBreaker {
  /**
   * Check whether a request to the given provider is allowed.
   *
   * - `closed` state: always allowed.
   * - `open` state: blocked unless the reset window has elapsed (→ half-open).
   * - `half-open` state: one probe allowed at a time.
   */
  allow(providerId: string): boolean;

  /** Record a successful request. Resets failure count and closes the circuit. */
  recordSuccess(providerId: string): void;

  /** Record a failed request. Opens the circuit when the threshold is reached. */
  recordFailure(providerId: string): void;

  /** Get the current circuit state for a provider. */
  getState(providerId: string): CircuitState;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a circuit breaker that tracks per-provider failure/success state.
 *
 * Each provider gets its own independent circuit. Providers that have never
 * been recorded default to `closed` with zero failures.
 */
export function createCircuitBreaker(config: CircuitBreakerConfig): CircuitBreaker {
  const circuits = new Map<string, CircuitState>();

  // ── Internal helpers ──

  /**
   * Get or initialize the circuit state for a provider.
   */
  function getOrCreate(providerId: string): CircuitState {
    let state = circuits.get(providerId);
    if (!state) {
      state = {
        state: 'closed',
        failures: 0,
        lastFailure: 0,
        successCount: 0,
      };
      circuits.set(providerId, state);
    }
    return state;
  }

  /**
   * Transition from `open` → `half-open` if the reset window has elapsed.
   */
  function maybeTransitionToHalfOpen(circuit: CircuitState, now: number): void {
    if (circuit.state === 'open' && circuit.lastFailure + config.resetMs <= now) {
      circuit.state = 'half-open';
      circuit.successCount = 0;
    }
  }

  // ── Public API ──

  function allow(providerId: string): boolean {
    const now = Date.now();
    const circuit = getOrCreate(providerId);

    // Check if the circuit should transition from open → half-open.
    maybeTransitionToHalfOpen(circuit, now);

    switch (circuit.state) {
      case 'closed':
        // Normal operation — allow.
        return true;

      case 'open':
        // Circuit is tripped — reject.
        return false;

      case 'half-open':
        // Allow exactly one probe request.
        // If successCount is already > 0, another probe is in flight — reject.
        if (circuit.successCount > 0) {
          return false;
        }
        // Allow the probe.
        return true;

      default:
        // Exhaustive check — TypeScript will error if a case is missing.
        return false;
    }
  }

  function recordSuccess(providerId: string): void {
    const circuit = getOrCreate(providerId);
    const now = Date.now();

    switch (circuit.state) {
      case 'closed':
        // Reset failure counter on success.
        circuit.failures = 0;
        break;

      case 'half-open':
        // Probe succeeded — close the circuit.
        circuit.state = 'closed';
        circuit.failures = 0;
        circuit.successCount = 0;
        break;

      case 'open':
        // Shouldn't happen (allow() would have rejected), but handle gracefully.
        break;
    }
  }

  function recordFailure(providerId: string): void {
    const circuit = getOrCreate(providerId);
    const now = Date.now();

    switch (circuit.state) {
      case 'closed':
        circuit.failures += 1;
        circuit.lastFailure = now;
        // Trip the circuit if threshold reached.
        if (circuit.failures >= config.threshold) {
          circuit.state = 'open';
        }
        break;

      case 'half-open':
        // Probe failed — re-open the circuit.
        circuit.state = 'open';
        circuit.lastFailure = now;
        circuit.failures += 1;
        circuit.successCount = 0;
        break;

      case 'open':
        // Already open — just update the timestamp.
        circuit.lastFailure = now;
        break;
    }
  }

  function getState(providerId: string): CircuitState {
    const now = Date.now();
    const circuit = getOrCreate(providerId);
    maybeTransitionToHalfOpen(circuit, now);
    // Return a shallow copy to prevent external mutation.
    return { ...circuit };
  }

  return { allow, recordSuccess, recordFailure, getState };
}
