/**
 * Naming regression check for the public tool surface.
 *
 * Tools are named noun_verb to match the Respan backend (`log_list`,
 * `monitor_create`). The older verb_noun names (`list_logs`, `create_workflow`)
 * were replaced, not aliased, so any reappearance is a regression.
 *
 * The generic workflow tools matter most. A model asked to "create a monitor"
 * would pick `create_workflow` over the typed tool and then guess the type
 * discriminator wrong, which is why the typed nouns exist at all. No tool name
 * may contain "workflow".
 *
 *   npm run build:server && node scripts/verify-tool-naming.mjs
 *
 * Exits non-zero on any violation.
 */
import { spawn } from 'node:child_process';

const VERB_PREFIXES = [
  'list_', 'get_', 'create_', 'update_', 'delete_', 'search_',
  'commit_', 'deploy_', 'undeploy_', 'validate_', 'run_', 'test_',
  'import_', 'remove_', 'replace_', 'retrieve_', 'summarize_', 'filter_', 'bulk_',
];

// A representative slice of what the typed split must produce.
const REQUIRED = [
  'monitor_create', 'monitor_list', 'monitor_deploy',
  'automation_create', 'automation_list',
  'report_create', 'report_list',
  'evaluator_create', 'evaluator_list',
  'grader_create', 'grader_run',
  'log_list', 'trace_get', 'prompt_create', 'dataset_list', 'experiment_list',
];

const proc = spawn('node', ['dist/lib/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, RESPAN_API_KEY: 'naming-check-not-a-real-key' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
proc.stdout.on('data', d => { buf += d.toString(); });
const send = o => proc.stdin.write(JSON.stringify(o) + '\n');

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'naming', version: '1' } } });
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 600);

setTimeout(() => {
  proc.kill();
  const msg = buf.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).find(m => m.id === 2);
  if (!msg) { console.log('FAIL: no tools/list response'); process.exit(1); }

  const names = msg.result.tools.map(t => t.name);
  const problems = [];

  const workflowNamed = names.filter(n => n.includes('workflow'));
  if (workflowNamed.length) problems.push(`generic workflow tools still registered: ${workflowNamed.join(', ')}`);

  const verbFirst = names.filter(n => VERB_PREFIXES.some(p => n.startsWith(p)));
  if (verbFirst.length) problems.push(`verb_noun names still registered: ${verbFirst.join(', ')}`);

  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) problems.push(`duplicate names: ${[...new Set(dupes)].join(', ')}`);

  const missing = REQUIRED.filter(n => !names.includes(n));
  if (missing.length) problems.push(`expected tools missing: ${missing.join(', ')}`);

  console.log(`tools advertised: ${names.length}`);
  const byNoun = {};
  for (const n of names) {
    const noun = n.split('_')[0];
    byNoun[noun] = (byNoun[noun] || 0) + 1;
  }
  console.log('by noun:', Object.entries(byNoun).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));

  if (problems.length) {
    console.log('\nFAIL');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('PASS: every tool is noun_verb, no generic workflow tools, no duplicates');
}, 2400);
