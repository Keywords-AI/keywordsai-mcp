/**
 * Security regression check: every outbound transport must send
 * X-Respan-Agent-Scope: own-org and X-Respan-Client: public-mcp.
 *
 * Without it a Respan staff token resolves to is_superadmin() server-side and
 * reads across organizations. This package has three transports (the generated
 * SDK client, rawFetch, and the synced-tool dispatcher) and all three must set
 * the header, so this exercises one tool from each against a local server.
 *
 *   npm run build:server && node scripts/verify-own-org-header.mjs
 *
 * Exits non-zero if any request is missing the header.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const seen = [];
const srv = createServer((req, res) => {
  seen.push({
    url: req.url,
    scope: req.headers['x-respan-agent-scope'] ?? null,
    client: req.headers['x-respan-client'] ?? null,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ results: [], data: [] }));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const p = spawn('node', ['dist/lib/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, RESPAN_API_KEY: 'test-key', RESPAN_API_BASE_URL: base },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const send = o => p.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });

const call = (id, name, args) => send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
setTimeout(() => call(2, 'dataset_list', {}), 500);                        // SDK transport
setTimeout(() => call(3, 'evaluator_list', {}), 1100);           // rawFetch transport
setTimeout(() => call(4, 'annotation_queue_summary', {}), 1700);            // synced generated tool
setTimeout(() => {
  p.kill(); srv.close();
  console.log('requests observed:', seen.length);
  for (const s of seen) console.log(`  scope=${s.scope ?? 'MISSING'} client=${s.client ?? 'MISSING'}  ${s.url}`);
  const missing = seen.filter(s => s.scope !== 'own-org' || s.client !== 'public-mcp');
  if (seen.length < 3) {
    console.log(`FAIL: expected 3 upstream requests, saw ${seen.length}. A probed tool name probably no longer exists.`);
    process.exit(1);
  }
  const ok = missing.length === 0;
  console.log(ok
    ? 'PASS: every transport sent the own-org scope and public-mcp client headers'
    : `FAIL: ${missing.length} request(s) missing a required header`);
  process.exit(ok ? 0 : 1);
}, 2600);
