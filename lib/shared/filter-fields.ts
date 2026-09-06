// lib/shared/filter-fields.ts
//
// Client-side guard for the `filters` parameter of list tools.
//
// Every ClickHouse-backed list endpoint in the backend routes each root-level
// filter key to the query stage that owns its column (`columns_to_apply_filters`
// in clickhouse/utils/ch_aggregations.py::_compile_entry_list). A key that
// matches no stage is DROPPED, not rejected: the request returns HTTP 200 with
// the predicate missing, so the caller gets a wider result set and no signal
// that anything was ignored.
//
// This module closes that gap before the request is sent. A tool declares the
// closed set of fields its endpoint actually compiles (derived from the
// backend query builder; see the constants in each tool module) and rejects
// anything outside it with a typed `validation_error` result naming the
// offending keys and the supported set, so an agent can self-correct.
//
// The error shape matches the request-log guard in lib/observe/log-filters.ts
// so agents see one contract across list tools.

export interface FilterFieldSpec {
  /** Tool name, used in the error message. */
  tool: string;
  /** Exact field names the backend compiles for this tool. */
  fields: readonly string[];
  /**
   * Prefixes for dynamic Map-column keys (e.g. `metadata__` on the logs list,
   * whose backend spec has `allow_map_fields=True`). A key that starts with
   * one of these, followed by a non-empty tail, is accepted without a
   * closed-set check. Leave undefined for endpoints built with
   * `allow_map_fields=False` (traces, threads, customers).
   */
  dynamicPrefixes?: readonly string[];
  /**
   * Optional extra guidance appended to the error message, given the
   * unsupported keys (e.g. "metadata is not filterable here, use list_logs").
   */
  hint?: (unsupported: readonly string[]) => string | undefined;
}

export const VALIDATION_ERROR_CODE = "validation_error";

export interface FilterGuardError {
  status: "error";
  error: {
    message: string;
    code: typeof VALIDATION_ERROR_CODE;
    unsupported_fields: string[];
    supported_fields: string[];
  };
}

export function isSupportedFilterField(field: string, spec: FilterFieldSpec): boolean {
  if (spec.fields.includes(field)) return true;
  return (spec.dynamicPrefixes ?? []).some(
    (prefix) => field.startsWith(prefix) && field.length > prefix.length,
  );
}

/** Unsupported keys among `fields`, de-duplicated and sorted. */
export function unsupportedFilterFields(fields: Iterable<string>, spec: FilterFieldSpec): string[] {
  const unsupported = new Set<string>();
  for (const field of fields) {
    if (!isSupportedFilterField(field, spec)) unsupported.add(field);
  }
  return [...unsupported].sort();
}

/**
 * Typed rejection for unsupported filter keys, or null when all are valid.
 *
 * Names the offending keys and the supported set. Sending the request instead
 * would return a wider result with HTTP 200 and no error.
 */
export function filterGuardError(fields: Iterable<string>, spec: FilterFieldSpec): FilterGuardError | null {
  const unsupported = unsupportedFilterFields(fields, spec);
  if (unsupported.length === 0) return null;

  const supported = [...spec.fields].sort();
  const parts = [
    `${spec.tool} has no filter dimension for: ${unsupported.join(", ")}. `
      + "The backend would silently ignore those keys and return a wider, unfiltered "
      + "result set, so the call is rejected instead.",
  ];
  const hint = spec.hint?.(unsupported);
  if (hint) parts.push(hint);
  let supportedLine = `Supported filter fields: ${supported.join(", ")}.`;
  if (spec.dynamicPrefixes && spec.dynamicPrefixes.length > 0) {
    supportedLine += ` Also ${spec.dynamicPrefixes.map((p) => `${p}<key>`).join(", ")}.`;
  }
  parts.push(supportedLine);
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
export function guardErrorResult(error: FilterGuardError) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(error, null, 2) }],
  };
}

/**
 * Converts the tool-facing `filters` array into the backend body shape
 * `{ field: { operator, value } }`. Run `filterGuardError` first.
 */
export function toBackendFilters(
  filters: ReadonlyArray<{ field: string; operator?: string; value: unknown[] }> | undefined,
): Record<string, { operator: string; value: unknown[] }> | undefined {
  if (!filters || filters.length === 0) return undefined;
  const body: Record<string, { operator: string; value: unknown[] }> = {};
  for (const f of filters) {
    body[f.field] = { value: f.value, operator: f.operator || "" };
  }
  return body;
}
