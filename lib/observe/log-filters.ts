// lib/observe/log-filters.ts
//
// Client-side guard for the request-log filter surface.
//
// The backend list/summary endpoints route each root-level filter key to the
// query stage that owns its column. A key that matches no stage is DROPPED,
// not rejected: the request returns HTTP 200 with the full, unfiltered page.
// An agent filtering on a made-up key therefore sees identical results on
// every call and reports them as if they were scoped. This module mirrors the
// backend's `_log_filter_guard_error` (admin/mcp_server/log_tools.py in
// respanai/respan-backend) so the MCP rejects such keys before sending the
// request. The field sets below must be kept in sync with that file.

/** Columns owned by the base CTE stage. */
const LOG_FILTER_CTE_FIELDS = [
  "unique_id",
  "unique_organization_id",
  "organization_key_id",
  "environment",
  "customer_identifier",
  "custom_identifier",
  "thread_identifier",
  "model",
  "deployment_name",
  "provider_id",
  "status_code",
  "status",
  "timestamp",
  "start_time",
  "log_type",
  "log_method",
  "trace_unique_id",
  "span_name",
  "span_workflow_name",
  "span_parent_id",
  "prompt_id",
  "prompt_name",
  "prompt_version_number",
  "used_custom_credential",
  "error_class",
  "error_fingerprint",
  "metadata",
  "full_text",
] as const;

/** Numeric metric columns (support lt/lte/gt/gte). */
const LOG_FILTER_METRIC_FIELDS = [
  "cost",
  "latency",
  "time_to_first_token",
  "tokens_per_second",
  "routing_time",
  "prompt_tokens",
  "completion_tokens",
  "total_request_tokens",
  "prompt_cache_hit_tokens",
  "prompt_cache_creation_tokens",
] as const;

/** Available only after the score / annotation JOINs (list only, not summary). */
const LOG_FILTER_JOINED_FIELDS = ["scores", "positive_feedback", "note"] as const;

/** Virtual keys the backend expands into real predicates. */
const LOG_FILTER_VIRTUAL_FIELDS = ["is_root_span", "behaviors", "fault_domain"] as const;

export const METADATA_FILTER_PREFIX = "metadata__";
export const SCORES_FILTER_PREFIX = "scores__";
/** `<column>_vector` keys are full-text search over the log's text columns. */
export const FULL_TEXT_FILTER_SUFFIX = "_vector";

const MAP_FILTER_PREFIXES = [METADATA_FILTER_PREFIX, SCORES_FILTER_PREFIX] as const;

const ALL_LOG_FILTER_FIELDS: ReadonlySet<string> = new Set<string>([
  ...LOG_FILTER_CTE_FIELDS,
  ...LOG_FILTER_METRIC_FIELDS,
  ...LOG_FILTER_JOINED_FIELDS,
  ...LOG_FILTER_VIRTUAL_FIELDS,
]);

/**
 * The summary endpoint aggregates before the score / annotation JOINs, so a
 * filter on any of these is dropped there even though list supports it.
 */
const SUMMARY_EXCLUDED_FIELDS: ReadonlySet<string> = new Set<string>(LOG_FILTER_JOINED_FIELDS);
const SUMMARY_EXCLUDED_PREFIXES = [SCORES_FILTER_PREFIX] as const;

export type LogFilterTool = "list_logs" | "get_spans_summary";

function isSummaryExcluded(field: string): boolean {
  return SUMMARY_EXCLUDED_FIELDS.has(field)
    || SUMMARY_EXCLUDED_PREFIXES.some((p) => field.startsWith(p));
}

/** The closed set of root-level filter keys `tool` actually compiles, sorted. */
export function supportedLogFilterFields(tool: LogFilterTool): string[] {
  const fields = [...ALL_LOG_FILTER_FIELDS].filter(
    (f) => tool !== "get_spans_summary" || !SUMMARY_EXCLUDED_FIELDS.has(f),
  );
  return fields.sort();
}

/** Whether `tool`'s query stages compile a root-level filter on `field`. */
export function isSupportedLogFilterField(field: string, tool: LogFilterTool): boolean {
  if (tool === "get_spans_summary" && isSummaryExcluded(field)) return false;
  if (ALL_LOG_FILTER_FIELDS.has(field)) return true;
  if (field.endsWith(FULL_TEXT_FILTER_SUFFIX)) return true;
  return MAP_FILTER_PREFIXES.some((p) => field.startsWith(p));
}

/** Unsupported keys among `fields`, de-duplicated and sorted. */
export function unsupportedLogFilterFields(fields: Iterable<string>, tool: LogFilterTool): string[] {
  const unsupported = new Set<string>();
  for (const field of fields) {
    if (!isSupportedLogFilterField(field, tool)) unsupported.add(field);
  }
  return [...unsupported].sort();
}

export const VALIDATION_ERROR_CODE = "validation_error";

export interface LogFilterGuardError {
  status: "error";
  error: { message: string; code: typeof VALIDATION_ERROR_CODE; unsupported_fields: string[]; supported_fields: string[] };
}

/**
 * Typed rejection for unsupported filter keys, or null when all are valid.
 *
 * Names the offending keys and the supported set. Sending the request instead
 * would return a wider, unfiltered result with HTTP 200 and no error.
 */
export function logFilterGuardError(
  fields: Iterable<string>,
  tool: LogFilterTool,
): LogFilterGuardError | null {
  const unsupported = unsupportedLogFilterFields(fields, tool);
  if (unsupported.length === 0) return null;

  const supported = supportedLogFilterFields(tool);
  const parts = [
    `${tool} has no filter dimension for: ${unsupported.join(", ")}. `
      + "The backend would silently ignore those keys and return the full unfiltered "
      + "result set, so the call is rejected instead.",
  ];
  if (unsupported.some(isSummaryExcluded)) {
    parts.push(
      "get_spans_summary aggregates before the score and annotation JOINs, so it has no "
        + "score or annotation filter dimension. Use list_logs with the same filter to "
        + "enumerate the matching logs, or read the per-evaluator aggregates already "
        + "returned in get_spans_summary's 'scores' field.",
    );
  }
  const metadataCandidates = unsupported.filter((f) => !isSummaryExcluded(f));
  if (metadataCandidates.length > 0) {
    parts.push(
      `If it is a custom metadata key, re-call with the '${METADATA_FILTER_PREFIX}' prefix, `
        + `for example '${METADATA_FILTER_PREFIX}${metadataCandidates[0]}'.`,
    );
  }
  parts.push(
    `Supported filter fields: ${supported.join(", ")}. `
      + `Also ${METADATA_FILTER_PREFIX}<key>`
      + (tool === "list_logs" ? `, ${SCORES_FILTER_PREFIX}<evaluator_id>` : "")
      + ` and <column>${FULL_TEXT_FILTER_SUFFIX} full-text keys.`,
  );
  return {
    status: "error",
    error: {
      message: parts.join(" "),
      code: VALIDATION_ERROR_CODE,
      unsupported_fields: unsupported,
      supported_fields: supported,
    },
  };
}

/** Render a guard error as an MCP tool result flagged with isError. */
export function guardErrorResult(error: LogFilterGuardError) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(error, null, 2) }],
  };
}
