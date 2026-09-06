import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  canonicalJson,
  computeToolSchemaFingerprint,
  deployedBranch,
  deployedCommitSha,
  getServerInfo,
  listRegisteredTools,
  type ToolSurface,
} from '../lib/shared/server-info.js';
import { createToolServer } from '../lib/shared/tools.js';

const FINGERPRINT = /^[0-9a-f]{16}$/;

function tool(name: string, properties: Record<string, unknown>, description = `${name} tool`): ToolSurface {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required: Object.keys(properties) },
  };
}

const ALPHA = tool('alpha', { id: { type: 'string' }, limit: { type: 'number' } });
const BETA = tool('beta', { query: { type: 'string' } });

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined values', () => {
    expect(canonicalJson({ b: [{ z: 1, y: undefined, x: { q: 2, p: 1 } }], a: 0 }))
      .toBe('{"a":0,"b":[{"x":{"p":1,"q":2},"z":1}]}');
  });
});

describe('computeToolSchemaFingerprint', () => {
  it('is a 16-char hex digest', () => {
    expect(computeToolSchemaFingerprint([ALPHA, BETA])).toMatch(FINGERPRINT);
  });

  it('is independent of tool order and JSON key order', () => {
    const ordered = computeToolSchemaFingerprint([ALPHA, BETA]);
    const reversed = computeToolSchemaFingerprint([BETA, ALPHA]);
    const reKeyed = computeToolSchemaFingerprint([
      { inputSchema: { required: ['query'], properties: { query: { type: 'string' } }, type: 'object' }, description: BETA.description, name: 'beta' },
      ALPHA,
    ]);
    expect(reversed).toBe(ordered);
    expect(reKeyed).toBe(ordered);
  });

  it('changes when a tool is added, removed, renamed, re-described or re-typed', () => {
    const base = computeToolSchemaFingerprint([ALPHA, BETA]);
    expect(computeToolSchemaFingerprint([ALPHA])).not.toBe(base);
    expect(computeToolSchemaFingerprint([ALPHA, BETA, tool('gamma', {})])).not.toBe(base);
    expect(computeToolSchemaFingerprint([ALPHA, { ...BETA, name: 'beta2' }])).not.toBe(base);
    expect(computeToolSchemaFingerprint([ALPHA, { ...BETA, description: 'different' }])).not.toBe(base);
    expect(computeToolSchemaFingerprint([
      ALPHA,
      tool('beta', { query: { type: 'string' }, page: { type: 'number' } }, BETA.description),
    ])).not.toBe(base);
  });

  it('treats a missing outputSchema and an undefined one the same', () => {
    expect(computeToolSchemaFingerprint([{ ...ALPHA, outputSchema: undefined }]))
      .toBe(computeToolSchemaFingerprint([ALPHA]));
  });
});

describe('listRegisteredTools', () => {
  it('returns the tools exactly as a client sees them, as JSON Schema', async () => {
    const server = new McpServer({ name: 'probe', version: '0' });
    server.tool('echo', 'Echo back', { text: z.string().describe('What to echo') }, async ({ text }) => ({
      content: [{ type: 'text' as const, text }],
    }));
    const tools = await listRegisteredTools(server);
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(tools[0].description).toBe('Echo back');
    expect(tools[0].inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string', description: 'What to echo' } },
      required: ['text'],
    });
  });

  it('enumerates the same surface from every freshly built server', async () => {
    const a = await listRegisteredTools(createToolServer(null));
    const b = await listRegisteredTools(createToolServer(null));
    expect(a.length).toBeGreaterThan(10);
    expect(a.map((t) => t.name)).toContain('server_info');
    expect(a.map((t) => t.name)).toContain('list_logs');
    expect(computeToolSchemaFingerprint(a)).toBe(computeToolSchemaFingerprint(b));
    expect(new Set(a.map((t) => t.name)).size).toBe(a.length);
  });
});

describe('getServerInfo', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('reports the full unfiltered surface with a stable fingerprint', async () => {
    const info = await getServerInfo(() => createToolServer(null));
    const tools = await listRegisteredTools(createToolServer(null));
    expect(info.service).toBe('respan-mcp');
    expect(info.tool_count).toBe(tools.length);
    expect(info.tool_schema_fingerprint).toBe(computeToolSchemaFingerprint(tools));
    expect(info.tool_schema_fingerprint).toMatch(FINGERPRINT);
    expect(Date.parse(info.started_at)).not.toBeNaN();
    expect(Date.parse(info.deployed_at)).not.toBeNaN();
    expect(info).not.toHaveProperty('ok');
  });

  it('reads the deployed commit from the Vercel env and falls back to the build stamp', () => {
    expect(deployedCommitSha({ VERCEL_GIT_COMMIT_SHA: 'abc123' })).toBe('abc123');
    expect(deployedCommitSha({})).toBe('unknown');
    expect(deployedBranch({ VERCEL_GIT_COMMIT_REF: 'main' })).toBe('main');
    expect(deployedBranch({})).toBe('unknown');
  });

  it('reports the effective backend targets without any request input', async () => {
    delete process.env.RESPAN_API_BASE_URL;
    delete process.env.RESPAN_ENTERPRISE_API_BASE_URL;
    expect((await getServerInfo(() => createToolServer(null))).backend_targets).toEqual({
      platform: 'https://api.respan.ai/api',
      enterprise: 'https://endpoint.respan.ai/api',
    });

    process.env.RESPAN_API_BASE_URL = 'http://127.0.0.1:8000/api';
    expect((await getServerInfo(() => createToolServer(null))).backend_targets.platform)
      .toBe('http://127.0.0.1:8000/api');
  });
});
