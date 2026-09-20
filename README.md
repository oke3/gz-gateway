# gz-gateway

> OpenAI-compatible AI gateway — rate limiting, caching, failover, cost tracking, load balancing. Zero vendor lock-in.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Ground Zero LLC](https://img.shields.io/badge/Built%20by-Ground%20Zero%20LLC-purple)](https://github.com/oke3)
[![npm](https://img.shields.io/npm/v/@ground-zero-llc/gz-gateway)](https://www.npmjs.com/package/@ground-zero-llc/gz-gateway)
[![CI](https://github.com/oke3/gz-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/oke3/gz-gateway/actions)

---

## Why

Running production AI features means juggling multiple LLM providers — OpenAI, Anthropic, Google, DeepSeek, Groq — each with their own rate limits, error modes, pricing, and quirks. Your application code shouldn't care which provider is behind the curtain.

Most teams solve this with a tangle of if/else provider logic, ad-hoc retry wrappers, and zero visibility into costs. One provider goes down and your app breaks. You burn through budgets because nobody knows which model is eating tokens.

`gz-gateway` is a **drop-in, OpenAI-compatible proxy** that sits between your application and your LLM providers. Send requests to `/v1/chat/completions` using the OpenAI SDK you already know, and the gateway handles everything else: **rate limiting**, **intelligent caching**, **automatic failover**, **load balancing across providers**, and **real-time cost tracking**. Zero vendor lock-in — swap providers by editing a config file.

## Architecture

```
                           gz-gateway
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   Client Request                                                    │
│   POST /v1/chat/completions                                         │
│         │                                                           │
│         ▼                                                           │
│   ┌──────────┐                                                      │
│   │ Validate │──> 400 on bad input                                  │
│   └────┬─────┘                                                      │
│        ▼                                                            │
│   ┌──────────┐                                                      │
│   │ Rate     │──> 429 on limit exceeded                             │
│   │ Limiter  │   (global + per-API-key buckets)                     │
│   └────┬─────┘                                                      │
│        ▼                                                            │
│   ┌──────────┐                                                      │
│   │ Cache    │──> Return cached response (SHA-256 key, LRU)         │
│   │ Check    │                                                      │
│   └────┬─────┘                                                      │
│        ▼                                                            │
│   ┌──────────┐                                                      │
│   │ Circuit  │──> Skip unhealthy providers                          │
│   │ Breaker  │   (closed -> open -> half-open)                      │
│   └────┬─────┘                                                      │
│        ▼                                                            │
│   ┌──────────────────────────────────────┐                          │
│   │        Load Balancer                 │                          │
│   │  priority | round-robin | least-cost │                          │
│   │  least-latency                       │                          │
│   └────┬─────────────────────────────────┘                          │
│        ▼                                                            │
│   ┌──────────┐                                                      │
│   │ Provider │──> OpenAI / Anthropic / Google / DeepSeek / Groq     │
│   │ Proxy    │   (format translation + timeout + retry)             │
│   └────┬─────┘                                                      │
│        ▼                                                            │
│   ┌──────────┐                                                      │
│   │ Track    │──> Cost, latency, tokens per model/provider          │
│   │ & Cache  │                                                      │
│   └────┬─────┘                                                      │
│        ▼                                                            │
│   OpenAI-compatible Response + x-gateway-* headers                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install
npm install @ground-zero-llc/gz-gateway

# Generate config
gz-gateway config init

# Start the server
gz-gateway serve
```

That's it. Point your OpenAI SDK at the gateway:

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'http://localhost:8000/v1',
  apiKey: 'your-anything', // gateway handles auth
})

const res = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
})

console.log(res.choices[0].message.content)
// x-gateway-cost, x-gateway-latency-ms, x-gateway-provider headers included
```

## Features

### Rate Limiting

Dual-layer token-bucket rate limiting — global (all traffic) and per-API-key. Sliding-window counters with automatic cleanup. Returns `429` with `Retry-After` header when limits are hit.

```jsonc
{
  "rateLimiting": {
    "enabled": true,
    "global": { "requestsPerMinute": 60, "tokensPerMinute": 100000 },
    "perApiKey": { "requestsPerMinute": 30, "tokensPerMinute": 50000 }
  }
}
```

### Response Caching

SHA-256 hash-based cache with LRU eviction. Messages are sorted for order-independent matching. Configurable TTL and max entries. Cache hits return instantly with `X-Gateway-Cache: HIT` header.

```jsonc
{
  "caching": {
    "enabled": true,
    "ttlSeconds": 3600,
    "maxEntries": 1000,
    "keyPattern": "exact"
  }
}
```

Per-request override:

```ts
// Force cache bypass
{ "x-gateway-cache": false }

// Force cache hit (for repeat queries)
{ "x-gateway-cache": true }
```

### Automatic Failover

Circuit breaker pattern with three states: **closed** (normal), **open** (rejecting), **half-open** (probing). Configurable failure threshold and reset window. Retries with exponential backoff on transient errors.

```jsonc
{
  "failover": {
    "enabled": true,
    "maxRetries": 2,
    "retryDelayMs": 500,
    "circuitBreaker": {
      "threshold": 5,       // consecutive failures to trip
      "resetMs": 30000      // time before half-open probe
    }
  }
}
```

### Cost Tracking

Every request is tracked with per-model and per-provider cost breakdown. Query costs via `GET /v1/costs` or the CLI. Records are kept in memory with automatic 30-day cleanup.

```bash
gz-gateway costs
```

```
  Provider Cost Rates

  PROVIDER            INPUT/1K     OUTPUT/1K
  ---------------------------------------------
  OpenAI              $0.002500    $0.010000
  Anthropic           $0.003000    $0.015000
  DeepSeek            $0.000140    $0.000280
```

### Load Balancing

Four strategies to route requests across providers:

| Strategy | Behavior |
|----------|----------|
| `priority` | Lowest priority number wins (default) |
| `round-robin` | Cycle through providers evenly |
| `least-cost` | Pick the cheapest provider for the model |
| `least-latency` | Pick the provider with lowest recent latency |

```jsonc
{
  "loadBalancing": {
    "strategy": "least-cost"
  }
}
```

### OpenAI-Compatible

Drop-in replacement for the OpenAI API. Supports:

- `POST /v1/chat/completions` — chat completions (streaming + non-streaming)
- `GET /v1/models` — list available models
- `GET /v1/models/:id` — get model details
- `GET /health` — liveness probe
- `GET /v1/stats` — gateway statistics
- `GET /v1/costs` — cost breakdown

All responses include gateway metadata headers:

| Header | Description |
|--------|-------------|
| `X-Gateway-Provider` | Provider that served the request |
| `X-Gateway-Cost` | Cost in USD |
| `X-Gateway-Latency-Ms` | End-to-end latency |
| `X-Gateway-Cache` | `HIT` on cache hits |

## CLI Reference

```
gz-gateway <command> [options]

Commands:
  serve                    Start the gateway server
  status                   Show gateway status (uptime, providers, costs)
  models                   List all available models
  providers                List all configured providers
  costs                    Show cost breakdown (by model, provider, time)
  config init              Generate default config at ~/.gz-gateway/config.json
  config show              Show current config (redact API keys)

Options:
  --port <n>               Override server port
  --host <addr>            Override server host
  --config <path>          Custom config path
  --verbose                Enable debug logging
  -V, --version            Output the version number
  -h, --help              Display help for command
```

### Examples

```bash
# Start on a custom port
gz-gateway serve --port 3000 --host 127.0.0.1

# Check what's configured
gz-gateway status

# List all models
gz-gateway models

# View provider details
gz-gateway providers

# See cost rates
gz-gateway costs

# Generate fresh config
gz-gateway config init

# View config (API keys redacted)
gz-gateway config show
```

## Configuration

Config resolution order: **defaults <- `~/.gz-gateway/config.json` <- environment variables <- CLI options**.

```jsonc
{
  "port": 8000,
  "host": "0.0.0.0",
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "type": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
      "priority": 1,
      "rateLimit": {
        "requestsPerMinute": 60,
        "tokensPerMinute": 150000
      },
      "costPer1kTokens": {
        "input": 0.0025,
        "output": 0.01
      },
      "enabled": true
    }
  ],
  "rateLimiting": {
    "enabled": true,
    "global": { "requestsPerMinute": 60, "tokensPerMinute": 100000 },
    "perApiKey": { "requestsPerMinute": 30, "tokensPerMinute": 50000 }
  },
  "caching": {
    "enabled": true,
    "ttlSeconds": 3600,
    "maxEntries": 1000,
    "keyPattern": "exact"
  },
  "failover": {
    "enabled": true,
    "maxRetries": 2,
    "retryDelayMs": 500,
    "circuitBreaker": {
      "threshold": 5,
      "resetMs": 30000
    }
  },
  "loadBalancing": {
    "strategy": "priority"
  },
  "logging": {
    "enabled": true,
    "level": "info"
  }
}
```

### Environment Variables

API keys support `${ENV_VAR}` syntax. The gateway resolves these at startup:

```jsonc
{
  "apiKey": "${OPENAI_API_KEY}"      // reads from process.env
}
```

## Provider Setup

### OpenAI

```jsonc
{
  "id": "openai",
  "name": "OpenAI",
  "type": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "${OPENAI_API_KEY}",
  "models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o1-mini"],
  "priority": 1,
  "costPer1kTokens": { "input": 0.0025, "output": 0.01 }
}
```

### Anthropic

```jsonc
{
  "id": "anthropic",
  "name": "Anthropic",
  "type": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "apiKey": "${ANTHROPIC_API_KEY}",
  "models": ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
  "priority": 2,
  "costPer1kTokens": { "input": 0.003, "output": 0.015 }
}
```

### Google Gemini

```jsonc
{
  "id": "google",
  "name": "Google Gemini",
  "type": "google",
  "baseUrl": "https://generativelanguage.googleapis.com",
  "apiKey": "${GOOGLE_API_KEY}",
  "models": ["gemini-2.0-flash", "gemini-1.5-pro"],
  "priority": 3,
  "costPer1kTokens": { "input": 0.000075, "output": 0.0003 }
}
```

### DeepSeek

```jsonc
{
  "id": "deepseek",
  "name": "DeepSeek",
  "type": "deepseek",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "${DEEPSEEK_API_KEY}",
  "models": ["deepseek-chat", "deepseek-reasoner"],
  "priority": 4,
  "costPer1kTokens": { "input": 0.00014, "output": 0.00028 }
}
```

### Groq

```jsonc
{
  "id": "groq",
  "name": "Groq",
  "type": "groq",
  "baseUrl": "https://api.groq.com/openai/v1",
  "apiKey": "${GROQ_API_KEY}",
  "models": ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
  "priority": 5,
  "costPer1kTokens": { "input": 0.00059, "output": 0.00079 }
}
```

### Custom Provider

Any OpenAI-compatible API works:

```jsonc
{
  "id": "local",
  "name": "Local LLM",
  "type": "custom",
  "baseUrl": "http://localhost:11434/v1",
  "apiKey": "not-needed",
  "models": ["llama3", "mistral"],
  "priority": 10,
  "costPer1kTokens": { "input": 0, "output": 0 }
}
```

## Cost Tracking

The gateway tracks every request's cost, latency, token usage, and provider. Query the data via the API or CLI:

### API

```bash
# All costs
curl http://localhost:8000/v1/costs

# Filter by time
curl "http://localhost:8000/v1/costs?since=$(date -d '1 hour ago' +%s000)"
```

### Response

```json
{
  "byProvider": {
    "openai": { "totalCost": 0.42, "totalTokens": 125000, "requestCount": 340 }
  },
  "byModel": {
    "openai/gpt-4o": { "totalCost": 0.38, "totalTokens": 100000, "requestCount": 280 },
    "openai/gpt-4o-mini": { "totalCost": 0.04, "totalTokens": 25000, "requestCount": 60 }
  },
  "totalCost": 0.42,
  "totalTokens": 125000,
  "recordCount": 340
}
```

### Per-Response Headers

Every response includes cost metadata:

```
X-Gateway-Provider: openai
X-Gateway-Cost: 0.001250
X-Gateway-Latency-Ms: 1847
```

## Library API

Use `gz-gateway` as a library in your Node.js/Bun projects:

```ts
import { buildConfig, createState } from '@ground-zero-llc/gz-gateway'

// Load and validate config
const config = await buildConfig('/path/to/config.json', {
  port: 3000,
})

// Create runtime state
const state = createState(config)

// config contains all provider configs, rate limits, etc.
console.log(config.providers.length)
console.log(config.loadBalancing.strategy)
```

### Key Exports

| Export | Description |
|--------|-------------|
| `buildConfig(path?, overrides?)` | Load and validate configuration |
| `createState(config)` | Create mutable runtime state |
| `DEFAULT_CONFIG` | Default configuration object |
| `ConfigError` | Validation error class |

## Development

```bash
# Clone
git clone https://github.com/oke3/gz-gateway.git
cd gz-gateway

# Install
npm install

# Build
npm run build

# Dev (watch mode)
npm run dev

# Type check
npm run lint

# Test
npm test
```

## Related Projects

| Project | Description |
|---------|-------------|
| [gz-context-engine](https://github.com/oke3/gz-context-engine) | Production-grade context engine for AI agents — hybrid RAG, reranking, token-aware assembly |
| [gz-codemap](https://github.com/oke3/gz-codemap) | Codebase topology mapper — AST-based code maps for AI agents |
| [gz-modelrouter](https://github.com/oke3/gz-modelrouter) | Smart LLM model router — pick the best model per task |
| [gz-sessions](https://github.com/oke3/gz-sessions) | Persistent session management for AI agent conversations |
| [gz-sessionrecall](https://github.com/oke3/gz-sessionrecall) | Long-term memory recall for AI agent sessions |
| [gz-bench](https://github.com/oke3/gz-bench) | LLM benchmarking suite — compare models on real workloads |
| [gz-authmesh](https://github.com/oke3/gz-authmesh) | Distributed auth mesh for multi-agent systems |
| [gz-remote](https://github.com/oke3/gz-remote) | Remote execution layer for AI agents — sandboxed code running |

## Enterprise Support

Need custom integrations, SLA guarantees, or dedicated support?

**Ground Zero LLC** offers enterprise support for `gz-gateway`:

- Custom provider integrations
- High-availability deployments
- Security audits and compliance
- Performance optimization
- Priority bug fixes and feature development

Contact: [hello@ground-zero.dev](mailto:hello@ground-zero.dev)

## License

MIT — Ground Zero LLC

---

Built by [Ground Zero LLC](https://github.com/oke3) — AI infrastructure for the agentic age.
