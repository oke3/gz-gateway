# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-01

### Added

- OpenAI-compatible `/v1/chat/completions` endpoint (streaming + non-streaming)
- `/v1/models` and `/v1/models/:id` endpoints
- `/health` liveness probe
- `/v1/stats` aggregated gateway statistics
- `/v1/costs` cost breakdown by provider and model
- Dual-layer rate limiting (global + per-API-key) with sliding-window counters
- SHA-256 hash-based response cache with LRU eviction and configurable TTL
- Circuit breaker pattern (closed -> open -> half-open) per provider
- Load balancing with four strategies: priority, round-robin, least-cost, least-latency
- Provider proxy with format translation for OpenAI, Anthropic, Google, DeepSeek, Groq
- Automatic retry with exponential backoff on transient errors
- Per-request cost tracking with 30-day in-memory retention
- CORS support on all endpoints
- CLI with serve, status, models, providers, costs, config commands
- Configuration via `~/.gz-gateway/config.json` with environment variable resolution
- Streaming SSE support for chat completions
- Graceful shutdown on SIGTERM/SIGINT
