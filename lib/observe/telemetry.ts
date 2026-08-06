import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthenticatedClient } from '../shared/client.js';
import { rawFetch } from '../shared/client.js';
import { registerManifestTool, queryFrom } from '../shared/manifestTool.js';
import { clampPagination } from '../shared/pagination.js';

/**
 * Aggregate telemetry reads: threads, trace/log rollups and per-log scores.
 *
 * These sit alongside log_list / trace_list in observe/, but each is a summary
 * or count rather than a row listing, so they share the POST-for-filtering
 * shape instead of the paginated one.
 */

/** Shorthand arguments log_count exposes, mapped to their real field and operator. */
const LOG_COUNT_SHORTHANDS: Record<string, [string, string]> = {
  status_filter: ['status', ''],
  model_filter: ['model', 'icontains'],
  provider_filter: ['provider_id', ''],
  customer_filter: ['customer_identifier', 'icontains'],
  log_type_filter: ['log_type', ''],
  environment_filter: ['environment', ''],
};

/** '7d' / '24h' / '60m' -> ISO start and end. Defaults to 7 days. */
function resolveTimeRange(timeRange: string | undefined): [string, string] {
  const end = new Date();
  const match = /^(\d+)\s*(d|h|m)$/.exec((timeRange ?? '7d').trim().toLowerCase());
  let ms: number;
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    ms = unit === 'd' ? amount * 86400000 : unit === 'h' ? amount * 3600000 : amount * 60000;
  } else {
    const days = Number((timeRange ?? '').replace(/days?/i, '').trim());
    if (!Number.isFinite(days)) {
      throw new Error(
        `Invalid time_range '${timeRange}'. Use formats like '7d' (7 days), '30d', '24h' (24 hours), or '60m' (60 minutes).`,
      );
    }
    ms = days * 86400000;
  }
  return [new Date(end.getTime() - ms).toISOString(), end.toISOString()];
}

export function registerTelemetryTools(server: McpServer, client: AuthenticatedClient | null) {
  registerManifestTool(server, client, 'thread_list', async (c, args) => {
    const q = queryFrom(args, ['start_time', 'end_time', 'environment', 'sort_by']);
    const paging = clampPagination('thread_list', args);
    q.set('page', String(paging.page));
    q.set('page_size', String(paging.page_size));
    return rawFetch(c, `/clickhouse/threads/list/?${q.toString()}`, {
      method: 'POST',
      body: { filters: args.filters ?? {} },
    });
  });

  registerManifestTool(server, client, 'thread_summary', async (c, args) => {
    const q = queryFrom(args, ['start_time', 'end_time', 'environment']);
    return rawFetch(c, `/clickhouse/threads/summary/?${q.toString()}`, {
      method: 'POST',
      body: { filters: args.filters ?? {} },
    });
  });

  registerManifestTool(server, client, 'trace_summary', async (c, args) => {
    const q = queryFrom(args, ['start_time', 'end_time', 'environment']);
    return rawFetch(c, `/clickhouse/traces/summary/?${q.toString()}`, {
      method: 'POST',
      body: { filters: args.filters ?? {} },
    });
  });

  registerManifestTool(server, client, 'log_count', async (c, args) => {
    let startTime = args.start_time;
    let endTime = args.end_time;
    if (!startTime || !endTime) {
      [startTime, endTime] = resolveTimeRange(args.time_range);
    }
    const filters: Record<string, { operator: string; value: unknown }> = {};
    for (const [arg, [field, operator]] of Object.entries(LOG_COUNT_SHORTHANDS)) {
      if (args[arg] !== undefined && args[arg] !== null) {
        filters[field] = { operator, value: args[arg] };
      }
    }
    const q = new URLSearchParams({ start_time: startTime, end_time: endTime });
    const summary = (await rawFetch(c, `/clickhouse/dashboard/llm-metrics/summary/?${q.toString()}`, {
      method: 'POST',
      body: { filters },
    })) as Record<string, any> | null;
    // The endpoint answers with the full metric rollup; this tool promises a count.
    const rollup = summary?.summary ?? summary ?? {};
    return { total: rollup.number_of_requests ?? 0 };
  });

  // include_siblings is dropped from the schema: it asks for aggregation across
  // sibling organizations, which this surface cannot do. The backend already
  // answers it with a "not available here" note for customer callers.
  registerManifestTool(server, client, 'log_usage', async (c, args) => {
    const q = queryFrom(args, ['start_time', 'end_time']);
    // Strip any caller-supplied org scoping: this surface is pinned to the
    // token's own organization and must not accept a wider filter.
    const filters: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args.filters ?? {})) {
      if (key === 'unique_organization_id') continue;
      filters[key] = value;
    }
    return rawFetch(c, `/clickhouse/request-logs/summary/?${q.toString()}`, {
      method: 'POST',
      body: { filters },
    });
  }, { omit: ['include_siblings'] });

  registerManifestTool(server, client, 'log_scores_list', async (c, args) => {
    const paging = clampPagination('log_scores_list', args);
    const q = new URLSearchParams({ page: String(paging.page), page_size: String(paging.page_size) });
    return rawFetch(c, `/api/logs/${encodeURIComponent(args.log_id)}/scores/?${q.toString()}`, {
      method: 'GET',
    });
  });
}
