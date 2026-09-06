// Live check that every filter field / sort option advertised by list_traces is
// honoured by the backend traces list endpoint.
//
//   RESPAN_API_KEY=... npx tsx scripts/verify-filter-fields.ts
//   RESPAN_API_BASE_URL=https://endpoint.respan.ai npx tsx scripts/verify-filter-fields.ts
//
// For each field it POSTs /api/traces/list/ with a benign predicate and expects
// a 200 whose count is <= the unfiltered baseline. It also probes fields the
// tool deliberately rejects (metadata__<key>, total_tokens) to show the
// backend's real behaviour for them, and a bogus operator to show the 400.
// The key is read from the environment only and never printed.
import { config as loadEnv } from 'dotenv';
import {
  TRACE_FILTER_FIELDS,
  TRACE_LEVEL_FILTER_FIELDS,
  TRACE_SORT_OPTIONS,
} from '../lib/observe/traces.js';

loadEnv({ path: '.env.local' });

const apiKey = process.env.RESPAN_API_KEY;
if (!apiKey) {
  console.error('RESPAN_API_KEY is required');
  process.exit(2);
}
const baseUrl = (process.env.RESPAN_API_BASE_URL || 'https://endpoint.respan.ai').replace(/\/api\/?$/, '');
const hours = Number(process.env.VERIFY_HOURS || 24 * 7);
const end = new Date();
const start = new Date(end.getTime() - hours * 3600 * 1000);

const NUMERIC_FIELDS = new Set([
  'span_count', 'llm_call_count', 'error_count', 'total_cost', 'total_prompt_tokens',
  'total_completion_tokens', 'total_request_tokens', 'duration', 'status_code',
  'prompt_version_number', 'cost', 'latency', 'time_to_first_token', 'tokens_per_second',
  'routing_time', 'prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens',
  'prompt_cache_creation_tokens',
]);
const BOOLEAN_FIELDS = new Set(['used_custom_credential']);
const TIME_FIELDS = new Set(['start_time', 'end_time', 'timestamp']);

function benignPredicate(field: string): { operator: string; value: unknown[] } {
  if (NUMERIC_FIELDS.has(field)) return { operator: 'gte', value: [0] };
  if (BOOLEAN_FIELDS.has(field)) return { operator: 'in', value: [true, false] };
  if (TIME_FIELDS.has(field)) return { operator: 'gte', value: [start.toISOString()] };
  return { operator: 'not', value: ['__verify_filter_fields_no_such_value__'] };
}

interface Outcome { status: number; count: number | null; detail?: string }

async function listTraces(query: Record<string, string>, body: unknown): Promise<Outcome> {
  const url = new URL('/api/traces/list/', baseUrl);
  url.searchParams.set('start_time', start.toISOString());
  url.searchParams.set('end_time', end.toISOString());
  url.searchParams.set('page_size', '1');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
  const count = typeof parsed?.count === 'number' ? parsed.count : null;
  const detail = res.ok ? undefined : text.slice(0, 200);
  return { status: res.status, count, detail };
}

async function main() {
  const baseline = await listTraces({}, {});
  console.log(`baseline: status=${baseline.status} count=${baseline.count} window=${hours}h base=${baseUrl}`);
  if (!baseline.status.toString().startsWith('2')) {
    console.error(baseline.detail);
    process.exit(1);
  }
  const rows: Array<{ probe: string; status: number; count: number | null; ok: boolean; note?: string }> = [];
  let failures = 0;

  for (const field of TRACE_FILTER_FIELDS) {
    const r = await listTraces({}, { filters: { [field]: benignPredicate(field) } });
    const ok = r.status === 200 && r.count !== null && (baseline.count === null || r.count <= baseline.count);
    if (!ok) failures += 1;
    rows.push({ probe: `filter ${field}`, status: r.status, count: r.count, ok, note: r.detail });
  }
  // Fields the tool rejects: show what the backend does with them.
  for (const field of ['metadata__verify_no_such_key', 'total_tokens']) {
    const r = await listTraces({}, { filters: { [field]: { operator: 'gte', value: [10 ** 12] } } });
    const widened = r.status === 200 && r.count === baseline.count;
    rows.push({
      probe: `rejected-by-tool ${field}`, status: r.status, count: r.count, ok: true,
      note: widened ? 'backend ignored the predicate (count == baseline)' : r.detail,
    });
  }
  const badOp = await listTraces({}, { filters: { [TRACE_LEVEL_FILTER_FIELDS[0]]: { operator: 'iexact', value: ['x'] } } });
  rows.push({ probe: 'operator iexact', status: badOp.status, count: badOp.count, ok: badOp.status === 400, note: badOp.detail });
  if (badOp.status !== 400) failures += 1;

  for (const sort of TRACE_SORT_OPTIONS) {
    const r = await listTraces({ sort_by: sort }, {});
    const ok = r.status === 200;
    if (!ok) failures += 1;
    rows.push({ probe: `sort ${sort}`, status: r.status, count: r.count, ok, note: r.detail });
  }

  for (const row of rows) {
    console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.probe.padEnd(44)} status=${row.status} count=${row.count}${row.note ? ` ${row.note}` : ''}`);
  }
  console.log(failures === 0 ? 'all probes passed' : `${failures} probe(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
