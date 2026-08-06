/**
 * Deferred-surface check.
 *
 * In deferred mode the server registers three meta-tools and serves the other
 * ~155 as data. The failure that matters is a tool becoming UNREACHABLE: if it
 * is captured but lands in no group, nothing in tool_search will ever name it,
 * and it is gone from the product without anyone noticing.
 *
 * This walks the deferred surface the way a client would — list groups, expand
 * each one — and asserts the union equals the flat surface exactly.
 *
 *   npm run build:server && node scripts/verify-deferred-surface.mjs
 *
 * Exits non-zero on any gap.
 */
import { spawn } from 'node:child_process';

const META_TOOLS = ['tool_search', 'tool_schema', 'tool_execute'];

function drive(env, script) {
  return new Promise(resolve => {
    const proc = spawn('node', ['dist/lib/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, RESPAN_API_KEY: 'deferred-check-not-a-real-key', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    proc.stdout.on('data', d => { buf += d.toString(); });
    const send = o => proc.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'deferred', version: '1' } } });
    script(send);
    setTimeout(() => {
      proc.kill();
      resolve(buf.split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean));
    }, 3200);
  });
}

const call = (send, id, name, args, delay) =>
  setTimeout(() => send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }), delay);

const payload = (msgs, id) => {
  const m = msgs.find(x => x.id === id);
  if (!m?.result?.content?.[0]?.text) return null;
  try { return JSON.parse(m.result.content[0].text); } catch { return null; }
};

const problems = [];

// --- flat surface: the set every tool must remain reachable from ---
const flatMsgs = await drive({ RESPAN_TOOL_MODE: 'flat' }, send => {
  setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 600);
});
const flatList = flatMsgs.find(m => m.id === 2);
if (!flatList) { console.log('FAIL: flat surface did not respond'); process.exit(1); }
const flatNames = new Set(flatList.result.tools.map(t => t.name));

// --- deferred surface ---
const deferredMsgs = await drive({}, send => {
  setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 600);
  call(send, 3, 'tool_search', {}, 900);
  call(send, 4, 'tool_execute', { tool: 'definitely_not_a_tool', args: {} }, 1200);
});
const deferredList = deferredMsgs.find(m => m.id === 2);
if (!deferredList) { console.log('FAIL: deferred surface did not respond'); process.exit(1); }

const registered = deferredList.result.tools.map(t => t.name).sort();
if (registered.join(',') !== [...META_TOOLS].sort().join(',')) {
  problems.push(`deferred mode should register exactly ${META_TOOLS.join(', ')} — got: ${registered.join(', ') || '(none)'}`);
}

const groupsPayload = payload(deferredMsgs, 3);
const groups = groupsPayload?.groups?.map(g => g.group) ?? [];
if (groups.length === 0) problems.push('tool_search with no arguments returned no groups');

// Expand every group and union the names.
const expandMsgs = await drive({}, send => {
  groups.forEach((g, i) => call(send, 100 + i, 'tool_search', { group: g }, 500 + i * 60));
});
const reachable = new Set();
groups.forEach((g, i) => {
  const p = payload(expandMsgs, 100 + i);
  if (!p?.tools) { problems.push(`tool_search(group="${g}") returned nothing`); return; }
  for (const t of p.tools) reachable.add(t.name);
});

const unreachable = [...flatNames].filter(n => !reachable.has(n));
if (unreachable.length) {
  problems.push(`captured but reachable from no group: ${unreachable.join(', ')}`);
}
const phantom = [...reachable].filter(n => !flatNames.has(n));
if (phantom.length) {
  problems.push(`advertised by tool_search but not registered on the flat surface: ${phantom.join(', ')}`);
}

// An unknown tool must be a redirect, not a dead end.
const unknown = payload(deferredMsgs, 4);
if (unknown?.error !== 'unknown_tool') {
  problems.push('tool_execute with an unknown name did not return an unknown_tool error');
}

// The description is the only text guaranteed to reach the model, so it has to
// name the groups it expects back.
const searchTool = deferredList.result.tools.find(t => t.name === 'tool_search');
const describedGroups = groups.filter(g => (searchTool?.description ?? '').includes(g));
if (describedGroups.length !== groups.length) {
  problems.push(
    `tool_search's description omits groups it serves: ${groups.filter(g => !describedGroups.includes(g)).join(', ')}`,
  );
}

const blob = JSON.stringify({ tools: deferredList.result.tools });
console.log(`flat surface:     ${flatNames.size} tools`);
console.log(`deferred upfront: ${registered.length} tools, ${(blob.length / 1024).toFixed(1)} KB, ~${(blob.length / 4 / 1000).toFixed(2)}k tokens`);
console.log(`groups:           ${groups.length}, covering ${reachable.size} tools`);

if (problems.length) {
  console.log('\nFAIL');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('PASS: every tool on the flat surface is reachable through tool_search');
