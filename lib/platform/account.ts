import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthenticatedClient } from '../shared/client.js';
import { rawFetch } from '../shared/client.js';
import { registerManifestTool, queryFrom } from '../shared/manifestTool.js';
import { clampPagination } from '../shared/pagination.js';

/**
 * Account-level reads and the annotation / score surfaces.
 *
 * Org scoping is never an argument here. Every endpoint below derives the
 * organization from the token, which is the only scoping this surface allows.
 */

const NOTIFICATION_METHODS = '/user/organization-notification-methods';

/** Adds page/page_size for a tool, always both, clamped to its profile. */
function paged(tool: string, args: Record<string, any>, extra: string[] = []): URLSearchParams {
  const q = queryFrom(args, extra);
  const paging = clampPagination(tool, args);
  q.set('page', String(paging.page));
  q.set('page_size', String(paging.page_size));
  return q;
}

function eq(value: unknown): { operator: string; value: unknown } {
  return { operator: '', value };
}

export function registerAccountTools(server: McpServer, client: AuthenticatedClient | null) {
  // --- notification methods ---
  registerManifestTool(server, client, 'notification_method_list', async (c, args) =>
    rawFetch(c, `${NOTIFICATION_METHODS}/?${paged('notification_method_list', args).toString()}`, {
      method: 'GET',
    }),
  );

  registerManifestTool(server, client, 'notification_method_create', async (c, args) =>
    rawFetch(c, `${NOTIFICATION_METHODS}/`, {
      method: 'POST',
      body: {
        notification_type: args.notification_type,
        notification_config: args.notification_config,
      },
    }),
  );

  registerManifestTool(server, client, 'notification_method_update', async (c, args) => {
    const body: Record<string, unknown> = {};
    if (args.notification_type !== undefined) body.notification_type = args.notification_type;
    if (args.notification_config !== undefined) body.notification_config = args.notification_config;
    return rawFetch(c, `${NOTIFICATION_METHODS}/${encodeURIComponent(args.notification_method_id)}/`, {
      method: 'PATCH',
      body,
    });
  });

  registerManifestTool(server, client, 'notification_method_delete', async (c, args) => {
    const id = String(args.notification_method_id);
    // This tool confirms on the ID rather than a name, matching the backend.
    if (args.user_confirmation !== id) {
      return {
        error: 'confirmation_failed',
        message: `You typed '${args.user_confirmation}' but the ID is '${id}'. Nothing was deleted.`,
      };
    }
    await rawFetch(c, `${NOTIFICATION_METHODS}/${encodeURIComponent(id)}/`, { method: 'DELETE' });
    return { deleted: true, notification_method_id: id };
  });

  // --- scores ---
  registerManifestTool(server, client, 'score_list', async (c, args) => {
    const q = paged('score_list', args, ['start_time', 'end_time', 'environment', 'sort_by']);
    const filters: Record<string, unknown> = {};
    if (args.evaluator_id) filters.evaluator_id = eq(args.evaluator_id);
    return rawFetch(c, `/api/scores/list/?${q.toString()}`, {
      method: 'POST',
      body: Object.keys(filters).length ? { filters } : {},
    });
  });

  registerManifestTool(server, client, 'score_create', async (c, args) => {
    // The value lands in a type-specific column, chosen from the value itself.
    const body: Record<string, unknown> = {
      log_id: args.log_id,
      evaluator_id: args.evaluator_id,
    };
    const value = args.value;
    if (typeof value === 'boolean') body.boolean_value = value;
    else if (typeof value === 'number') body.numerical_value = value;
    else body.string_value = String(value);
    return rawFetch(c, '/api/scores/', { method: 'POST', body });
  });

  // --- annotations ---
  registerManifestTool(server, client, 'annotation_items_list', async (c, args) => {
    const q = paged('annotation_items_list', args, ['sort_by']);
    const filters: Record<string, unknown> = {};
    if (args.status) filters.status = eq(args.status);
    if (args.source_type) filters.source_type = eq(args.source_type);
    if (args.assignee) filters.assignee = eq(args.assignee);
    return rawFetch(c, `/api/annotation-items/list/?${q.toString()}`, {
      method: 'POST',
      body: Object.keys(filters).length ? { filters } : {},
    });
  });

  registerManifestTool(server, client, 'annotation_queue_list', async (c, args) => {
    const q = paged('annotation_queue_list', args, ['sort_by']);
    // The queue is self-scoped server-side to the authenticated user; these
    // filters only narrow within it.
    const filters: Record<string, unknown> = {};
    if (args.status) filters.status = eq(args.status);
    if (args.source_type) filters.source_type = eq(args.source_type);
    return rawFetch(c, `/api/annotation-items/queue/?${q.toString()}`, {
      method: 'POST',
      body: Object.keys(filters).length ? { filters } : {},
    });
  });

  registerManifestTool(server, client, 'annotation_item_update', async (c, args) => {
    const body: Record<string, unknown> = {};
    if (args.status !== undefined && args.status !== null) body.status = args.status;
    if (args.notes !== undefined && args.notes !== null) body.notes = args.notes;
    if (args.assignee !== undefined && args.assignee !== null) body.assignee = args.assignee;
    if (Object.keys(body).length === 0) {
      return {
        error: 'validation_error',
        message: 'No fields to update. Provide at least one of: status, notes, assignee.',
      };
    }
    return rawFetch(c, `/api/annotation-items/${encodeURIComponent(args.item_id)}/`, {
      method: 'PATCH',
      body,
    });
  });

  // --- keys, credits, limits ---
  registerManifestTool(server, client, 'api_key_list', async (c, args) => {
    const q = paged('api_key_list', args);
    const filters: Record<string, unknown> = {};
    if (args.name) filters.name = { operator: 'icontains', value: args.name };
    if (args.status) filters.status = eq(args.status);
    if (args.created_by_email) filters['user__email'] = eq(args.created_by_email);
    return rawFetch(c, `/api/keys/list/?${q.toString()}`, {
      method: 'POST',
      body: Object.keys(filters).length ? { filters } : {},
    });
  });

  registerManifestTool(server, client, 'credit_transactions_list', async (c, args) => {
    const q = paged('credit_transactions_list', args, ['start_time', 'end_time', 'sort_by']);
    const filters: Record<string, unknown> = {};
    if (args.transaction_type) filters.transaction_type = eq(args.transaction_type);
    if (args.source_type) filters.source_type = eq(args.source_type);
    return rawFetch(c, `/payment/credit-transactions/list/?${q.toString()}`, {
      method: 'POST',
      body: Object.keys(filters).length ? { filters } : {},
    });
  });

  registerManifestTool(server, client, 'limit_policy_list', async (c, args) =>
    rawFetch(c, `/api/limit-policies/?${paged('limit_policy_list', args).toString()}`, {
      method: 'GET',
    }),
  );

  registerManifestTool(server, client, 'limit_policy_state_list', async (c, args) =>
    rawFetch(c, `/api/limit-policies/list/?${paged('limit_policy_state_list', args).toString()}`, {
      method: 'POST',
      body: {},
    }),
  );
}
