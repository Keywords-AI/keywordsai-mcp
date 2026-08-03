import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import authHandler from '../api/auth.js';
import { OAuthBroker } from '../lib/oauth/broker.js';
import {
  getOAuthConfig,
  resetOAuthConfigForTests,
} from '../lib/oauth/config.js';
import { InMemorySessionStore } from '../lib/oauth/memory-store.js';
import { browserCsrfCookie } from '../lib/oauth/browser-csrf.js';
import {
  resetSessionStoreForTests,
  setSessionStoreForTests,
} from '../lib/oauth/store-factory.js';

class MockResponse {
  statusCode = 200;
  headers = new Map<string, string | string[]>();
  body: any;

  setHeader(name: string, value: string | string[]) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: unknown) {
    this.body = body;
    return this;
  }
}

function jwt(marker: string, lifetimeSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + lifetimeSeconds,
    marker,
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('browser OAuth completion boundary', () => {
  beforeEach(async () => {
    process.env.OAUTH_SECRET = 'auth-handler-secret-that-is-at-least-thirty-two';
    process.env.OAUTH_SESSION_STORE = 'memory';
    process.env.MCP_PUBLIC_BASE_URL = 'https://mcp.respan.ai';
    process.env.MCP_REDIS_KEY_PREFIX = 'respan-mcp:auth-handler-test:';
    delete process.env.RESPAN_API_BASE_URL;
    delete process.env.RESPAN_ENTERPRISE_API_BASE_URL;
    resetOAuthConfigForTests();
    await resetSessionStoreForTests();
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns only a callback URL and never backend JWTs to the browser', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const config = getOAuthConfig();
    const broker = new OAuthBroker({ config, store });
    const started = await broker.startAuthorization({
      realm: 'platform',
      clientId: 'enc_client',
      clientName: 'Browser test',
      redirectUri: 'http://127.0.0.1/callback',
      clientState: 'state',
      codeChallenge: 'x'.repeat(43),
      resource: config.realms.platform.resource,
    });
    const backendAccess = jwt('backend-access', 14_400);
    const backendRefresh = jwt('backend-refresh', 30 * 24 * 60 * 60);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access: backendAccess,
      refresh: backendRefresh,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const response = new MockResponse();
    const csrfCookie = browserCsrfCookie(
      started.transactionToken,
      started.browserCsrf,
      true,
    ).split(';')[0];
    await authHandler({
      method: 'POST',
      headers: {
        cookie: csrfCookie,
      },
      socket: { remoteAddress: '127.0.0.1' },
      body: {
        action: 'login',
        email: 'local@example.com',
        password: 'not-logged',
        oauth_transaction: started.transactionToken,
        oauth_csrf: started.browserCsrf,
        enterprise: false,
        approve: true,
      },
    } as any, response as any);

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.body)).toEqual(['redirect_url']);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(backendAccess);
    expect(serialized).not.toContain(backendRefresh);
    expect(response.body.redirect_url).toContain('code=mcp_ac_');
    expect(response.body.redirect_url).toContain('state=state');
  });

  it('rejects OAuth completion without the bound browser cookie', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const config = getOAuthConfig();
    const started = await new OAuthBroker({ config, store }).startAuthorization({
      realm: 'platform',
      clientId: 'enc_client',
      clientName: 'Browser test',
      redirectUri: 'http://127.0.0.1/callback',
      clientState: 'state',
      codeChallenge: 'x'.repeat(43),
      resource: config.realms.platform.resource,
    });
    const response = new MockResponse();
    await authHandler({
      method: 'POST',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      body: {
        action: 'login',
        email: 'local@example.com',
        password: 'not-used',
        oauth_transaction: started.transactionToken,
        oauth_csrf: started.browserCsrf,
        approve: true,
      },
    } as any, response as any);
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
  });

  it('rejects an unconfigured authentication backend before proxying credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = new MockResponse();
    await authHandler({
      method: 'POST',
      headers: {
        'respan-api-base-url': 'http://169.254.169.254/latest/meta-data',
      },
      socket: { remoteAddress: '127.0.0.1' },
      body: {
        action: 'login',
        email: 'local@example.com',
        password: 'must-not-be-forwarded',
      },
    } as any, response as any);
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
