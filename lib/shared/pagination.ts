import { z } from 'zod';

/**
 * One pagination contract for every list tool, mirroring the backend's.
 *
 * The numbers a model reads in a tool description come from the same table that
 * clamps the outgoing request, so prose cannot drift from behaviour. Hand-written
 * "default: N" text was wrong on most tools here before this table existed, each
 * naming a number the request did not actually send.
 *
 * Two rules hold everywhere:
 *   1. page and page_size are ALWAYS sent. Tools never fall through to a view's
 *      paginator default, because those differ per endpoint and a description can
 *      only honestly state a number the tool actually sends.
 *   2. An over-max page_size is clamped, not rejected. A model asking for 500 rows
 *      gets the max and a usable answer instead of a validation error.
 *
 * Rule 2 is why page_size is declared without a Zod `.max()`. Zod bounds are
 * enforced, so `.max(50)` would reject a request the backend would have served,
 * making this surface stricter than the internal one for no gain. The bound is
 * stated in the description instead, and applied by clampPagination below.
 */

const DEFAULT_PAGE = 1;

/**
 * Config resources: thin rows (name, id, timestamps, flags). The ceiling is a
 * latency budget, not a backend limit.
 */
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;

/**
 * Rows carrying prompt/completion text, full request or response payloads, or
 * span detail. The ceiling here is a context budget, not a backend limit.
 */
const HEAVY_PAGE_SIZE_DEFAULT = 5;
const HEAVY_PAGE_SIZE_MAX = 10;

/** The model catalog is a reference table the caller usually wants in full. */
const CATALOG_PAGE_SIZE_MAX = 200;

/**
 * Tool name -> [default_page_size, max_page_size]. Keyed by tool so the
 * description and the handler read the SAME entry. Absent = standard profile.
 *
 * Kept identical to `_PAGINATION_OVERRIDES` in the backend's MCP core. A tool
 * whose profile differs there must be changed here in the same commit, or the
 * two surfaces answer the same question with different page sizes.
 */
const OVERRIDES: Record<string, [number, number]> = {
  log_list: [HEAVY_PAGE_SIZE_DEFAULT, HEAVY_PAGE_SIZE_MAX],
  trace_list: [HEAVY_PAGE_SIZE_DEFAULT, HEAVY_PAGE_SIZE_MAX],
  thread_list: [HEAVY_PAGE_SIZE_DEFAULT, HEAVY_PAGE_SIZE_MAX],
  dataset_logs_list: [HEAVY_PAGE_SIZE_DEFAULT, HEAVY_PAGE_SIZE_MAX],
  experiment_logs_list: [HEAVY_PAGE_SIZE_DEFAULT, HEAVY_PAGE_SIZE_MAX],
  model_list: [PAGE_SIZE_DEFAULT, CATALOG_PAGE_SIZE_MAX],
  pulse_incidents_list: [50, CATALOG_PAGE_SIZE_MAX],
};

/** [default_page_size, max_page_size] for a tool. */
export function paginationProfile(tool: string): [number, number] {
  return OVERRIDES[tool] ?? [PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX];
}

/**
 * The `page`/`page_size` arguments for a paginated tool.
 *
 * Spread into a tool's argument shape: `...paginationShape("log_list")`.
 */
export function paginationShape(tool: string) {
  const [defaultPageSize, maxPageSize] = paginationProfile(tool);
  return {
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Page number, 1-based (default ${DEFAULT_PAGE}).`),
    page_size: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        `Rows per page (default ${defaultPageSize}, max ${maxPageSize}). ` +
          `Larger values are clamped to ${maxPageSize}, not rejected.`,
      ),
  };
}

/**
 * Resolve page/page_size to the values actually sent upstream.
 *
 * Both are always returned, so a caller spreads the result straight into a
 * request without re-deciding whether to omit either one.
 */
export function clampPagination(
  tool: string,
  args: { page?: number; page_size?: number } = {},
): { page: number; page_size: number } {
  const [defaultPageSize, maxPageSize] = paginationProfile(tool);
  const requested = args.page_size ?? defaultPageSize;
  return {
    page: Math.max(DEFAULT_PAGE, Math.trunc(args.page ?? DEFAULT_PAGE)),
    page_size: Math.min(Math.max(1, Math.trunc(requested)), maxPageSize),
  };
}
