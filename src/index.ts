// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * gz-gateway entry point — HTTP server, routing, CORS, and graceful shutdown.
 *
 * Architecture:
 *   - Pure Node.js http server (no framework dependency)
 *   - Web-standard Request/Response objects for handlers
 *   - JSON body parsing with size limits
 *   - CORS headers on every response
 *   - Graceful shutdown on SIGTERM / SIGINT
 *   - Request logging to stdout
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { buildConfig, createState } from './core/config.js';
import { handleChatCompletion } from './routes/chat.js';
import { handleListModels, handleGetModel } from './routes/models.js';
import { handleHealth, handleStats, handleCosts } from './routes/health.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

// ── Body parsing ─────────────────────────────────────────────────────────────

/**
 * Read and parse the full request body as JSON.
 * Enforces a size limit to prevent memory exhaustion.
 * Returns null if the body is empty (e.g. GET requests).
 */
function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      reject(new Error('Request body too large (max ' + MAX_BODY_BYTES + ' bytes)'));
      return;
    }
    if (contentLength === 0) {
      resolve(null);
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large (max ' + MAX_BODY_BYTES + ' bytes)'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON in request body'));
      }
    });

    req.on('error', reject);
  });
}

// ── Response helpers ─────────────────────────────────────────────────────────

/** Send a pre-built Web Response through the Node.js ServerResponse. */
async function sendResponse(res: ServerResponse, webRes: Response): Promise<void> {
  // Copy headers from Web Response to Node.js response
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.statusCode = webRes.status;

  if (!webRes.body) {
    res.end();
    return;
  }

  // Check if this is a streaming response (SSE)
  const contentType = webRes.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    // Stream SSE chunks
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = webRes.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        res.write(text);
      }
    } finally {
      reader.releaseLock();
      res.end();
    }
    return;
  }

  // Non-streaming: buffer and send
  const bytes = await webRes.arrayBuffer();
  res.end(Buffer.from(bytes));
}

/** Send a JSON error response directly (used before Web Response is available). */
function sendError(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

// ── Logging ──────────────────────────────────────────────────────────────────

function logRequest(
  method: string,
  path: string,
  status: number,
  elapsedMs: number,
): void {
  const ts = new Date().toISOString();
  const statusColor = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : '\x1b[32m';
  const reset = '\x1b[0m';
  console.log(
    ts + ' ' + method + ' ' + path + ' ' +
    statusColor + status + reset + ' ' +
    elapsedMs + 'ms',
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load config and initialize state
  const config = await buildConfig();
  const state = createState(config);

  const server = createServer(async (req, res) => {
    const start = Date.now();
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // ── CORS preflight ──
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Gateway-Cache, X-Gateway-Timeout',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // ── Routing ──
    try {
      let webRes: Response;

      if (path === '/health' && method === 'GET') {
        webRes = handleHealth(state.startedAt);
      }
      else if (path === '/v1/stats' && method === 'GET') {
        webRes = handleStats(state.startedAt, state.stats);
      }
      else if (path === '/v1/costs' && method === 'GET') {
        webRes = handleCosts(state.costs, url.searchParams);
      }
      else if (path === '/v1/models' && method === 'GET') {
        webRes = handleListModels(config);
      }
      else if (path.startsWith('/v1/models/') && method === 'GET') {
        const modelId = decodeURIComponent(path.slice('/v1/models/'.length));
        webRes = handleGetModel(modelId, config);
      }
      else if (path === '/v1/chat/completions' && method === 'POST') {
        // Parse body
        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.includes('application/json')) {
          sendError(res, 415, {
            error: { code: 'unsupported_media_type', message: 'Content-Type must be application/json.' },
          });
          logRequest(method, path, 415, Date.now() - start);
          return;
        }

        let body: unknown;
        try {
          body = await parseBody(req);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          sendError(res, 400, {
            error: { code: 'invalid_request', message: msg },
          });
          logRequest(method, path, 400, Date.now() - start);
          return;
        }

        webRes = await handleChatCompletion(
          new Request('http://localhost' + req.url, {
            method,
            headers: Object.fromEntries(
              Object.entries(req.headers).filter(
                (e): e is [string, string] => e[1] !== undefined,
              ),
            ),
            body: body ? JSON.stringify(body) : undefined,
          }),
          body,
          config,
          state,
          req.headers['authorization'],
        );
      }
      else {
        // 404 for unmatched routes
        webRes = new Response(
          JSON.stringify({
            error: { code: 'not_found', message: 'Route not found: ' + method + ' ' + path },
          }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          },
        );
      }

      await sendResponse(res, webRes);
      logRequest(method, path, webRes.status, Date.now() - start);
    } catch (err: unknown) {
      console.error('[gz-gateway] Unhandled error:', err);
      sendError(res, 500, {
        error: { code: 'internal_error', message: 'Internal gateway error.' },
      });
      logRequest(method, path, 500, Date.now() - start);
    }
  });

  server.listen(config.port, config.host, () => {
    console.log('[gz-gateway] Listening on http://' + config.host + ':' + config.port);
    console.log('[gz-gateway] Providers: ' + config.providers.length);
    console.log('[gz-gateway] Load balancing: ' + config.loadBalancing.strategy);
  });

  // ── Graceful shutdown ──
  const shutdown = (signal: string) => {
    console.log('[gz-gateway] Received ' + signal + ', shutting down...');
    server.close(() => {
      console.log('[gz-gateway] Server closed.');
      process.exit(0);
    });
    // Force close after 10s
    setTimeout(() => {
      console.error('[gz-gateway] Forced shutdown after timeout.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[gz-gateway] Fatal:', err);
  process.exit(1);
});
