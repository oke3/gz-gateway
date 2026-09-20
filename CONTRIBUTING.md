# Contributing to gz-gateway

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/oke3/gz-gateway.git
cd gz-gateway

# Install dependencies
npm install

# Build
npm run build

# Run in dev mode (watch)
npm run dev

# Type check
npm run lint

# Run tests
npm test
```

## Project Structure

```
src/
  core/
    config.ts       # Config loading, validation, merging
    types.ts        # All TypeScript interfaces and defaults
  middleware/
    cache.ts        # SHA-256 hash-based response cache
    circuit-breaker.ts  # Three-state circuit breaker
    rate-limiter.ts # Token-bucket rate limiter
  providers/
    proxy.ts        # Request forwarding and format translation
    registry.ts     # Provider health tracking and model routing
  routes/
    chat.ts         # /v1/chat/completions handler
    health.ts       # /health, /v1/stats, /v1/costs
    models.ts       # /v1/models handler
  utils/
    cost-tracker.ts # Cost aggregation and reporting
    load-balancer.ts # Provider selection strategies
  index.ts          # HTTP server entry point
  cli.ts            # CLI entry point
test/
  gateway.test.ts   # Unit tests
```

## Code Style

- **TypeScript strict mode** — no `any` types
- **ES modules** — use `import`/`export`
- **Async/await** — no raw promises or callbacks
- **Copyright header** — every file starts with `// Copyright (c) 2026 Ground Zero LLC. All rights reserved.`
- **No external dependencies** in core logic — only `commander` for CLI

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add semantic caching support
fix: handle empty response body from upstream
docs: update provider setup examples
test: add circuit breaker state transition tests
refactor: extract format transformers to separate module
```

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes with tests
3. Ensure `npm run lint` passes (type check)
4. Ensure `npm test` passes
5. Write a clear PR description explaining **what** and **why**

## Testing

Tests use [vitest](https://vitest.dev/). Run with:

```bash
npm test           # Single run
npm run test:watch # Watch mode
```

Test files go in `test/` and follow the naming convention `*.test.ts`.

## Reporting Issues

Open an issue on [GitHub](https://github.com/oke3/gz-gateway/issues) with:

- A clear title and description
- Steps to reproduce (if applicable)
- Expected vs actual behavior
- Node.js/Bun version and OS

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
