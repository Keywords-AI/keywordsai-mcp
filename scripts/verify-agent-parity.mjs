/**
 * Agent-tier parity check.
 *
 * The public surface is meant to carry every tool the in-product agent has.
 * The manifest is generated from that same agent registry, so anything in it
 * and absent here is a gap — either a tool nobody wired up, or one the backend
 * added since. Both should fail loudly rather than be noticed months later.
 *
 * Deliberate exclusions are listed below WITH a reason. An exclusion without a
 * reason is not an exclusion, it is a gap someone silenced.
 *
 *   npm run build:server && node scripts/verify-agent-parity.mjs
 *
 * Exits non-zero when an unlisted agent-tier tool is missing.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RUN_METRICS_REASON =
  'Withheld by product decision: run-history and run time-series reads are ' +
  'per-run operational detail, and the four nouns multiply them into eight ' +
  'tools carrying some of the longest descriptions on the surface. The ' +
  'eval-score reads cover the question customers actually ask of a graded run.';

const CHART_REASON =
  'Withheld by product decision: returns a time-bucketed series meant to be ' +
  'plotted. An MCP client renders text, so the series arrives as rows a model ' +
  'reads out one bucket at a time. The matching _summary read answers the same ' +
  'question as a single collapsed figure.';

/** The plot-shaped dashboard reads: every *_over_time twin, plus the chart tool. */
const CHART_TOOLS = Object.fromEntries(
  [
    'dashboard_llm_metrics_over_time',
    'dashboard_quantiles_over_time',
    'dashboard_storage_volume_over_time',
    'dashboard_eval_results_over_time',
    'dashboard_metric_chart',
    // Returns a time-bucketed `activity` array alongside its summary, so it is
    // the same plot-shaped read as the rest of this list.
    'dashboard_active_users',
  ].map(name => [name, CHART_REASON]),
);

const EXCLUDED = {
  dashboard_platform_public_stats:
    'Returns Respan-wide aggregate statistics rather than the caller\'s own data, ' +
    'and resolves its host from an operator profile rather than the configured ' +
    'base URL. Neither fits a surface pinned to one organization.',

  oauth_resource_list:
    'Withheld by product decision. Also backed by a JWT-only endpoint, so it ' +
    'would 401 under the API-key auth this package documents as its main path.',

  prompt_permanent_delete:
    'Withheld by product decision: irreversible destruction of a prompt and ' +
    'every version, with no trash to recover from. prompt_delete (soft, 30-day ' +
    'trash) covers the intent a customer actually has.',
  prompt_trash_restore:
    'Withheld by product decision, alongside prompt_permanent_delete. Trashed ' +
    'prompts remain findable with prompt_list(is_deleted=true).',

  ...CHART_TOOLS,

  monitor_run_history: RUN_METRICS_REASON,
  monitor_runs_time_series: RUN_METRICS_REASON,
  automation_run_history: RUN_METRICS_REASON,
  automation_runs_time_series: RUN_METRICS_REASON,
  report_run_history: RUN_METRICS_REASON,
  report_runs_time_series: RUN_METRICS_REASON,
  evaluator_run_history: RUN_METRICS_REASON,
  evaluator_runs_time_series: RUN_METRICS_REASON,
};

const manifest = JSON.parse(readFileSync('lib/generated/manifest.json', 'utf-8'));
const agentTier = manifest.tools.map(t => t.name);

const proc = spawn('node', ['dist/lib/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, RESPAN_API_KEY: 'parity-check-not-a-real-key', RESPAN_TOOL_MODE: 'flat' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
proc.stdout.on('data', d => { buf += d.toString(); });
const send = o => proc.stdin.write(JSON.stringify(o) + '\n');

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'parity', version: '1' } } });
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 600);

setTimeout(() => {
  proc.kill();
  const msg = buf.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).find(m => m.id === 2);
  if (!msg) { console.log('FAIL: no tools/list response'); process.exit(1); }

  const published = new Set(msg.result.tools.map(t => t.name));
  const missing = agentTier.filter(n => !published.has(n) && !(n in EXCLUDED));
  const staleExclusions = Object.keys(EXCLUDED).filter(n => published.has(n) || !agentTier.includes(n));

  console.log(`agent tier: ${agentTier.length}`);
  console.log(`published:  ${published.size}`);
  console.log(`excluded:   ${Object.keys(EXCLUDED).length}`);
  for (const [name, reason] of Object.entries(EXCLUDED)) {
    console.log(`  - ${name}: ${reason}`);
  }

  const problems = [];
  if (missing.length) {
    problems.push(`agent-tier tools absent from this surface: ${missing.join(', ')}`);
  }
  if (staleExclusions.length) {
    problems.push(`exclusions that no longer apply (published, or gone from the agent tier): ${staleExclusions.join(', ')}`);
  }

  if (problems.length) {
    console.log('\nFAIL');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nPASS: every agent-tier tool is published, or excluded with a reason');
}, 2400);
