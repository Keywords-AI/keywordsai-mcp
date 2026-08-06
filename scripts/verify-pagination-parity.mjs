/**
 * Pagination parity check against the backend registry.
 *
 * The backend keys every list tool's (default, max) page size off one table and
 * generates its schema text from the same entry, so its prose cannot drift from
 * its behaviour. This surface mirrors that table in lib/shared/pagination.ts.
 * Two copies of a table drift, so this compares them.
 *
 * For every tool present in BOTH the public surface and the generated manifest,
 * the advertised default and max must match. A tool that changes profile in the
 * backend fails here until pagination.ts is updated to match.
 *
 *   npm run build:server && node scripts/verify-pagination-parity.mjs
 *
 * Exits non-zero on any mismatch.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('lib/generated/manifest.json', 'utf-8'));
const manifestTools = Array.isArray(manifest) ? manifest : manifest.tools;
const backend = new Map(
  (Array.isArray(manifestTools) ? manifestTools : Object.values(manifestTools)).map(t => [t.name, t]),
);

/** Pull (default, max) out of the "Rows per page (default D, max M)." prose. */
function bounds(description) {
  const m = /default (\d+), max (\d+)/.exec(description || '');
  return m ? { default: Number(m[1]), max: Number(m[2]) } : null;
}

const proc = spawn('node', ['dist/lib/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, RESPAN_API_KEY: 'pagination-check-not-a-real-key', RESPAN_TOOL_MODE: 'flat' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
proc.stdout.on('data', d => { buf += d.toString(); });
const send = o => proc.stdin.write(JSON.stringify(o) + '\n');

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pagination', version: '1' } } });
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 600);

setTimeout(() => {
  proc.kill();
  const msg = buf.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).find(m => m.id === 2);
  if (!msg) { console.log('FAIL: no tools/list response'); process.exit(1); }

  const problems = [];
  let compared = 0;
  let publicPaginated = 0;

  for (const tool of msg.result.tools) {
    const props = tool.inputSchema?.properties || {};
    if (!props.page_size) continue;
    publicPaginated++;

    const mine = bounds(props.page_size.description);
    if (!mine) {
      problems.push(`${tool.name}: page_size description does not state "default D, max M"`);
      continue;
    }

    const theirs = backend.get(tool.name);
    if (!theirs) continue; // Public-only tool; nothing to compare against.
    const theirBounds = bounds(theirs.inputSchema?.properties?.page_size?.description);
    if (!theirBounds) continue; // Backend tool is not paginated.

    compared++;
    if (mine.default !== theirBounds.default || mine.max !== theirBounds.max) {
      problems.push(
        `${tool.name}: public says default ${mine.default}/max ${mine.max}, ` +
        `backend says default ${theirBounds.default}/max ${theirBounds.max}`,
      );
    }
  }

  console.log(`paginated public tools: ${publicPaginated}`);
  console.log(`compared against backend: ${compared}`);

  if (problems.length) {
    console.log('\nFAIL');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('PASS: every shared list tool advertises the backend page bounds');
}, 2400);
