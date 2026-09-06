import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import handler from '../api/health.js';
import { createMcpHandler } from '../lib/shared/mcp-handler.js';
import { computeToolSchemaFingerprint, listRegisteredTools } from '../lib/shared/server-info.js';
import { createToolServer } from '../lib/shared/tools.js';

class MockResponse {
  statusCode = 200;
  headers = new Map<string, string | string[]>();
  body: any;
  headersSent = false;
  ended = false;

  setHeader(name: string, value: string | string[]) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string) {
    return this.headers.get(name.toLowerCase());
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: unknown) {
    this.body = body;
    this.headersSent = true;
    return this;
  }

  send(body: unknown) {
    this.body = body;
    this.headersSent = true;
    return this;
  }

  end() {
    this.ended = true;
    this.headersSent = true;
    return this;
  }
}

const SECRET_MARKER = 'super-secret-oauth-value';

function healthRequest(method = 'GET') {
  return {
    method,
    url: '/health?probe=echo-me',
    headers: {
      authorization: `Bearer ${SECRET_MARKER}`,
      'x-forwarded-for': '203.0.113.9',
      'respan-api-base-url': 'https://evil.example/api',
    },
    query: { probe: 'echo-me' },
    body: undefined,
    socket: { remoteAddress: '203.0.113.9' },
  } as any;
}

describe('GET /health', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'deadbeefcafe0000000000000000000000000001';
    process.env.VERCEL_GIT_COMMIT_REF = 'main';
    process.env.OAUTH_SECRET = SECRET_MARKER;
    process.env.UPSTASH_REDIS_REST_TOKEN = SECRET_MARKER;
    delete process.env.RESPAN_API_BASE_URL;
    delete process.env.RESPAN_ENTERPRISE_API_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('reports the deployed commit, tool surface and backend targets', async () => {
    const response = new MockResponse();
    await handler(healthRequest(), response as any);

    expect(response.statusCode).toBe(200);
    const tools = await listRegisteredTools(createToolServer(null));
    expect(response.body).toMatchObject({
      ok: true,
      service: 'respan-mcp',
      commit_sha: 'deadbeefcafe0000000000000000000000000001',
      branch: 'main',
      tool_count: tools.length,
      tool_schema_fingerprint: computeToolSchemaFingerprint(tools),
      backend_targets: {
        platform: 'https://api.respan.ai/api',
        enterprise: 'https://endpoint.respan.ai/api',
      },
    });
    expect(response.body.tool_schema_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(Date.parse(response.body.deployed_at)).not.toBeNaN();
    expect(Date.parse(response.body.started_at)).not.toBeNaN();
  });

  it('is unauthenticated, uncached and never echoes request data or secrets', async () => {
    const response = new MockResponse();
    const anonymous = healthRequest();
    delete anonymous.headers.authorization;
    await handler(anonymous, response as any);

    expect(response.statusCode).toBe(200);
    expect(String(response.getHeader('cache-control'))).toContain('no-store');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(SECRET_MARKER);
    expect(serialized).not.toContain('echo-me');
    expect(serialized).not.toContain('203.0.113.9');
    expect(serialized).not.toContain('evil.example');
  });

  it('falls back to the build stamp when the Vercel env is absent', async () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_GIT_COMMIT_REF;
    const response = new MockResponse();
    await handler(healthRequest(), response as any);
    expect(response.statusCode).toBe(200);
    // Placeholder in source control; scripts/stamp-build-info.mjs rewrites it on Vercel.
    expect(response.body.commit_sha).toBe('unknown');
  });

  it('answers OPTIONS with 204 and rejects other methods', async () => {
    const options = new MockResponse();
    await handler(healthRequest('OPTIONS'), options as any);
    expect(options.statusCode).toBe(204);
    expect(options.ended).toBe(true);

    const post = new MockResponse();
    await handler(healthRequest('POST'), post as any);
    expect(post.statusCode).toBe(405);
    expect(post.getHeader('allow')).toBe('GET, HEAD, OPTIONS');
  });
});

describe('server_info MCP tool', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'deadbeefcafe0000000000000000000000000002';
    process.env.OAUTH_SECRET = 'handler-test-secret-that-is-at-least-thirty-two';
    process.env.OAUTH_SESSION_STORE = 'memory';
    delete process.env.RESPAN_API_KEY;
    delete process.env.RESPAN_API_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  function toolCall(name: string, extraHeaders: Record<string, string> = {}) {
    return {
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: 'Bearer sk-respan-realistic-api-key',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
        ...extraHeaders,
      },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
      socket: { remoteAddress: '127.0.0.1' },
    } as any;
  }

  function parseToolResult(body: unknown) {
    const text = String(body);
    const json = text.startsWith('event:') || text.startsWith('data:')
      ? text.split('\n').find((line) => line.startsWith('data:'))!.slice(5).trim()
      : text;
    const message = JSON.parse(json);
    expect(message.error).toBeUndefined();
    expect(message.result.isError).toBeFalsy();
    return JSON.parse(message.result.content[0].text);
  }

  it('returns the same identity payload as /health', async () => {
    const mcp = createMcpHandler('https://api.respan.ai', '/.well-known/oauth-protected-resource', 'platform');
    const response = new MockResponse();
    await mcp(toolCall('server_info'), response as any);
    expect(response.statusCode).toBe(200);
    const info = parseToolResult(response.body);

    const health = new MockResponse();
    await handler({ method: 'GET', url: '/health', headers: {} } as any, health as any);
    const { ok: _ok, ...expected } = health.body;
    expect(info).toEqual(expected);
    expect(info.commit_sha).toBe('deadbeefcafe0000000000000000000000000002');
  });

  it('describes the full surface even when the request enables a subset of tools', async () => {
    const mcp = createMcpHandler('https://api.respan.ai', '/.well-known/oauth-protected-resource', 'platform');
    const response = new MockResponse();
    await mcp(toolCall('server_info', { 'respan-enabled-tools': 'server_info' }), response as any);
    expect(response.statusCode).toBe(200);
    const info = parseToolResult(response.body);
    const tools = await listRegisteredTools(createToolServer(null));
    expect(info.tool_count).toBe(tools.length);
    expect(info.tool_schema_fingerprint).toBe(computeToolSchemaFingerprint(tools));
  });
});
