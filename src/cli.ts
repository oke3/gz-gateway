// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * gz-gateway CLI — manage the gateway server from the command line.
 *
 * Commands:
 *   serve        Start the gateway server
 *   status       Show gateway status (uptime, providers, costs)
 *   models       List all available models
 *   providers    List all configured providers
 *   costs        Show cost breakdown (by model, provider, time)
 *   config init  Generate default config at ~/.gz-gateway/config.json
 *   config show  Show current config (redact API keys)
 */

import { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { DEFAULT_CONFIG, type GatewayConfig } from './core/types.js';

// ── ANSI Colors (no external dependency) ─────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
};

function colorize(color: string, text: string): string {
  return `${color}${text}${c.reset}`;
}

function bold(text: string): string {
  return colorize(c.bold, text);
}

function dim(text: string): string {
  return colorize(c.dim, text);
}

// ── Config helpers ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = resolve(homedir(), '.gz-gateway/config.json');

async function loadConfig(configPath?: string): Promise<GatewayConfig> {
  const filePath = resolve(configPath ?? DEFAULT_CONFIG_PATH);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const fileConfig = JSON.parse(raw) as Partial<GatewayConfig>;
    return { ...DEFAULT_CONFIG, ...fileConfig } as GatewayConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function redactApiKey(key: string): string {
  if (!key || key.length < 8) return '***';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

function formatCurrency(amount: number): string {
  return '$' + amount.toFixed(6);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h + 'h ' + m + 'm';
}

// ── Table rendering ──────────────────────────────────────────────────────────

interface TableColumn {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

function renderTable(columns: TableColumn[], rows: string[][]): string {
  const lines: string[] = [];

  // Header
  const headerLine = columns
    .map((col) => col.header.padEnd(col.width))
    .join('  ');
  lines.push(colorize(c.bold + c.cyan, headerLine));
  lines.push(colorize(c.gray, '─'.repeat(headerLine.length)));

  // Rows
  for (const row of rows) {
    const line = columns
      .map((col, i) => {
        const val = row[i] ?? '';
        return col.align === 'right' ? val.padStart(col.width) : val.padEnd(col.width);
      })
      .join('  ');
    lines.push(line);
  }

  return lines.join('\n');
}

// ── ASCII Banner ─────────────────────────────────────────────────────────────

function printBanner(): void {
  const banner = `
${colorize(c.cyan + c.bold, '  ╔══════════════════════════════════════════════════╗')}
${colorize(c.cyan + c.bold, '  ║                                                  ║')}
${colorize(c.cyan + c.bold, '  ║')}  ${colorize(c.bold + c.white, 'gz-gateway')}  ${colorize(c.gray, 'v0.1.0')}                         ${colorize(c.cyan + c.bold, '║')}
${colorize(c.cyan + c.bold, '  ║')}  ${colorize(c.dim, 'OpenAI-compatible AI gateway')}                   ${colorize(c.cyan + c.bold, '║')}
${colorize(c.cyan + c.bold, '  ║')}  ${colorize(c.dim, 'Rate limiting · Caching · Failover')}             ${colorize(c.cyan + c.bold, '║')}
${colorize(c.cyan + c.bold, '  ║                                                  ║')}
${colorize(c.cyan + c.bold, '  ╚══════════════════════════════════════════════════╝')}`;
  console.log(banner);
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdServe(opts: { port?: string; host?: string; config?: string; verbose?: boolean }): Promise<void> {
  const overrides: Partial<GatewayConfig> = {};
  if (opts.port) overrides.port = parseInt(opts.port, 10);
  if (opts.host) overrides.host = opts.host;

  const config = await loadConfig(opts.config);
  if (overrides.port) config.port = overrides.port;
  if (overrides.host) config.host = overrides.host;

  printBanner();

  console.log(
    '  ' + colorize(c.green, '▶') + ' ' +
    bold('Starting server') + dim(' ...'),
  );
  console.log();
  console.log(
    '  ' + colorize(c.blue, '◈') + ' ' +
    bold('Listen') + '  ' +
    colorize(c.cyan, `http://${config.host}:${config.port}`),
  );
  console.log(
    '  ' + colorize(c.blue, '◈') + ' ' +
    bold('Providers') + '  ' +
    colorize(c.white, String(config.providers.length)),
  );
  console.log(
    '  ' + colorize(c.blue, '◈') + ' ' +
    bold('Load Balancing') + '  ' +
    colorize(c.white, config.loadBalancing.strategy),
  );
  console.log(
    '  ' + colorize(c.blue, '◈') + ' ' +
    bold('Rate Limiting') + '  ' +
    colorize(config.rateLimiting.enabled ? c.green : c.yellow, config.rateLimiting.enabled ? 'enabled' : 'disabled'),
  );
  console.log(
    '  ' + colorize(c.blue, '◈') + ' ' +
    bold('Caching') + '  ' +
    colorize(config.caching.enabled ? c.green : c.yellow, config.caching.enabled ? 'enabled' : 'disabled'),
  );
  console.log(
    '  ' + colorize(c.blue, '◈') + ' ' +
    bold('Failover') + '  ' +
    colorize(config.failover.enabled ? c.green : c.yellow, config.failover.enabled ? 'enabled' : 'disabled'),
  );
  console.log();

  // Delegate to the main server entry point
  const { buildConfig, createState } = await import('./core/config.js');
  const { createServer } = await import('node:http');

  const fullConfig = await buildConfig(opts.config, overrides);
  const state = createState(fullConfig);

  // Dynamic import of route handlers
  const { handleChatCompletion } = await import('./routes/chat.js');
  const { handleListModels, handleGetModel } = await import('./routes/models.js');
  const { handleHealth, handleStats, handleCosts } = await import('./routes/health.js');

  const MAX_BODY_BYTES = 1024 * 1024;

  function parseBody(req: import('node:http').IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (contentLength > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        return;
      }
      if (contentLength === 0) { resolve(null); return; }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) { req.destroy(); reject(new Error('Request body too large')); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (raw.length === 0) { resolve(null); return; }
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  function sendError(res: import('node:http').ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  }

  async function sendResponse(res: import('node:http').ServerResponse, webRes: Response): Promise<void> {
    webRes.headers.forEach((value, key) => { res.setHeader(key, value); });
    res.statusCode = webRes.status;
    if (!webRes.body) { res.end(); return; }
    const ct = webRes.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const reader = webRes.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally { reader.releaseLock(); res.end(); }
      return;
    }
    const bytes = await webRes.arrayBuffer();
    res.end(Buffer.from(bytes));
  }

  const server = createServer(async (req, res) => {
    const start = Date.now();
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

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

    try {
      let webRes: Response;

      if (path === '/health' && method === 'GET') {
        webRes = handleHealth(state.startedAt);
      } else if (path === '/v1/stats' && method === 'GET') {
        webRes = handleStats(state.startedAt, state.stats);
      } else if (path === '/v1/costs' && method === 'GET') {
        webRes = handleCosts(state.costs, url.searchParams);
      } else if (path === '/v1/models' && method === 'GET') {
        webRes = handleListModels(config);
      } else if (path.startsWith('/v1/models/') && method === 'GET') {
        const modelId = decodeURIComponent(path.slice('/v1/models/'.length));
        webRes = handleGetModel(modelId, config);
      } else if (path === '/v1/chat/completions' && method === 'POST') {
        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.includes('application/json')) {
          sendError(res, 415, { error: { code: 'unsupported_media_type', message: 'Content-Type must be application/json.' } });
          return;
        }
        let body: unknown;
        try { body = await parseBody(req); } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          sendError(res, 400, { error: { code: 'invalid_request', message: msg } });
          return;
        }
        webRes = await handleChatCompletion(
          new Request('http://localhost' + req.url, {
            method,
            headers: Object.fromEntries(Object.entries(req.headers).filter((e): e is [string, string] => e[1] !== undefined)),
            body: body ? JSON.stringify(body) : undefined,
          }),
          body, fullConfig, state, req.headers['authorization'],
        );
      } else {
        webRes = new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'Route not found: ' + method + ' ' + path } }),
          { status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
        );
      }

      await sendResponse(res, webRes);
      const elapsed = Date.now() - start;
      const statusColor = webRes.status >= 500 ? c.red : webRes.status >= 400 ? c.yellow : c.green;
      console.log(
        dim(new Date().toISOString()) + ' ' +
        bold(method) + ' ' +
        path + ' ' +
        colorize(statusColor, String(webRes.status)) + ' ' +
        dim(elapsed + 'ms'),
      );
    } catch (err: unknown) {
      console.error(colorize(c.red, '[gz-gateway] Unhandled error:'), err);
      sendError(res, 500, { error: { code: 'internal_error', message: 'Internal gateway error.' } });
    }
  });

  server.listen(fullConfig.port, fullConfig.host, () => {
    console.log(
      '  ' + colorize(c.green, '✓') + ' ' +
      bold('Listening') + ' on ' +
      colorize(c.cyan, `http://${fullConfig.host}:${fullConfig.port}`),
    );
    console.log();
  });

  const shutdown = (signal: string) => {
    console.log();
    console.log('  ' + colorize(c.yellow, '⏹') + ' ' + bold('Shutting down') + dim(` (${signal})`));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function cmdStatus(opts: { config?: string }): Promise<void> {
  const config = await loadConfig(opts.config);
  const uptime = 0; // Server not running — would need to hit /health endpoint

  console.log();
  console.log(bold('  gz-gateway status'));
  console.log(dim('  ─'.repeat(30)));
  console.log();
  console.log('  ' + bold('Uptime') + '       ' + colorize(c.green, formatDuration(uptime)));
  console.log('  ' + bold('Version') + '      ' + colorize(c.white, '0.1.0'));
  console.log('  ' + bold('Port') + '          ' + colorize(c.cyan, String(config.port)));
  console.log('  ' + bold('Host') + '          ' + colorize(c.cyan, config.host));
  console.log();
  console.log('  ' + bold('Providers'));
  for (const p of config.providers) {
    const status = p.enabled ? colorize(c.green, '●') : colorize(c.red, '○');
    console.log('    ' + status + ' ' + p.name + dim(` (${p.id})`) + ' — ' + dim(p.models.length + ' models'));
  }
  console.log();
  console.log('  ' + bold('Features'));
  console.log('    ' + (config.rateLimiting.enabled ? colorize(c.green, '✓') : colorize(c.red, '✗')) + ' Rate limiting');
  console.log('    ' + (config.caching.enabled ? colorize(c.green, '✓') : colorize(c.red, '✗')) + ' Caching (TTL: ' + config.caching.ttlSeconds + 's)');
  console.log('    ' + (config.failover.enabled ? colorize(c.green, '✓') : colorize(c.red, '✗')) + ' Failover (retries: ' + config.failover.maxRetries + ')');
  console.log('    ' + colorize(c.cyan, '◈') + ' Load balancing: ' + bold(config.loadBalancing.strategy));
  console.log();
}

async function cmdModels(opts: { config?: string }): Promise<void> {
  const config = await loadConfig(opts.config);

  console.log();
  console.log(bold('  Available Models'));
  console.log(dim('  ─'.repeat(30)));
  console.log();

  const columns: TableColumn[] = [
    { header: 'MODEL', width: 40 },
    { header: 'PROVIDER', width: 15 },
    { header: 'STATUS', width: 10 },
  ];

  const rows: string[][] = [];
  for (const p of config.providers) {
    if (!p.enabled) continue;
    for (const model of p.models) {
      rows.push([
        model,
        p.name,
        colorize(c.green, 'active'),
      ]);
    }
  }

  if (rows.length === 0) {
    console.log('  ' + dim('No models configured. Add providers in ~/.gz-gateway/config.json'));
  } else {
    console.log(renderTable(columns, rows));
  }
  console.log();
}

async function cmdProviders(opts: { config?: string }): Promise<void> {
  const config = await loadConfig(opts.config);

  console.log();
  console.log(bold('  Configured Providers'));
  console.log(dim('  ─'.repeat(30)));
  console.log();

  for (const p of config.providers) {
    const status = p.enabled ? colorize(c.green, '● enabled') : colorize(c.red, '○ disabled');
    console.log('  ' + bold(p.name) + dim(` (${p.id})`) + '  ' + status);
    console.log('    ' + dim('Base URL') + '     ' + colorize(c.cyan, p.baseUrl));
    console.log('    ' + dim('API Key') + '      ' + colorize(c.gray, redactApiKey(p.apiKey)));
    console.log('    ' + dim('Priority') + '     ' + String(p.priority));
    console.log('    ' + dim('Models') + '       ' + colorize(c.white, p.models.join(', ')));
    console.log('    ' + dim('Rate Limit') + '   ' + p.rateLimit.requestsPerMinute + ' req/min, ' + p.rateLimit.tokensPerMinute + ' tok/min');
    console.log('    ' + dim('Cost') + '         ' + formatCurrency(p.costPer1kTokens.input) + '/1k in, ' + formatCurrency(p.costPer1kTokens.output) + '/1k out');
    console.log();
  }

  if (config.providers.length === 0) {
    console.log('  ' + dim('No providers configured. Run: gz-gateway config init'));
  }
}

async function cmdCosts(opts: { config?: string }): Promise<void> {
  const config = await loadConfig(opts.config);

  console.log();
  console.log(bold('  Cost Breakdown'));
  console.log(dim('  ─'.repeat(30)));
  console.log();
  console.log('  ' + dim('Cost data is only available while the server is running.'));
  console.log('  ' + dim('Use the API endpoint: GET /v1/costs'));
  console.log();
  console.log('  ' + bold('Provider Cost Rates'));
  console.log();

  const columns: TableColumn[] = [
    { header: 'PROVIDER', width: 20 },
    { header: 'INPUT/1K', width: 15, align: 'right' },
    { header: 'OUTPUT/1K', width: 15, align: 'right' },
  ];

  const rows: string[][] = config.providers.map((p) => [
    p.name,
    formatCurrency(p.costPer1kTokens.input),
    formatCurrency(p.costPer1kTokens.output),
  ]);

  if (rows.length === 0) {
    console.log('  ' + dim('No providers configured.'));
  } else {
    console.log(renderTable(columns, rows));
  }
  console.log();
}

async function cmdConfigInit(): Promise<void> {
  const configDir = resolve(homedir(), '.gz-gateway');
  const configPath = resolve(configDir, 'config.json');

  await mkdir(configDir, { recursive: true });

  const exampleConfig: GatewayConfig = {
    ...DEFAULT_CONFIG,
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '${OPENAI_API_KEY}',
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
        priority: 1,
        rateLimit: { requestsPerMinute: 60, tokensPerMinute: 150_000 },
        costPer1kTokens: { input: 0.0025, output: 0.01 },
        enabled: true,
      },
    ],
  };

  try {
    await writeFile(configPath, JSON.stringify(exampleConfig, null, 2) + '\n', 'utf-8');
    console.log();
    console.log('  ' + colorize(c.green, '✓') + ' ' + bold('Config created'));
    console.log('    ' + dim(configPath));
    console.log();
    console.log('  ' + dim('Edit the file to add your API keys and providers.'));
    console.log('  ' + dim('API keys support ${ENV_VAR} syntax for environment variables.'));
    console.log();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('  ' + colorize(c.red, '✗') + ' ' + bold('Failed to create config') + ': ' + msg);
    process.exit(1);
  }
}

async function cmdConfigShow(opts: { config?: string }): Promise<void> {
  const config = await loadConfig(opts.config);

  // Deep redact API keys
  const redacted = JSON.parse(JSON.stringify(config), (key, value) => {
    if (key === 'apiKey' && typeof value === 'string') {
      return redactApiKey(value);
    }
    return value;
  });

  console.log();
  console.log(bold('  Current Configuration'));
  console.log(dim('  ─'.repeat(30)));
  console.log();
  console.log(colorize(c.gray, JSON.stringify(redacted, null, 2)));
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('gz-gateway')
  .description('OpenAI-compatible AI gateway — rate limiting, caching, failover, cost tracking, load balancing')
  .version('0.1.0');

program
  .command('serve')
  .description('Start the gateway server')
  .option('--port <n>', 'Override server port')
  .option('--host <addr>', 'Override server host')
  .option('--config <path>', 'Custom config path')
  .option('--verbose', 'Enable debug logging')
  .action(cmdServe);

program
  .command('status')
  .description('Show gateway status (uptime, providers, costs)')
  .option('--config <path>', 'Custom config path')
  .action(cmdStatus);

program
  .command('models')
  .description('List all available models')
  .option('--config <path>', 'Custom config path')
  .action(cmdModels);

program
  .command('providers')
  .description('List all configured providers')
  .option('--config <path>', 'Custom config path')
  .action(cmdProviders);

program
  .command('costs')
  .description('Show cost breakdown (by model, provider, time)')
  .option('--config <path>', 'Custom config path')
  .action(cmdCosts);

const configCmd = program
  .command('config')
  .description('Manage gateway configuration');

configCmd
  .command('init')
  .description('Generate default config at ~/.gz-gateway/config.json')
  .action(cmdConfigInit);

configCmd
  .command('show')
  .description('Show current config (redact API keys)')
  .option('--config <path>', 'Custom config path')
  .action(cmdConfigShow);

program.parse();
