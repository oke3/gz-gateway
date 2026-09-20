// Copyright (c) 2026 Ground Zero LLC. All rights reserved.

/**
 * OpenAI-compatible /v1/models route handler.
 *
 * Lists all available models across configured providers.
 * Respects provider enabled/disabled state.
 */

import type { GatewayConfig } from '../core/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface ModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

interface ModelsResponse {
  object: 'list';
  data: ModelObject[];
}

// ── Handler ──────────────────────────────────────────────────────────────────

const EPOCH = Math.floor(Date.now() / 1000);

export function handleListModels(config: GatewayConfig): Response {
  const models: ModelObject[] = [];

  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      models.push({
        id: model,
        object: 'model',
        created: EPOCH,
        owned_by: provider.id,
      });
    }
  }

  const body: ModelsResponse = { object: 'list', data: models };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ── Get single model ─────────────────────────────────────────────────────────

export function handleGetModel(
  modelId: string,
  config: GatewayConfig,
): Response {
  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    if (provider.models.includes(modelId)) {
      const model: ModelObject = {
        id: modelId,
        object: 'model',
        created: EPOCH,
        owned_by: provider.id,
      };
      return new Response(JSON.stringify(model), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  }

  return new Response(
    JSON.stringify({
      error: {
        code: 'model_not_found',
        message: 'Model "' + modelId + '" not found.',
      },
    }),
    {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
