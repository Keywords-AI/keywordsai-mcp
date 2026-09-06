// lib/shared/filter-fields.ts
//
// Client-side guard for the `filters` parameter of list tools.
//
// Every ClickHouse-backed list endpoint in the backend routes each filter by
// its field name through a per-stage allowlist (`columns_to_apply_filters` in
// clickhouse/utils/ch_aggregations.py::_compile_entry_list). A field that is
// in no stage's allowlist is skipped, not rejected: the query runs without
// that predicate and answers a WIDER question than the caller asked. An agent
// that filters on a field the backend does not know therefore gets a 200 with
// the wrong rows and no signal that anything was dropped.
//
// This helper closes that gap before the request is sent. Each tool declares
// the closed set of fields the backend actually honours (derived from the
// backend's query builder, see the constants in the tool modules) and the
// tool handler rejects anything outside it with a typed error whose message
// lists the supported fields, so the agent can self-correct.

export interface FilterFieldSpec {
  /** Tool name, used in the error message. */
  tool: string;
  /** Exact field names the backend honours for this tool. */
  fields: readonly string[];
  /**
   * Prefixes for dynamic Map-column fields (e.g. `metadata__` on the logs
   * list, which has `allow_map_fields=True` in the backend). A field that
   * starts with one of these is accepted without a closed-set check.
   * Leave undefined for endpoints whose backend spec has
   * `allow_map_fields=False` (traces, threads, customers).
   */
  dynamicPrefixes?: readonly string[];
}

export class UnsupportedFilterFieldError extends Error {
  readonly code = "unsupported_filter_field" as const;
  readonly tool: string;
  readonly unsupportedFields: readonly string[];
  readonly supportedFields: readonly string[];
  readonly dynamicPrefixes: readonly string[];

  constructor(spec: FilterFieldSpec, unsupportedFields: readonly string[]) {
    super(formatUnsupportedFilterFieldMessage(spec, unsupportedFields));
    this.name = "UnsupportedFilterFieldError";
    this.tool = spec.tool;
    this.unsupportedFields = [...unsupportedFields];
    this.supportedFields = [...spec.fields];
    this.dynamicPrefixes = [...(spec.dynamicPrefixes ?? [])];
  }
}

export function formatUnsupportedFilterFieldMessage(
  spec: FilterFieldSpec,
  unsupportedFields: readonly string[],
): string {
  const parts = [
    `${spec.tool}: unsupported filter field(s): ${unsupportedFields.join(", ")}.`,
    `The backend silently ignores unknown fields, so the request was not sent.`,
    `Supported fields: ${spec.fields.join(", ")}.`,
  ];
  if (spec.dynamicPrefixes && spec.dynamicPrefixes.length > 0) {
    parts.push(
      `Dynamic fields: ${spec.dynamicPrefixes.map((p) => `${p}<key>`).join(", ")}.`,
    );
  }
  return parts.join(" ");
}

export function isSupportedFilterField(field: string, spec: FilterFieldSpec): boolean {
  if (spec.fields.includes(field)) return true;
  return (spec.dynamicPrefixes ?? []).some(
    (prefix) => field.startsWith(prefix) && field.length > prefix.length,
  );
}

/** Returns the distinct unsupported field names, in first-seen order. */
export function unsupportedFilterFields(
  fields: Iterable<string>,
  spec: FilterFieldSpec,
): string[] {
  const unsupported: string[] = [];
  for (const field of fields) {
    if (!isSupportedFilterField(field, spec) && !unsupported.includes(field)) {
      unsupported.push(field);
    }
  }
  return unsupported;
}

/**
 * Throws `UnsupportedFilterFieldError` when any field is outside the spec.
 * Call this before building the request body so an agent gets a typed error
 * listing the supported fields instead of a silently widened result set.
 */
export function assertSupportedFilterFields(
  fields: Iterable<string>,
  spec: FilterFieldSpec,
): void {
  const unsupported = unsupportedFilterFields(fields, spec);
  if (unsupported.length > 0) {
    throw new UnsupportedFilterFieldError(spec, unsupported);
  }
}

/**
 * Converts the tool-facing `filters` array into the backend body shape
 * `{ field: { operator, value } }` after checking every field against `spec`.
 */
export function toBackendFilters(
  filters: ReadonlyArray<{ field: string; operator?: string; value: unknown[] }> | undefined,
  spec: FilterFieldSpec,
): Record<string, { operator: string; value: unknown[] }> | undefined {
  if (!filters || filters.length === 0) return undefined;
  assertSupportedFilterFields(filters.map((f) => f.field), spec);
  const body: Record<string, { operator: string; value: unknown[] }> = {};
  for (const f of filters) {
    body[f.field] = { value: f.value, operator: f.operator || "" };
  }
  return body;
}
