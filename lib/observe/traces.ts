// lib/observe/traces.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient } from "../shared/client.js";

export function registerTraceTools(server: McpServer, client: AuthenticatedClient | null) {
  // --- trace_list ---
  server.tool(
    "trace_list",
    `List individual trace entries (PAGINATED, default 5/page, max 10). Use for: browsing traces, finding traces by filter criteria, or getting trace_unique_id values for trace_get follow-up. RETURNS per entry: trace_unique_id, name, duration (seconds), span_count, llm_call_count, total_cost (USD), total_tokens, total_prompt_tokens, total_completion_tokens, error_count, model, customer_identifier, environment, input, output, metadata, start_time, end_time, storage_object_key, trace_group_identifier. Does NOT include the span tree — use trace_get with trace_unique_id to see all child spans and their full content. Filter Format: {"field": {"operator": "<op>", "value": <val>}}. Operators: '' (exact), 'in', 'not', 'icontains', 'startswith', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'. String fields: trace_unique_id, name (workflow name), customer_identifier, span_unique_id. Numeric fields (support gte/lte): span_count, error_count, total_prompt_tokens, total_completion_tokens, total_request_tokens, duration (seconds).`,
    {
      start_time: z.string().optional().describe(`Start time (ISO 8601)`),
      end_time: z.string().optional().describe(`End time (ISO 8601)`),
      environment: z.enum(["prod", "test"]).optional().describe(`Environment filter`),
      filters: z.record(z.string(), z.any()).optional().describe(`Additional filters. Format: {"field": {"operator": "<op>", "value": <val>}}. Operators: '' (exact), 'in', 'not', 'icontains', 'startswith', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'. Examples: {"span_count": {"operator": "gte", "value": 5}}, {"duration": {"operator": "gte", "value": 10.0}}, {"error_count": {"operator": "gte", "value": 1}}, {"name": {"operator": "", "value": "my-workflow"}}`),
      sort_by: z.string().optional().describe(`Sort field (default: -timestamp). Prefix with - for descending.`),
      page: z.number().int().optional().describe(`Page number (default: 1)`),
      page_size: z.number().int().optional().describe(`Page size (default: 5, max: 10)`)
    },
    async ({ page_size = 5, page = 1, sort_by = "-timestamp", start_time, end_time, environment, filters }) => {
      const c = requireClient(client);
      const limit = Math.min(page_size, 10);

      const bodyFilters: Record<string, any> = { ...(filters || {}) };

      const result = await c.client.traces.listTraces({
        Authorization: c.auth,
        page_size: limit,
        page,
        sort_by,
        ...(start_time ? { start_time } : {}),
        ...(end_time ? { end_time } : {}),
        ...(environment ? { environment } : {}),
        ...(Object.keys(bodyFilters).length > 0 ? { filters: bodyFilters } : {}),
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- trace_get ---
  server.tool(
    "trace_get",
    `Get a single trace by trace_unique_id. Returns the full trace with a nested span_tree of all child spans. RETURNS: all trace_list fields plus span_tree — a recursive tree where each span includes: span_unique_id, span_name, span_parent_id, model, latency, cost, prompt_tokens, completion_tokens, tokens_per_second, time_to_first_token, input, output, status, status_code, metadata, and nested children spans. Use after trace_list to drill into a specific trace's execution flow.`,
    {
      trace_id: z.string().describe(`Trace unique ID`)
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
