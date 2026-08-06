import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthenticatedClient } from '../shared/client.js';
import { rawFetch } from '../shared/client.js';
import { registerManifestTool, queryFrom } from '../shared/manifestTool.js';

/**
 * Dashboard analytics reads, all backed by /clickhouse/dashboard/*.
 *
 * Every one is POST-for-filtering: the window and dimension ride in the query
 * string, the filter object rides in the body. Four route shapes cover the set,
 * so they are registered from tables rather than one function per tool.
 */

const DASHBOARD_PATH = '/clickhouse/dashboard';

/** Window and scope arguments every dashboard tool shares. */
const COMMON_QUERY_KEYS = ['start_time', 'end_time', 'environment', 'credential_type'];

/**
 * Rank-by-dimension reads. All hit the one breakdown endpoint and differ only
 * by the dimension pinned into breakdown_by, which is never a caller argument —
 * the tool name fixes it, the same way the workflow nouns fix `type`.
 */
const TOP_BREAKDOWN: Record<string, string> = {
  dashboard_top_models: 'model',
  dashboard_top_providers: 'provider_id',
  dashboard_top_prompts: 'prompt_id',
  dashboard_top_deployments: 'deployment_id',
  api_key_rank_by_usage: 'organization_key_id',
  end_user_rank_by_usage: 'customer_identifier',
};

/** Schema documents default 10; send it so the view enforces the documented value. */
const TOP_BREAKDOWN_DEFAULT_LIMIT = 10;

/**
 * POST-for-filtering reads that forward the caller's filters.
 *
 * The `*_over_time` twins of these, and dashboard_metric_chart, are withheld
 * from this surface — see verify-agent-parity.mjs. What remains answers the
 * same questions as a collapsed figure rather than a series to plot.
 */
const SIMPLE_POST: Record<string, string> = {
  dashboard_llm_metrics_summary: 'llm-metrics/summary',
  dashboard_active_users: 'users',
  dashboard_quantiles_summary: 'quantiles/summary',
};

/** POST reads whose endpoint does not support filters — body stays empty. */
const NO_FILTER_POST: Record<string, string> = {
  dashboard_total_users: 'total-users',
  dashboard_eval_results_summary: 'eval-results/summary',
  dashboard_storage_volume_summary: 'storage-volume/summary',
};

/** The eval-results read takes two extra query arguments. */
const EVAL_RESULTS_TOOLS = new Set(['dashboard_eval_results_summary']);

/**
 * Pins the eval reads to pipeline rollups. Unscoped, the read is all-origin, so
 * grader sub-scores come back as siblings of the evaluator scores they roll
 * into and blend into the same averages.
 */
const EVAL_SOURCE_KEY = 'source';
const EVAL_SOURCE_EVALUATOR = 'evaluator';

function windowQuery(name: string, args: Record<string, any>): URLSearchParams {
  const keys = [...COMMON_QUERY_KEYS];
  if (EVAL_RESULTS_TOOLS.has(name)) keys.push('scope', 'time_tick');
  const q = queryFrom(args, keys);
  if (EVAL_RESULTS_TOOLS.has(name)) q.set(EVAL_SOURCE_KEY, EVAL_SOURCE_EVALUATOR);
  return q;
}

export function registerDashboardTools(server: McpServer, client: AuthenticatedClient | null) {
  // --- rank-by-dimension reads ---
  for (const [name, breakdownBy] of Object.entries(TOP_BREAKDOWN)) {
    registerManifestTool(server, client, name, async (c, args) => {
      const q = windowQuery(name, args);
      q.set('breakdown_by', breakdownBy);
      // Full rows per dimension value, matching what the descriptions promise.
      q.set('include_all_metrics', 'true');
      if (args.sort_by) q.set('sort_by', String(args.sort_by));
      q.set('limit', String(args.limit ?? TOP_BREAKDOWN_DEFAULT_LIMIT));
      return rawFetch(c, `${DASHBOARD_PATH}/breakdown/?${q.toString()}`, {
        method: 'POST',
        body: { filters: args.filters ?? {} },
      });
    });
  }

  // --- POST-for-filtering reads ---
  for (const [name, endpoint] of Object.entries(SIMPLE_POST)) {
    registerManifestTool(server, client, name, async (c, args) => {
      const q = windowQuery(name, args);
      return rawFetch(c, `${DASHBOARD_PATH}/${endpoint}/?${q.toString()}`, {
        method: 'POST',
        body: { filters: args.filters ?? {} },
      });
    });
  }

  // --- POST reads with no filter support ---
  for (const [name, endpoint] of Object.entries(NO_FILTER_POST)) {
    registerManifestTool(server, client, name, async (c, args) => {
      const q = windowQuery(name, args);
      return rawFetch(c, `${DASHBOARD_PATH}/${endpoint}/?${q.toString()}`, {
        method: 'POST',
        body: {},
      });
    });
  }

}
