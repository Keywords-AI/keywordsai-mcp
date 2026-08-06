import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthenticatedClient } from '../shared/client.js';
import { rawFetch } from '../shared/client.js';
import { registerManifestTool } from '../shared/manifestTool.js';

/**
 * Prompt lifecycle writes, plus the dataset and experiment writes that complete
 * the agent-tier surface.
 */

/** Version content fields prompt_draft_init forwards verbatim. */
const VERSION_CONTENT_KEYS = [
  'messages',
  'model',
  'description',
  'temperature',
  'max_tokens',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stream',
  'seed',
  'reasoning_effort',
  'response_format',
  'tools',
  'tool_choice',
  'variables',
  'fallback_models',
  'load_balance_models',
];

function pick(args: Record<string, any>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined && args[key] !== null) out[key] = args[key];
  }
  return out;
}

/**
 * Resolves a prompt's stored name and refuses when the confirmation misses.
 *
 * The descriptions tell the caller to have the user type the exact name, which
 * only means anything if something compares it.
 */
async function confirmPromptName(
  c: AuthenticatedClient,
  promptId: string,
  typed: unknown,
): Promise<{ ok: true; name: string } | { ok: false; result: Record<string, unknown> }> {
  const detail = (await rawFetch(c, `/api/prompts/${encodeURIComponent(promptId)}/`, {
    method: 'GET',
  })) as { name?: string } | null;
  if (!detail || typeof detail !== 'object') {
    return {
      ok: false,
      result: {
        error: 'not_found',
        message: `Could not fetch prompt ${promptId} to confirm. Verify the prompt_id is correct.`,
      },
    };
  }
  const name = detail.name ?? '';
  if (typed !== name) {
    return {
      ok: false,
      result: {
        error: 'confirmation_failed',
        message: `You typed '${typed}' but the prompt name is '${name}'. Ask the user to type the exact name again. Nothing was deleted.`,
      },
    };
  }
  return { ok: true, name };
}

export function registerLifecycleTools(server: McpServer, client: AuthenticatedClient | null) {
  registerManifestTool(server, client, 'prompt_delete', async (c, args) => {
    const promptId = String(args.prompt_id);
    const check = await confirmPromptName(c, promptId, args.user_confirmation);
    if (!check.ok) return check.result;
    await rawFetch(c, `/api/prompts/${encodeURIComponent(promptId)}/`, { method: 'DELETE' });
    return { deleted: true, prompt_id: promptId, name: check.name };
  });

  registerManifestTool(server, client, 'prompt_permanent_delete', async (c, args) => {
    const promptId = String(args.prompt_id);
    const check = await confirmPromptName(c, promptId, args.user_confirmation);
    if (!check.ok) return check.result;
    await rawFetch(c, `/api/prompts/${encodeURIComponent(promptId)}/?permanent=true`, {
      method: 'DELETE',
    });
    return { permanently_deleted: true, prompt_id: promptId, name: check.name };
  });

  registerManifestTool(server, client, 'prompt_draft_init', async (c, args) => {
    if (!args.messages || (Array.isArray(args.messages) && args.messages.length === 0)) {
      return {
        error: 'validation_error',
        message:
          '\'messages\' is required. Provide an array of message objects, e.g. [{"role": "system", "content": [{"type": "text", "text": "..."}]}]',
      };
    }
    return rawFetch(c, `/api/prompts/${encodeURIComponent(args.prompt_id)}/versions/`, {
      method: 'POST',
      body: pick(args, VERSION_CONTENT_KEYS),
    });
  });

  registerManifestTool(server, client, 'prompt_trash_restore', async (c, args) =>
    rawFetch(c, '/api/prompts/backups/', {
      method: 'POST',
      body: { prompt_id: args.prompt_id },
    }),
  );

  // organization_id is dropped: it is the cross-org restore path, which this
  // surface does not offer. Without it the backend scopes the restore to the
  // caller's own organization, which is the only behaviour available here.
  registerManifestTool(
    server,
    client,
    'prompt_backup_restore',
    async (c, args) =>
      rawFetch(c, '/api/prompts/backups/', {
        method: 'POST',
        body: pick(args, ['prompt_id', 'date']),
      }),
    { omit: ['organization_id'] },
  );

  registerManifestTool(server, client, 'dataset_log_create', async (c, args) =>
    rawFetch(c, `/api/datasets/${encodeURIComponent(args.dataset_id)}/logs/`, {
      method: 'POST',
      body: pick(args, ['input', 'output', 'expected_output', 'metadata', 'metrics']),
    }),
  );

  registerManifestTool(server, client, 'experiment_update', async (c, args) => {
    const body = pick(args, ['name', 'description', 'evaluator_workflow_ids']);
    if (Object.keys(body).length === 0) {
      return {
        error: 'validation_error',
        message:
          'No fields to update. Provide at least one of: name, description, evaluator_workflow_ids.',
      };
    }
    return rawFetch(c, `/api/v2/experiments/${encodeURIComponent(args.experiment_id)}/`, {
      method: 'PATCH',
      body,
    });
  });
}
