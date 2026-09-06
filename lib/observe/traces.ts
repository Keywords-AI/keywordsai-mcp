// lib/observe/traces.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient } from "../shared/client.js";
import { toBackendFilters, type FilterFieldSpec } from "../shared/filter-fields.js";

// ---------------------------------------------------------------------------
// Closed set of filter fields the traces list endpoint honours.
//
// Derived from respan-backend clickhouse/views/traces.py::TracesQueryBuilder.
// The builder routes each filter by field name into one of three stages and
// silently drops anything that lands in no stage's allowlist
// (clickhouse/utils/ch_aggregations.py::_compile_entry_list), so this list is
// the whole contract. The traces field spec is built with
// `allow_map_fields=False`, so `metadata__<key>` is NOT resolvable here (it is
// on the logs list, which has Map columns).
// ---------------------------------------------------------------------------

/** Trace-level rollups and root-span fields (get_metadata_columns + get_metric_columns). */
export const TRACE_LEVEL_FILTER_FIELDS = [
  "trace_unique_id",
  "start_time",
  "end_time",
  "timestamp",
  "name",
  "customer_identifier",
  "environment",
  "organization_key_id",
  "trace_group_identifier",
  "span_count",
  "llm_call_count",
  "error_count",
  "total_cost",
  "total_prompt_tokens",
  "total_completion_tokens",
  "total_request_tokens",
  "duration",
] as const;

/**
 * Span-level fields (SPAN_LEVEL_FILTER_FIELDS + span_unique_id). These run on
 * the raw per-span table: a trace matches when ANY of its spans matches, and
 * the returned rollups still describe the whole trace.
 */
export const SPAN_LEVEL_FILTER_FIELDS = [
  "span_unique_id",
  "span_parent_id",
  "span_name",
  "span_workflow_name",
  "model",
  "deployment_name",
  "provider_id",
  "status",
  "status_code",
  "error_class",
  "error_fingerprint",
  "log_type",
  "log_method",
  "prompt_id",
  "prompt_name",
  "prompt_version_number",
  "used_custom_credential",
  "cost",
  "latency",
  "time_to_first_token",
  "tokens_per_second",
  "routing_time",
  "prompt_tokens",
  "completion_tokens",
  "prompt_cache_hit_tokens",
  "prompt_cache_creation_tokens",
] as const;

/** Content fields matched on the raw span table (full-text path). */
export const TRACE_CONTENT_FILTER_FIELDS = ["input", "output", "session_identifier"] as const;

export const TRACE_FILTER_FIELDS = [
  ...TRACE_LEVEL_FILTER_FIELDS,
  ...SPAN_LEVEL_FILTER_FIELDS,
  ...TRACE_CONTENT_FILTER_FIELDS,
] as const;

export const TRACE_FILTER_FIELD_SPEC: FilterFieldSpec = {
  tool: "list_traces",
  fields: TRACE_FILTER_FIELDS,
};

/**
 * Operators accepted by the ClickHouse filter compiler for these fields
 * (utils/constants/clickhouse_constants.py::CH_FILTER_OPERATOR_MAP). Note
 * `iexact` is not in the backend vocabulary and returns 400.
 */
export const TRACE_FILTER_OPERATORS = [
  "",
  "not",
  "in",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "icontains",
  "startswith",
  "endswith",
  "isnull",
] as const;

/** Sort fields from TRACE_SORT_FIELD_MAPPING (each also accepts a `-` prefix). */
export const TRACE_SORT_FIELDS = [
  "timestamp",
  "start_time",
  "end_time",
  "duration",
  "total_cost",
  "total_tokens",
  "total_prompt_tokens",
  "total_completion_tokens",
  "span_count",
  "llm_call_count",
  "error_count",
  "name",
  "customer_identifier",
  "environment",
  "trace_unique_id",
  "trace_group_identifier",
] as const;

export const TRACE_SORT_OPTIONS = TRACE_SORT_FIELDS.flatMap((f) => [f, `-${f}`]) as [
  string,
  ...string[],
];

export function describeTraceFilterFields(): string {
  return [
    `Trace-level: ${TRACE_LEVEL_FILTER_FIELDS.join(", ")}.`,
    `Span-level (trace matches if ANY span matches): ${SPAN_LEVEL_FILTER_FIELDS.join(", ")}.`,
    `Content (matched on raw spans): ${TRACE_CONTENT_FILTER_FIELDS.join(", ")}.`,
    `Custom metadata (metadata__<key>) is NOT filterable on traces; use list_logs for that.`,
  ].join(" ");
}

export const LIST_TRACES_DESCRIPTION = `List and filter traces with sorting, pagination, and server-side filtering.

A trace represents a complete workflow execution containing multiple spans (individual operations).

IMPORTANT: Use the "filters" parameter to filter results server-side. Do NOT fetch all traces and filter client-side.

PARAMETERS:
- page_size: Results per page (1-20, default 10)
- page: Page number (default 1)
- sort_by: Sort field with optional - prefix for descending (e.g. "-total_cost", "duration")
- start_time / end_time: ISO 8601 time range (default: last 1 hour)
- environment: Filter by environment (e.g. "production", "test")
- filters: Array of server-side filter objects. Each filter has: field (string), operator (string), value (array). See below.

FILTERS - supported operators:
${TRACE_FILTER_OPERATORS.map((o) => JSON.stringify(o)).join(", ")}
"" = exact match, "not" = not equal, "in" = value in list, "lt"/"lte"/"gt"/"gte" = comparisons, "contains"/"icontains" = (case-insensitive) substring, "startswith"/"endswith", "isnull" = null check

FILTERS - supported fields (closed set; anything else is rejected before the request is sent):
- Trace-level rollups and root-span fields: ${TRACE_LEVEL_FILTER_FIELDS.join(", ")}
- Span-level fields (a trace matches when ANY of its spans matches; rollups still describe the whole trace): ${SPAN_LEVEL_FILTER_FIELDS.join(", ")}
- Content fields (matched on raw spans): ${TRACE_CONTENT_FILTER_FIELDS.join(", ")}
Note: total token count is "total_request_tokens" (not "total_tokens") when filtering. Custom metadata (metadata__<key>) is NOT filterable on traces; use list_logs for metadata filters.

EXAMPLE - find traces with errors:
{
  "filters": [{"field": "error_count", "operator": "gt", "value": [0]}],
  "sort_by": "-total_cost"
}

EXAMPLE - find traces for a specific customer:
{
  "filters": [
    {"field": "customer_identifier", "operator": "", "value": ["user@example.com"]},
    {"field": "total_cost", "operator": "gte", "value": [0.01]}
  ]
}

EXAMPLE - find traces containing any gpt-4o span:
{
  "filters": [{"field": "model", "operator": "icontains", "value": ["gpt-4o"]}]
}

RESPONSE FIELDS:
- trace_unique_id: Unique identifier
- start_time, end_time: Trace time range
- duration: Total duration in seconds
- span_count: Number of spans
- llm_call_count: Number of LLM API calls
- total_prompt_tokens, total_completion_tokens, total_tokens: Token usage
- total_cost: Cost in USD
- error_count: Number of errors
- input, output: Root span's input/output
- metadata: Custom metadata
- customer_identifier: User identifier
- environment: Environment name
- trace_group_identifier: Workflow group
- name: Root span name
- model: Primary model used`;

export const traceFilterSchema = z.object({
  field: z
    .string()
    .describe(`Field to filter on. ${describeTraceFilterFields()}`),
  operator: z
    .enum(TRACE_FILTER_OPERATORS)
    .describe(
      "Filter operator. '' = exact match, 'not' = not equal, 'in' = value in list, 'lt'/'lte' = less than, 'gt'/'gte' = greater than, 'contains'/'icontains' = substring (icontains is case-insensitive), 'startswith'/'endswith', 'isnull' = check null",
    ),
  value: z.array(z.any()).describe("Filter value(s) as array, e.g. [0], ['production'], [true]"),
});

export function registerTraceTools(server: McpServer, client: AuthenticatedClient | null) {
  // --- List Traces ---
  server.tool(
    "list_traces",
    LIST_TRACES_DESCRIPTION,
    {
      page_size: z.number().optional().describe("Results per page (1-20, default 10)"),
      page: z.number().optional().describe("Page number (default 1)"),
      sort_by: z
        .enum(TRACE_SORT_OPTIONS)
        .optional()
        .describe("Sort field. Prefix with - for descending order. Default: -timestamp"),
      start_time: z.string().optional().describe("Start time in ISO 8601 format. Default: 1 hour ago"),
      end_time: z.string().optional().describe("End time in ISO 8601 format. Default: current time"),
      environment: z.string().optional().describe("Filter by environment (e.g., 'production', 'test')"),
      filters: z
        .array(traceFilterSchema)
        .optional()
        .describe(
          `Array of server-side filters. Each filter has field, operator, and value. Example: [{"field": "error_count", "operator": "gt", "value": [0]}]`,
        ),
    },
    async ({ page_size = 10, page = 1, sort_by = "-timestamp", start_time, end_time, environment, filters }) => {
      const c = requireClient(client);
      const limit = Math.min(page_size, 20);

      // Convert filters array to the backend body format: { field: { operator, value } }.
      // Rejects unsupported fields up front: the backend drops them silently.
      const bodyFilters = toBackendFilters(filters, TRACE_FILTER_FIELD_SPEC);

      const result = await c.client.traces.listTraces({
        Authorization: c.auth,
        page_size: limit,
        page,
        sort_by,
        ...(start_time ? { start_time } : {}),
        ...(end_time ? { end_time } : {}),
        ...(environment ? { environment } : {}),
        ...(bodyFilters ? { filters: bodyFilters } : {}),
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- Get Trace Tree ---
  server.tool(
    "get_trace_tree",
    `Retrieve the complete hierarchical span tree of a single trace.

Returns detailed trace information with the full span_tree structure showing:
- All spans in the trace with parent-child relationships
- Full input/output for each span
- Timing and performance metrics per span
- Model and token usage per LLM span
- Nested children spans forming the execution tree

The lookup is by trace_unique_id within your organization only; there are no
additional filter parameters (the backend GET /api/traces/{id}/ ignores
environment and time-range query parameters).

TRACE FIELDS:
- trace_unique_id: Unique identifier
- start_time, end_time: Trace time range
- duration: Total duration in seconds
- span_count: Total number of spans
- llm_call_count: Number of LLM calls
- total_prompt_tokens, total_completion_tokens, total_tokens: Aggregate token usage
- total_cost: Total cost in USD
- error_count: Number of errors
- metadata: Custom metadata object
- customer_identifier: User identifier
- environment: Environment name

SPAN TREE STRUCTURE:
Each span in span_tree contains:
- span_unique_id: Unique span identifier
- span_name: Name of the operation
- span_parent_id: Parent span ID (null for root)
- log_type: Span type (CHAT, COMPLETION, FUNCTION, TASK, WORKFLOW, etc.)
- start_time, timestamp: Span timing
- latency: Duration in seconds
- input: Full span input data
- output: Full span output data
- model: Model used (for LLM spans)
- prompt_tokens, completion_tokens: Token counts
- cost: Cost in USD
- status: Status (success, error)
- status_code: HTTP-like status code
- children: Array of nested child spans

Use list_traces first to find trace_unique_id, then use this for full span tree.`,
    {
      trace_id: z.string().describe("Trace unique ID (trace_unique_id field from list_traces)"),
    },
    async ({ trace_id }) => {
      const c = requireClient(client);
      const result = await c.client.traces.retrieveTrace({
        Authorization: c.auth,
        trace_unique_id: trace_id,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

}
