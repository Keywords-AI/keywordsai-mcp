import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { OAuthBroker } from '../lib/oauth/broker.js';
import {
  loadOAuthConfig,
  resetOAuthConfigForTests,
} from '../lib/oauth/config.js';
import { InMemorySessionStore } from '../lib/oauth/memory-store.js';
import { hashOpaqueToken } from '../lib/oauth/crypto.js';
import {
  resetSessionStoreForTests,
  setSessionStoreForTests,
} from '../lib/oauth/store-factory.js';
import { SessionStoreUnavailableError } from '../lib/oauth/store.js';
import { createMcpHandler } from '../lib/shared/mcp-handler.js';

const SECRET = 'handler-test-secret-that-is-at-least-thirty-two';

class MockResponse {
  statusCode = 200;
  headers = new Map<string, string | string[]>();
  body: any;
  headersSent = false;

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
}

function request(credential: string, method = 'initialize', params: any = {}) {
  return {
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${credential}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: method === 'initialize'
        ? {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          }
        : params,
    },
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
}

function jwt(marker: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 4 * 60 * 60,
    marker,
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

async function issuePair(
  store: InMemorySessionStore,
  realm: 'platform' | 'enterprise' = 'platform',
) {
  const config = loadOAuthConfig(process.env);
  const broker = new OAuthBroker({ config, store });
  const verifier = 'v'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const started = await broker.startAuthorization({
    realm,
    clientId: 'enc_client',
    clientName: 'Handler test',
    redirectUri: 'http://127.0.0.1/callback',
    clientState: 'state',
    codeChallenge: challenge,
    resource: config.realms[realm].resource,
  });
  await broker.approveAuthorization(
    realm,
    started.transactionToken,
    started.browserCsrf,
  );
  const redirect = await broker.completeAuthorization({
    realm,
    transactionToken: started.transactionToken,
    browserCsrf: started.browserCsrf,
    backendAccessJwt: jwt('backend-access'),
    backendRefreshJwt: jwt('backend-refresh'),
  });
  const code = new URL(redirect).searchParams.get('code')!;
  const pair = await broker.exchangeAuthorizationCode({
    code,
    codeVerifier: verifier,
    clientId: 'enc_client',
    redirectUri: 'http://127.0.0.1/callback',
  });
  return { broker, pair };
}

describe('MCP authentication boundary', () => {
  beforeEach(async () => {
    process.env.OAUTH_SECRET = SECRET;
    process.env.OAUTH_SESSION_STORE = 'memory';
    process.env.MCP_PUBLIC_BASE_URL = 'https://mcp.respan.ai';
    process.env.MCP_REDIS_KEY_PREFIX = 'respan-mcp:handler-test:';
    delete process.env.RESPAN_API_KEY;
    delete process.env.RESPAN_API_BASE_URL;
    delete process.env.RESPAN_ENTERPRISE_API_BASE_URL;
    resetOAuthConfigForTests();
    await resetSessionStoreForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a real API-key-shaped bearer on a zero-store-operation path', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const handler = createMcpHandler(
      'https://api.respan.ai',
      '/.well-known/oauth-protected-resource',
      'platform',
    );
    const response = new MockResponse();
    await handler(request('sk-respan-realistic-api-key'), response as any);
    expect(response.statusCode).toBe(200);
    expect(store.operations).toBe(0);
  });

  it('keeps a direct-login backend JWT on the zero-store API-key path', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const directLoginAccess = jwt('direct-login-access');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ results: [], count: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const handler = createMcpHandler(
      'https://api.respan.ai',
      '/.well-known/oauth-protected-resource',
      'platform',
    );
    const response = new MockResponse();
    await handler(request(directLoginAccess, 'tools/call', {
      name: 'list_customers',
      arguments: { page_size: 1, page: 1 },
    }), response as any);

    expect(response.statusCode).toBe(200);
    expect(store.operations).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const outboundHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(outboundHeaders.get('authorization')).toBe(
      `Bearer ${directLoginAccess}`,
    );
  });

  it('normalizes a configured /api suffix on the zero-store API-key path', async () => {
    process.env.RESPAN_API_BASE_URL = 'http://127.0.0.1:8000/api';
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ results: [], count: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const handler = createMcpHandler(
      'https://api.respan.ai',
      '/.well-known/oauth-protected-resource',
      'platform',
    );
    const response = new MockResponse();
    await handler(request('sk-respan-realistic-api-key', 'tools/call', {
      name: 'list_customers',
      arguments: { page_size: 1, page: 1 },
    }), response as any);

    expect(response.statusCode).toBe(200);
    expect(store.operations).toBe(0);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /^http:\/\/127\.0\.0\.1:8000\/api\/users\/list\//,
    );
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('/api/api/');
  });

  it('never combines a fallback API key with a caller-provided backend URL', async () => {
    process.env.RESPAN_API_KEY = 'server-fallback-secret';
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ results: [], count: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const handler = createMcpHandler(
      'https://api.respan.ai',
      '/.well-known/oauth-protected-resource',
      'platform',
    );
    const maliciousRequest = request('unused', 'tools/call', {
      name: 'list_customers',
      arguments: { page_size: 1, page: 1 },
    });
    delete maliciousRequest.headers.authorization;
    maliciousRequest.headers['respan-api-base-url'] = 'https://attacker.example/api';
    const response = new MockResponse();
    await handler(maliciousRequest, response as any);

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/api\.respan\.ai\//);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('attacker.example');
  });

  it('rejects an unconfigured backend target even with a supplied API key', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const handler = createMcpHandler(
      'https://api.respan.ai',
      '/.well-known/oauth-protected-resource',
      'platform',
    );
    const maliciousRequest = request('sk-respan-realistic-api-key');
    maliciousRequest.headers['respan-api-base-url'] = 'https://attacker.example/api';
    const response = new MockResponse();
    await handler(maliciousRequest, response as any);
    expect(response.statusCode).toBe(400);
  });

  it('returns canonical 401 before server construction for an invalid MCP token', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const handler = createMcpHandler(
      'https://api.respan.ai',
      '/.well-known/oauth-protected-resource',
      'platform',
    );
    const response = new MockResponse();
    await handler(request('mcp_at_invalid'), response as any);
    expect(response.statusCode).toBe(401);
    expect(response.getHeader('www-authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.respan.ai/.well-known/oauth-protected-resource"',
    );
  });

  it('returns 503, not 401, when the MCP token store is unavailable', async () => {
    const store = new InMemorySessionStore();
    store.getAccessSession = vi.fn().mockRejectedValue(
      new SessionStoreUnavailableError(),
    );
    setSessionStoreForTests(store);
    const handler = createMcpHandler(
      'https://api.respan.ai',
      '/.well-known/oauth-protected-resource',
      'platform',
    );
    const response = new MockResponse();
    await handler(request('mcp_at_unavailable'), response as any);
    expect(response.statusCode).toBe(503);
    expect(response.getHeader('retry-after')).toBe('5');
    expect(response.getHeader('www-authenticate')).toBeUndefined();
  });

  it('forwards the decrypted backend JWT, never the inbound MCP token', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const { pair } = await issuePair(store);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ results: [], count: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const handler = createMcpHandler(
      'https://api.respan.ai',
      '/.well-known/oauth-protected-resource',
      'platform',
    );
    const response = new MockResponse();
    await handler(request(pair.access_token, 'tools/call', {
      name: 'list_customers',
      arguments: { page_size: 1, page: 1 },
    }), response as any);
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const outboundHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    const outbound = outboundHeaders.get('authorization');
    expect(outbound).toMatch(/^Bearer eyJ/);
    expect(outbound).not.toContain(pair.access_token);
    expect(String(response.body)).not.toContain('eyJ');
  });

  it('rejects an unsupported list_logs filter key before any backend call', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const { pair } = await issuePair(store);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ results: [], count: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const handler = createMcpHandler(
      'https://api.respan.ai',
      '/.well-known/oauth-protected-resource',
      'platform',
    );
    const response = new MockResponse();
    await handler(request(pair.access_token, 'tools/call', {
      name: 'list_logs',
      arguments: {
        filters: [{ field: 'error_message', operator: 'icontains', value: ['timeout'] }],
      },
    }), response as any);
    expect(response.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = String(response.body);
    expect(body).toContain('validation_error');
    expect(body).toContain('list_logs has no filter dimension for: error_message');
    expect(body).toMatch(/\\"isError\\":true|"isError":true/);
  });

  it('uses an enterprise session only on the enterprise MCP backend', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const { pair } = await issuePair(store, 'enterprise');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ results: [], count: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const enterpriseHandler = createMcpHandler(
      'https://endpoint.respan.ai',
      '/.well-known/oauth-protected-resource/enterprise',
      'enterprise',
    );
    const enterpriseResponse = new MockResponse();
    await enterpriseHandler(request(pair.access_token, 'tools/call', {
      name: 'list_customers',
      arguments: { page_size: 1, page: 1 },
    }), enterpriseResponse as any);

    expect(enterpriseResponse.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /^https:\/\/endpoint\.respan\.ai\/api\/users\/list\//,
    );
    const outboundHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(outboundHeaders.get('authorization')).toMatch(/^Bearer eyJ/);
    expect(outboundHeaders.get('authorization')).not.toContain(pair.access_token);

    const platformHandler = createMcpHandler(
      'https://api.respan.ai',
      '/.well-known/oauth-protected-resource',
      'platform',
    );
    const platformResponse = new MockResponse();
    await platformHandler(request(pair.access_token), platformResponse as any);
    expect(platformResponse.statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deletes only access and returns top-level 401 on backend rejection', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const { broker, pair } = await issuePair(store);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ detail: 'unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));
    const handler = createMcpHandler(
      'https://api.respan.ai',
      '/.well-known/oauth-protected-resource',
      'platform',
    );
    const response = new MockResponse();
    await handler(request(pair.access_token, 'tools/call', {
      name: 'list_customers',
      arguments: { page_size: 1, page: 1 },
    }), response as any);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(401);
    await expect(
      broker.resolveAccessToken('platform', pair.access_token),
    ).rejects.toThrow('Invalid MCP access token');
    expect(await store.getRefreshSession(
      'platform',
      hashOpaqueToken(pair.refresh_token),
    )).not.toBeNull();
  });
});
