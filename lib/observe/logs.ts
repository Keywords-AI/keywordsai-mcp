// lib/observe/logs.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient } from "../shared/client.js";
import {
  FULL_TEXT_FILTER_SUFFIX,
  METADATA_FILTER_PREFIX,
  SCORES_FILTER_PREFIX,
  guardErrorResult,
  logFilterGuardError,
  supportedLogFilterFields,
} from "./log-filters.js";

const LIST_FILTER_FIELDS_TEXT = supportedLogFilterFields("list_logs").join(", ");
const SUMMARY_FILTER_FIELDS_TEXT = supportedLogFilterFields("get_spans_summary").join(", ");

export function registerLogTools(server: McpServer, client: AuthenticatedClient | null) {
  // --- List Logs ---
  server.tool(
    "list_logs",
    `List and filter LLM request logs. Supports pagination, sorting, time range, and server-side filtering.

IMPORTANT: Use the "filters" parameter to filter results server-side. Do NOT fetch all logs and filter client-side.

PARAMETERS:
- page_size: Number of logs per page (1-50, default 20)
- page: Page number (default 1)
- sort_by: Sort field with optional - prefix for descending (default "-timestamp", newest first). NOTE: "id" / "-id" orders by the hex unique_id, which is NOT chronological; use "-timestamp" for most-recent-first.
- start_time / end_time: ISO 8601 time range (default: last 1 hour). start_time is clamped to at most 7 days ago; when clamped the response carries a "start_time_clamped" note with the requested and effective values.
- is_test: Filter by test (true) or production (false) environment
- all_envs: Include all environments
- include_fields: Array of field names to return (defaults to summary fields). Use get_log_detail for full data.
- filters: Array of server-side filter objects. Each filter has: field (string), operator (string), value (array). See below.

FILTERS - supported operators:
"" (exact match), "not", "lt", "lte", "gt", "gte", "icontains", "startswith", "endswith", "in", "isnull"

FILTERS - supported fields (closed set; any other root key is REJECTED with a validation_error because the backend would silently drop it and return the full unfiltered result):
${LIST_FILTER_FIELDS_TEXT}
Custom metadata: ${METADATA_FILTER_PREFIX}<key>. Per-evaluator scores: ${SCORES_FILTER_PREFIX}<evaluator_id>. Full-text search over log text: system_text_vector (input) and completion_text_vector (output) with operator "".

ERROR FILTERING: there is no error_message / failed field. Use status ("success" | "failed"), status_code (int), error_class, or error_fingerprint.
API KEY FILTERING: use organization_key_id (there is no organization_key_name field).

EXAMPLE - find all failed logs, newest first:
{
  "filters": [{"field": "status", "operator": "", "value": ["failed"]}],
  "sort_by": "-timestamp",
  "page_size": 20
}

EXAMPLE - find logs for a specific model and customer:
{
  "filters": [
    {"field": "model", "operator": "", "value": ["gpt-4"]},
    {"field": "customer_identifier", "operator": "icontains", "value": ["user"]},
    {"field": "cost", "operator": "gt", "value": [0.01]}
  ]
}`,
    {
      page_size: z.number().optional().describe("Number of logs per page (1-50, default 20)"),
      page: z.number().optional().describe("Page number (default 1)"),
      sort_by: z.string().optional().describe("Sort field. Prefix with - for descending order. Default: -timestamp (newest first). Options: timestamp, start_time, cost, latency, time_to_first_token, tokens_per_second, routing_time, prompt_tokens, completion_tokens, total_request_tokens, status_code, status, model, customer_identifier, id. WARNING: id orders by the hex unique_id, not by time. Also supports scores__<evaluator_id> and metadata__<key>."),
      start_time: z.string().optional().describe("Start time in ISO 8601 format. Default: 1 hour ago. Clamped to at most 7 days ago; a clamp is reported in the response's start_time_clamped field."),
      end_time: z.string().optional().describe("End time in ISO 8601 format. Default: current time"),
      is_test: z.boolean().optional().describe("Filter by test environment (true) or production (false)"),
      all_envs: z.boolean().optional().describe("Include logs from all environments"),
      filters: z.array(z.object({
        field: z.string().describe(`Field to filter on (closed set, unknown keys are rejected): ${LIST_FILTER_FIELDS_TEXT}. Custom metadata: ${METADATA_FILTER_PREFIX}<key>. Scores: ${SCORES_FILTER_PREFIX}<evaluator_id>. Full text: <column>${FULL_TEXT_FILTER_SUFFIX}. For errors use status / status_code / error_class / error_fingerprint; for API keys use organization_key_id.`),
        operator: z.enum(["", "not", "lt", "lte", "gt", "gte", "icontains", "iexact", "contains", "startswith", "endswith", "in", "isnull"]).describe("Filter operator. '' = exact match, 'not' = not equal, 'lt'/'lte' = less than, 'gt'/'gte' = greater than, 'icontains' = case-insensitive contains, 'in' = value in list, 'isnull' = check null"),
        value: z.array(z.any()).describe("Filter value(s) as array, e.g. [200], ['gpt-4'], [true]")
      })).optional().describe("Array of server-side filters. Each filter has field, operator, and value. Example: [{\"field\": \"status\", \"operator\": \"\", \"value\": [\"failed\"]}]"),
      include_fields: z.array(z.string()).optional().describe("Fields to include in response. Defaults to summary fields (unique_id, model, cost, status_code, latency, timestamp, customer_identifier, prompt_tokens, completion_tokens, status, error_message, log_type). Use get_log_detail for full log data.")
    },
    async ({ page_size = 20, page = 1, sort_by = "-timestamp", start_time, end_time, is_test, all_envs, filters, include_fields }) => {
      const c = requireClient(client);
      const limit = Math.min(page_size, 50);

      // Reject unsupported filter keys before sending: the backend drops them
      // silently and returns the full unfiltered page with HTTP 200.
      const guardError = logFilterGuardError((filters ?? []).map((f) => f.field), "list_logs");
      if (guardError) return guardErrorResult(guardError);

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const resolvedStart = start_time || oneHourAgo;
      const wasClamped = new Date(resolvedStart) < oneWeekAgo;
      const clampedStart = wasClamped ? oneWeekAgo.toISOString() : resolvedStart;

      // Default summary fields to keep responses lightweight; use get_log_detail for full data
      const DEFAULT_FIELDS = [
        "unique_id", "model", "cost", "status_code", "latency", "timestamp",
        "customer_identifier", "prompt_tokens", "completion_tokens", "status",
        "error_message", "log_type", "time_to_first_token", "tokens_per_second"
      ];
      const fieldsStr = (include_fields || DEFAULT_FIELDS).join(",");

      // Convert filters array to the backend body format: { field: { operator, value } }
      const bodyFilters: Record<string, any> = {};
      if (filters) {
        for (const f of filters) {
          bodyFilters[f.field] = {
            value: f.value,
            operator: f.operator || "",
          };
        }
      }

      const result = await c.client.spans.listSpans({
        Authorization: c.auth,
        operator: "AND",
        start_time: clampedStart,
        end_time: end_time || new Date().toISOString(),
        sort_by,
        page_size: limit,
        page,
        is_test: is_test !== undefined ? String(is_test) as any : undefined,
        all_envs: all_envs !== undefined ? String(all_envs) as any : undefined,
        fetch_filters: "false" as any,
        include_fields: fieldsStr,
        filters: Object.keys(bodyFilters).length > 0 ? bodyFilters : undefined,
      });

      // Extract just the data payload, excluding rawResponse HTTP internals
      let data = (result as any).response ?? (result as any).data ?? result;
      // Strip filters_data metadata to reduce response size
      if (data && typeof data === 'object') delete (data as any).filters_data;
      if (wasClamped) {
        // Make the silent clamp visible so the agent does not believe it queried the older window.
        const note = {
          requested_start_time: resolvedStart,
          effective_start_time: clampedStart,
          message: `start_time was clamped to the maximum lookback of 7 days. Logs older than ${clampedStart} are not included in this result.`,
        };
        data = data && typeof data === 'object' && !Array.isArray(data)
          ? { ...data, start_time_clamped: note }
          : { start_time_clamped: note, data };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- Get Single Log ---
  server.tool(
    "get_log_detail",
    `Retrieve complete details of a single log via GET /api/request-logs/{id}/.

Returns full information including:
- Full input/output content (input and output fields)
- Type-specific fields based on log_type (chat, embedding, workflow, etc.)
- Credit and budget check results (limit_info)
- Evaluation scores
- Complete request/response metadata
- Tool calls and function calling details

The limit_info field shows:
- is_allowed: Whether the request was allowed
- limits: Array of limit checks (org_credits, customer_budget)
  - current_value: Balance before request
  - new_value: Balance after request
  - limit_value: Minimum required balance
  - is_within_limit: Whether check passed

Use list_logs first to find the unique_id, then use this endpoint for full details.`,
    {
      log_id: z.string().describe("Unique identifier of the log (unique_id field from list_logs)")
    },
    async ({ log_id }) => {
      const c = requireClient(client);
      const data = await c.client.spans.retrieveSpan({ Authorization: c.auth, unique_id: log_id });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- Get Spans Summary ---
  server.tool(
    "get_spans_summary",
    `Retrieve aggregated summary statistics for log spans. Returns total_count, total_cost, total_tokens, avg_latency etc.

Useful for getting quick insights into your LLM usage without fetching all individual spans.

PARAMETERS:
- start_time: Start time in ISO 8601 format (required)
- end_time: End time in ISO 8601 format (required)
- filters: Optional object of server-side filters in backend format: { field_name: { operator, value } }

FILTERS - supported fields (closed set; any other root key is REJECTED with a validation_error because the backend would silently drop it and aggregate the whole time window):
${SUMMARY_FILTER_FIELDS_TEXT}
Custom metadata: ${METADATA_FILTER_PREFIX}<key>. Score and annotation filters (scores, positive_feedback, note, ${SCORES_FILTER_PREFIX}<evaluator_id>) are NOT available here because this endpoint aggregates before the score JOINs; use list_logs for those or read the per-evaluator aggregates in the "scores" response field.
For errors use status ("success" | "failed"), status_code, error_class or error_fingerprint. For API keys use organization_key_id.

RESPONSE FIELDS:
- total_cost: Total cost in USD for all filtered spans
- total_tokens: Total tokens (prompt + completion)
- number_of_requests: Total number of requests matching filters
- scores: Aggregated score summaries grouped by evaluator_id

EXAMPLE:
{
  "start_time": "2025-01-01T00:00:00Z",
  "end_time": "2025-01-31T23:59:59Z",
  "filters": {
    "model": { "operator": "", "value": ["gpt-4o"] }
  }
}`,
    {
      start_time: z.string().describe("Start time in ISO 8601 format"),
      end_time: z.string().describe("End time in ISO 8601 format"),
      filters: z.record(z.string().describe(`Filter field (closed set, unknown keys are rejected): ${SUMMARY_FILTER_FIELDS_TEXT}. Custom metadata: ${METADATA_FILTER_PREFIX}<key>. Score filters are not supported here.`), z.object({
        operator: z.string().describe("Filter operator: '' (exact match), 'not', 'lt', 'lte', 'gt', 'gte', 'icontains', 'in', 'isnull'"),
        value: z.array(z.any()).describe("Filter value(s) as array")
      })).optional().describe("Server-side filters in backend format. Example: { \"model\": { \"operator\": \"\", \"value\": [\"gpt-4o\"] } }")
    },
    async ({ start_time, end_time, filters }) => {
      const c = requireClient(client);
      const guardError = logFilterGuardError(Object.keys(filters ?? {}), "get_spans_summary");
      if (guardError) return guardErrorResult(guardError);
      const data = await c.client.spans.getSpansSummary({
        Authorization: c.auth,
        start_time,
        end_time,
        ...(filters ? { filters } : {}),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
