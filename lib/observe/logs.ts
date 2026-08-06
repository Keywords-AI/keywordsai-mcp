// lib/observe/logs.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient } from "../shared/client.js";

export function registerLogTools(server: McpServer, client: AuthenticatedClient | null) {
  // --- log_list ---
  server.tool(
    "log_list",
    `List individual log entries (PAGINATED, max 10/page). Use for: browsing specific log entries, finding logs by filter criteria, or getting unique_id values for log_get follow-up. For counting or aggregate stats (total requests, total cost, 'how many logs with latency > 5s'), use log_summary instead. RETURNS per entry (default projection): unique_id, model, status, cost, latency, prompt_tokens, completion_tokens, tokens_per_second, time_to_first_token, timestamp, customer_identifier, prompt_name, storage_object_key, status_code. Other fields (environment, prompt_id, trace_unique_id, span_name, span_workflow_name, log_type, metadata, scores) are NOT returned by default — request them via include_fields. Message text (system, prompt, completion) is not in the default projection — use log_get with unique_id for full prompt_messages and completion_message. Filter Format: {"field": {"operator": "<op>", "value": <val>}}. Operators: '' (exact), 'in', 'not', 'icontains', 'startswith', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'. IMPORTANT field name mapping — the UI uses display names that differ from actual field names: 'Generation' or 'latency(generation)' → use field name 'latency', 'Speed' → 'tokens_per_second', 'TTFT' → 'time_to_first_token'. Always use the actual field names in filters, never the UI display names. String fields: model, status, customer_identifier, provider_id, prompt_id, prompt_name, log_type, deployment_name, span_name, span_workflow_name. Numeric fields (support gte/lte/gt/lt): latency (seconds — also called 'Generation' in the UI), cost (USD), time_to_first_token (seconds — 'TTFT' in the UI), tokens_per_second ('Speed' in the UI), prompt_tokens (int), completion_tokens (int), total_request_tokens (int), status_code (int). Custom metadata fields: Users can attach arbitrary key-value metadata to logs. To filter by a metadata key, use the 'metadata__' prefix (double underscore). If a field name is NOT in the built-in string/numeric fields above, it is a custom metadata key — always prefix with 'metadata__'. Example: {"metadata__agent_name": {"operator": "", "value": "router"}} filters logs where metadata.agent_name equals 'router'. Supported operators for metadata: '' (exact), 'IN', 'NOT IN', '!='.`,
    {
      start_time: z.string().describe(`Start time (ISO 8601). Required.`),
      end_time: z.string().describe(`End time (ISO 8601). Required.`),
      environment: z.enum(["prod", "test"]).optional().describe(`Environment filter`),
      model: z.string().optional().describe(`Filter by model name (contains)`),
      status: z.enum(["success", "failed"]).optional().describe(`Filter by status`),
      customer_identifier: z.string().optional().describe(`Filter by customer identifier`),
      prompt_id: z.string().optional().describe(`Filter by prompt ID (exact match)`),
      used_custom_credential: z.boolean().optional().describe(`Filter by credential type: true=customer credentials, false=managed credentials`),
      filters: z.record(z.string(), z.any()).optional().describe(`Generic filters object over request-log columns. Format: {"field": {"operator": "<op>", "value": <val>}}. Operators: '' (exact), 'in', 'not', 'icontains', 'startswith', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'. Supported fields (closed set): behaviors, completion_tokens, cost, custom_identifier, customer_identifier, deployment_name, environment, error_class, error_fingerprint, fault_domain, full_text, is_root_span, latency, log_method, log_type, metadata, model, note, organization_key_id, positive_feedback, prompt_cache_creation_tokens, prompt_cache_hit_tokens, prompt_id, prompt_name, prompt_tokens, prompt_version_number, provider_id, routing_time, scores, span_name, span_parent_id, span_workflow_name, start_time, status, status_code, thread_identifier, time_to_first_token, timestamp, tokens_per_second, total_request_tokens, trace_unique_id, unique_id, unique_organization_id, used_custom_credential. Custom metadata and per-evaluator scores use the 'metadata__' and 'scores__' prefixes with any key. Any other key is REJECTED with a validation_error, because the query layer would drop it and return a wider result. There is no dataset dimension here, use dataset_logs_summary or dataset_logs_list for dataset-scoped questions.`),
      page: z.number().int().optional().describe(`Page number (default: 1)`),
      page_size: z.number().int().optional().describe(`Page size (default: 5, max: 10)`),
      sort_by: z.string().optional().describe(`Sort field (default: -timestamp)`),
      include_fields: z.array(z.string()).optional().describe(`Fields to return per log entry. Default: unique_id, model, status, cost, latency, prompt_tokens, completion_tokens, tokens_per_second, time_to_first_token, timestamp, customer_identifier, prompt_name, storage_object_key, status_code. Override to add fields like environment, trace_unique_id, span_name, metadata, scores. Always include 'unique_id' if you plan to follow up with log_get.`)
    },
    async ({ start_time, end_time, environment, model, status, customer_identifier, prompt_id, used_custom_credential, filters, page = 1, page_size = 5, sort_by = "-timestamp", include_fields }) => {
      const c = requireClient(client);
      const limit = Math.min(page_size, 10);

      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const clampedStart = new Date(start_time) < oneWeekAgo ? oneWeekAgo.toISOString() : start_time;

      // Default summary fields to keep responses lightweight; use log_get for full data
      // Mirrors the projection the description advertises. Kept in sync with it
      // deliberately: the model decides whether it needs a log_get follow-up
      // based on which fields this promises to return.
      const DEFAULT_FIELDS = [
        "unique_id", "model", "status", "cost", "latency", "prompt_tokens",
        "completion_tokens", "tokens_per_second", "time_to_first_token",
        "timestamp", "customer_identifier", "prompt_name", "storage_object_key",
        "status_code"
      ];
      const fieldsStr = (include_fields || DEFAULT_FIELDS).join(",");

      // Convenience params fold into the same { field: { operator, value } } body map as `filters`
      const bodyFilters: Record<string, any> = { ...(filters || {}) };
      if (model) bodyFilters.model = { operator: "icontains", value: model };
      if (status) bodyFilters.status = { operator: "", value: status };
      if (customer_identifier) bodyFilters.customer_identifier = { operator: "", value: customer_identifier };
      if (prompt_id) bodyFilters.prompt_id = { operator: "", value: prompt_id };
      if (used_custom_credential !== undefined) bodyFilters.used_custom_credential = { operator: "", value: used_custom_credential };

      const result = await c.client.spans.listSpans({
        Authorization: c.auth,
        operator: "AND",
        start_time: clampedStart,
        end_time,
        sort_by,
        page_size: limit,
        page,
        ...(environment ? { environment } : {}),
        fetch_filters: "false" as any,
        include_fields: fieldsStr,
        filters: Object.keys(bodyFilters).length > 0 ? bodyFilters : undefined,
      });

      // Extract just the data payload, excluding rawResponse HTTP internals
      const data = (result as any).response ?? (result as any).data ?? result;
      // Strip filters_data metadata to reduce response size
      if (data && typeof data === 'object') delete (data as any).filters_data;
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- log_get ---
  server.tool(
    "log_get",
    `Get a single log by unique_id. Returns the FULL untruncated log — use this after log_list to see complete content. RETURNS: prompt_messages (full conversation), completion_message (full response), full_request, full_response, model, cost, latency, tokens_per_second, time_to_first_token, prompt_tokens, completion_tokens, temperature, max_tokens, top_p, frequency_penalty, presence_penalty, tool_calls, tools, metadata, scores (per-evaluator), annotation_status, customer_identifier, error_message, status, environment.`,
    {
      unique_id: z.string().describe(`Log unique ID`)
    },
    async ({ unique_id }) => {
      const c = requireClient(client);
      const data = await c.client.spans.retrieveSpan({ Authorization: c.auth, unique_id });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- log_summary ---
  server.tool(
    "log_summary",
    `Get aggregate log statistics (server-side, NO pagination). Use instead of log_list when you need counts, totals, or averages — not individual entries. RETURNS: number_of_requests, total_cost (USD), total_tokens, total_prompt_tokens, total_completion_tokens, avg_latency (seconds), avg_tps, avg_ttft (seconds), plus per-evaluator score aggregates in 'scores' (keyed by evaluator_id, each with evaluator_name, evaluator_slug, avg_score, true_count, false_count, score_value_type). Supports numeric field filters (latency, cost, tokens, etc.) via the same filter format as log_list. Use for: 'how many total requests', 'total cost this week', 'how many logs with latency > 5s' (read number_of_requests from response), 'average score for evaluator X', 'summarize my usage'. NOTE: By default, excludes logs without an API key (e.g. some OTLP-ingested spans) to match the dashboard Requests metric. To include all logs, pass filters: {"organization_key_id": {"operator": "", "value": ""}} to override. SCOPE LIMIT: there is NO dataset dimension. This tool counts request logs org-wide within the time range. For a count of logs inside a dataset, use dataset_logs_summary and read 'number_of_requests'. There is also NO score or annotation filter dimension (this aggregates before the score JOINs) — use log_list to filter by note/positive_feedback/scores. An unsupported filter key is rejected with a validation_error rather than ignored.`,
    {
      start_time: z.string().describe(`Start time (ISO 8601)`),
      end_time: z.string().describe(`End time (ISO 8601)`),
      environment: z.enum(["prod", "test"]).optional().describe(`Environment filter`),
      model: z.string().optional().describe(`Filter by model name (contains match)`),
      status: z.enum(["success", "failed"]).optional().describe(`Filter by status`),
      customer_identifier: z.string().optional().describe(`Filter by customer identifier`),
      used_custom_credential: z.boolean().optional().describe(`Filter by credential type: true=customer credentials, false=Keywords AI managed credentials`),
      include_scores: z.boolean().optional().describe(`Include evaluation scores in response (default: true)`),
      filters: z.record(z.string(), z.any()).optional().describe(`Generic filters object over request-log columns. Format: {"field": {"operator": "<op>", "value": <val>}}. Operators: '' (exact), 'in', 'not', 'icontains', 'startswith', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'. Supported fields (closed set): behaviors, completion_tokens, cost, custom_identifier, customer_identifier, deployment_name, environment, error_class, error_fingerprint, fault_domain, full_text, is_root_span, latency, log_method, log_type, metadata, model, organization_key_id, prompt_cache_creation_tokens, prompt_cache_hit_tokens, prompt_id, prompt_name, prompt_tokens, prompt_version_number, provider_id, routing_time, span_name, span_parent_id, span_workflow_name, start_time, status, status_code, thread_identifier, time_to_first_token, timestamp, tokens_per_second, total_request_tokens, trace_unique_id, unique_id, unique_organization_id, used_custom_credential. Custom metadata uses the 'metadata__' prefix with any key. Score and annotation filters (note, positive_feedback, scores, scores__<evaluator_id>) are NOT available here — this endpoint aggregates before the score JOINs. Use log_list for those, or read the per-evaluator aggregates in the 'scores' response field. Any other key is REJECTED with a validation_error, because the query layer would drop it and return a wider result. There is no dataset dimension here, use dataset_logs_summary or dataset_logs_list for dataset-scoped questions.`)
    },
    async ({ start_time, end_time, environment, model, status, customer_identifier, used_custom_credential, include_scores, filters }) => {
      const c = requireClient(client);

      // Convenience params fold into the same { field: { operator, value } } body map as `filters`
      const bodyFilters: Record<string, any> = { ...(filters || {}) };
      // Exclude logs with no API key (some OTLP-ingested spans) so counts match
      // the dashboard Requests metric, which is what people compare against.
      // The description documents the override; a caller-supplied
      // organization_key_id filter wins because `filters` is spread first.
      if (!("organization_key_id" in bodyFilters)) {
        bodyFilters.organization_key_id = { operator: "not_empty", value: "" };
      }
      if (model) bodyFilters.model = { operator: "icontains", value: model };
      if (status) bodyFilters.status = { operator: "", value: status };
      if (customer_identifier) bodyFilters.customer_identifier = { operator: "", value: customer_identifier };
      if (used_custom_credential !== undefined) bodyFilters.used_custom_credential = { operator: "", value: used_custom_credential };

      const data = await c.client.spans.getSpansSummary({
        Authorization: c.auth,
        start_time,
        end_time,
        ...(environment ? { environment } : {}),
        ...(Object.keys(bodyFilters).length > 0 ? { filters: bodyFilters } : {}),
      });

      // include_scores is a response-shaping flag, not a query param
      const payload = data as any;
      if (include_scores === false && payload && typeof payload === 'object') delete payload.scores;
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    }
  );
}
