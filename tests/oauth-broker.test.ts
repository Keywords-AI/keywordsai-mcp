import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { OAuthBroker } from '../lib/oauth/broker.js';
import { loadOAuthConfig } from '../lib/oauth/config.js';
import {
  decryptCredential,
  encryptCredential,
  generateOpaqueToken,
  hashOpaqueToken,
} from '../lib/oauth/crypto.js';
import { OAuthRequestError } from '../lib/oauth/errors.js';
import { InMemorySessionStore } from '../lib/oauth/memory-store.js';
import { parseAccessSession } from '../lib/oauth/records.js';
import {
  encrypt as encryptRegistration,
  verifyClientRegistration,
} from '../lib/shared/oauth.js';
import {
  browserCsrfCookie,
  clearBrowserCsrfCookie,
  hasValidBrowserCsrfCookie,
} from '../lib/oauth/browser-csrf.js';

const SECRET = 'test-secret-that-is-at-least-thirty-two-characters';

function jwt(expiryMs: number, marker: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(expiryMs / 1000),
    marker,
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function jwtMarker(value: string): string {
  return JSON.parse(
    Buffer.from(value.split('.')[1], 'base64url').toString('utf8'),
  ).marker;
}

function config(accessTokenTtlSeconds = 14_400) {
  return loadOAuthConfig({
    OAUTH_SECRET: SECRET,
    OAUTH_SESSION_STORE: 'memory',
    MCP_PUBLIC_BASE_URL: 'https://mcp.respan.ai',
    MCP_ACCESS_TOKEN_TTL_SECONDS: String(accessTokenTtlSeconds),
    MCP_REDIS_KEY_PREFIX: 'respan-mcp:test:',
  });
}

async function authorizationCode(
  broker: OAuthBroker,
  now: number,
  realm: 'platform' | 'enterprise' = 'platform',
) {
  const verifier = 'v'.repeat(64);
  const challenge = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  ).then((digest) => Buffer.from(digest).toString('base64url'));
  const resource = realm === 'platform'
    ? 'https://mcp.respan.ai/mcp'
    : 'https://mcp.respan.ai/mcp/enterprise';
  const started = await broker.startAuthorization({
    realm,
    clientId: 'enc_client',
    clientName: 'Test client',
    redirectUri: 'http://127.0.0.1:7777/callback',
    clientState: 'client-state',
    codeChallenge: challenge,
    resource,
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
    backendAccessJwt: jwt(now + 4 * 60 * 60 * 1000, 'backend-access'),
    backendRefreshJwt: jwt(now + 30 * 24 * 60 * 60 * 1000, 'backend-refresh'),
  });
  return {
    code: new URL(redirect).searchParams.get('code')!,
    verifier,
    resource,
  };
}

async function issuePair(
  broker: OAuthBroker,
  now: number,
  realm: 'platform' | 'enterprise' = 'platform',
) {
  const authorization = await authorizationCode(broker, now, realm);
  const pair = await broker.exchangeAuthorizationCode({
    code: authorization.code,
    codeVerifier: authorization.verifier,
    clientId: 'enc_client',
    redirectUri: 'http://127.0.0.1:7777/callback',
    resource: authorization.resource,
  });
  return { ...authorization, pair };
}

describe('OAuth crypto and configuration', () => {
  it('generates prefixed 256-bit tokens, hashes keys, and encrypts credentials', () => {
    const token = generateOpaqueToken('mcp_at_');
    expect(token).toMatch(/^mcp_at_[A-Za-z0-9_-]{43}$/);
    expect(hashOpaqueToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOpaqueToken(token)).not.toContain(token);

    const encrypted = encryptCredential('backend.jwt.value', SECRET);
    expect(encrypted).not.toContain('backend.jwt.value');
    expect(decryptCredential(encrypted, SECRET)).toBe('backend.jwt.value');
  });

  it('validates store credentials and access TTL bounds', () => {
    expect(() => loadOAuthConfig({
      OAUTH_SECRET: SECRET,
      OAUTH_SESSION_STORE: 'redis',
    })).toThrow('REDIS_URL');
    expect(() => loadOAuthConfig({
      OAUTH_SECRET: SECRET,
      OAUTH_SESSION_STORE: 'memory',
      MCP_ACCESS_TOKEN_TTL_SECONDS: '59',
    })).toThrow('Invalid OAuth configuration');
    expect(() => loadOAuthConfig({
      OAUTH_SECRET: SECRET,
      OAUTH_SESSION_STORE: 'memory',
      MCP_REFRESH_LOCK_TTL_SECONDS: '29',
    })).toThrow('Invalid OAuth configuration');
    expect(config(60).accessTokenTtlSeconds).toBe(60);
    expect(loadOAuthConfig({
      OAUTH_SECRET: SECRET,
      OAUTH_SESSION_STORE: 'memory',
      MCP_REFRESH_LOCK_TTL_SECONDS: '30',
    }).refreshLockTtlSeconds).toBe(30);
  });

  it('rejects ephemeral or insecure production deployment configuration', () => {
    expect(() => loadOAuthConfig({
      OAUTH_SECRET: SECRET,
      OAUTH_SESSION_STORE: 'memory',
      VERCEL_ENV: 'preview',
    })).toThrow('Vercel deployments require the upstash session store');
    expect(() => loadOAuthConfig({
      OAUTH_SECRET: SECRET,
      OAUTH_SESSION_STORE: 'upstash',
      UPSTASH_REDIS_REST_URL: 'https://redis.example',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      MCP_PUBLIC_BASE_URL: 'http://mcp.example',
      VERCEL_ENV: 'production',
    })).toThrow('production public and backend URLs must use HTTPS');
  });

  it('rejects malformed and unknown-version session records', () => {
    expect(() => parseAccessSession({
      version: 2,
      tokenType: 'access',
    })).toThrow();
    expect(() => parseAccessSession({
      version: 1,
      tokenType: 'refresh',
    })).toThrow();
  });

  it('accepts legacy signed client registrations without a client name', () => {
    process.env.OAUTH_SECRET = SECRET;
    const registration = encryptRegistration({
      type: 'client_reg',
      clientId: 'legacy-client',
      redirectUris: ['http://127.0.0.1/callback'],
      exp: Date.now() + 60_000,
    });
    expect(verifyClientRegistration(registration)).toEqual({
      clientId: 'legacy-client',
      redirectUris: ['http://127.0.0.1/callback'],
      clientName: 'Previously registered MCP client',
    });
  });

  it('keeps transaction-bound CSRF cookies valid across concurrent tabs', () => {
    const firstHeader = browserCsrfCookie(
      'mcp_tx_first',
      'browser-csrf-first',
      true,
    );
    const secondHeader = browserCsrfCookie(
      'mcp_tx_second',
      'browser-csrf-second',
      true,
    );
    const firstCookie = firstHeader.split(';')[0];
    const secondCookie = secondHeader.split(';')[0];
    const request = {
      headers: { cookie: `${firstCookie}; ${secondCookie}` },
    } as any;

    expect(firstHeader).toContain('__Host-respan_mcp_oauth_csrf_');
    expect(firstHeader).toContain('HttpOnly');
    expect(firstHeader).toContain('SameSite=Lax');
    expect(firstHeader).toContain('Secure');
    expect(firstCookie.split('=')[0]).not.toBe(secondCookie.split('=')[0]);
    expect(hasValidBrowserCsrfCookie(
      request,
      'mcp_tx_first',
      'browser-csrf-first',
      true,
    )).toBe(true);
    expect(hasValidBrowserCsrfCookie(
      request,
      'mcp_tx_second',
      'browser-csrf-second',
      true,
    )).toBe(true);
    expect(hasValidBrowserCsrfCookie(
      request,
      'mcp_tx_first',
      'browser-csrf-second',
      true,
    )).toBe(false);
    expect(hasValidBrowserCsrfCookie(
      request,
      'mcp_tx_first',
      'browser-csrf-first',
      false,
    )).toBe(false);

    const cleared = clearBrowserCsrfCookie('mcp_tx_first', true);
    expect(cleared).toContain(`${firstCookie.split('=')[0]}=`);
    expect(cleared).not.toContain(secondCookie.split('=')[0]);
  });
});

describe('OAuth broker lifecycle', () => {
  it('atomically exchanges a one-use code for opaque audience-bound tokens', async () => {
    const now = Date.UTC(2026, 6, 28);
    const store = new InMemorySessionStore('respan-mcp:test:', () => now);
    const broker = new OAuthBroker({ config: config(60), store, now: () => now });
    const authorization = await authorizationCode(broker, now);
    const pair = await broker.exchangeAuthorizationCode({
      code: authorization.code,
      codeVerifier: authorization.verifier,
      clientId: 'enc_client',
      redirectUri: 'http://127.0.0.1:7777/callback',
      resource: authorization.resource,
    });

    expect(pair.access_token).toMatch(/^mcp_at_/);
    expect(pair.refresh_token).toMatch(/^mcp_rt_/);
    expect(pair.token_type).toBe('Bearer');
    expect(pair.expires_in).toBe(60);
    expect(JSON.stringify(pair)).not.toContain('backend-');

    await expect(broker.exchangeAuthorizationCode({
      code: authorization.code,
      codeVerifier: authorization.verifier,
      clientId: 'enc_client',
      redirectUri: 'http://127.0.0.1:7777/callback',
      resource: authorization.resource,
    })).rejects.toMatchObject({ oauthError: 'invalid_grant' });

    const resolved = await broker.resolveAccessToken('platform', pair.access_token);
    expect(jwtMarker(resolved.backendAccessJwt)).toBe('backend-access');
    await expect(
      broker.resolveAccessToken('enterprise', pair.access_token),
    ).rejects.toThrow('Invalid MCP access token');
  });

  it('rejects PKCE, redirect, resource, and client mismatches without consuming the code', async () => {
    const now = Date.UTC(2026, 6, 28);
    const broker = new OAuthBroker({
      config: config(),
      store: new InMemorySessionStore('respan-mcp:test:', () => now),
      now: () => now,
    });
    const authorization = await authorizationCode(broker, now);
    for (const mismatch of [
      { codeVerifier: 'x'.repeat(64) },
      { clientId: 'enc_other' },
      { redirectUri: 'http://127.0.0.1:7777/other' },
      { resource: 'https://mcp.respan.ai/mcp/enterprise' },
    ]) {
      await expect(broker.exchangeAuthorizationCode({
        code: authorization.code,
        codeVerifier: authorization.verifier,
        clientId: 'enc_client',
        redirectUri: 'http://127.0.0.1:7777/callback',
        resource: authorization.resource,
        ...mismatch,
      })).rejects.toMatchObject({ oauthError: 'invalid_grant' });
    }
    await expect(broker.exchangeAuthorizationCode({
      code: authorization.code,
      codeVerifier: authorization.verifier,
      clientId: 'enc_client',
      redirectUri: 'http://127.0.0.1:7777/callback',
      resource: authorization.resource,
    })).resolves.toMatchObject({ token_type: 'Bearer' });
  });

  it('enforces CSRF, approval, authorization-code expiry, and enterprise audience', async () => {
    let now = Date.UTC(2026, 6, 28);
    const store = new InMemorySessionStore('respan-mcp:test:', () => now);
    const broker = new OAuthBroker({ config: config(), store, now: () => now });
    const verifier = 'v'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const started = await broker.startAuthorization({
      realm: 'enterprise',
      clientId: 'enc_client',
      clientName: 'Enterprise test',
      redirectUri: 'http://127.0.0.1/callback',
      clientState: 'state',
      codeChallenge: challenge,
      resource: 'https://mcp.respan.ai/mcp/enterprise',
    });
    await expect(broker.approveAuthorization(
      'enterprise',
      started.transactionToken,
      'wrong-csrf',
    )).rejects.toMatchObject({ oauthError: 'invalid_request' });
    await expect(broker.completeAuthorization({
      realm: 'enterprise',
      transactionToken: started.transactionToken,
      browserCsrf: started.browserCsrf,
      backendAccessJwt: jwt(now + 14_400_000, 'access'),
      backendRefreshJwt: jwt(now + 30 * 24 * 60 * 60 * 1000, 'refresh'),
    })).rejects.toMatchObject({ oauthError: 'access_denied' });
    await broker.approveAuthorization(
      'enterprise',
      started.transactionToken,
      started.browserCsrf,
    );
    const redirect = await broker.completeAuthorization({
      realm: 'enterprise',
      transactionToken: started.transactionToken,
      browserCsrf: started.browserCsrf,
      backendAccessJwt: jwt(now + 14_400_000, 'access'),
      backendRefreshJwt: jwt(now + 30 * 24 * 60 * 60 * 1000, 'refresh'),
    });
    const code = new URL(redirect).searchParams.get('code')!;
    now += 601_000;
    await expect(broker.exchangeAuthorizationCode({
      code,
      codeVerifier: verifier,
      clientId: 'enc_client',
      redirectUri: 'http://127.0.0.1/callback',
      resource: 'https://mcp.respan.ai/mcp/enterprise',
    })).rejects.toMatchObject({ oauthError: 'invalid_grant' });
  });

  it('expires access independently while preserving the refresh session', async () => {
    let now = Date.UTC(2026, 6, 28);
    const store = new InMemorySessionStore('respan-mcp:test:', () => now);
    const broker = new OAuthBroker({ config: config(60), store, now: () => now });
    const { pair } = await issuePair(broker, now);
    now += 61_000;
    await expect(
      broker.resolveAccessToken('platform', pair.access_token),
    ).rejects.toThrow('Invalid MCP access token');
    expect(await store.getRefreshSession(
      'platform',
      hashOpaqueToken(pair.refresh_token),
    )).not.toBeNull();
  });

  it('rotates both tokens, rejects reuse, and keeps the newer pair valid', async () => {
    const now = Date.UTC(2026, 6, 28);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ access: jwt(now + 4 * 60 * 60 * 1000, 'refreshed-access') }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const broker = new OAuthBroker({
      config: config(),
      store: new InMemorySessionStore('respan-mcp:test:', () => now),
      now: () => now,
      fetch: fetchMock,
    });
    const { pair } = await issuePair(broker, now);
    const rotated = await broker.refresh({
      refreshToken: pair.refresh_token,
      clientId: 'enc_client',
      resource: 'https://mcp.respan.ai/mcp',
    });

    expect(rotated.access_token).not.toBe(pair.access_token);
    expect(rotated.refresh_token).not.toBe(pair.refresh_token);
    await expect(broker.refresh({
      refreshToken: pair.refresh_token,
      clientId: 'enc_client',
    })).rejects.toMatchObject({ oauthError: 'invalid_grant' });
    const resolved = await broker.resolveAccessToken(
      'platform',
      rotated.access_token,
    );
    expect(jwtMarker(resolved.backendAccessJwt)).toBe('refreshed-access');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows only one concurrent refresh to call the backend', async () => {
    const now = Date.UTC(2026, 6, 28);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      await gate;
      return new Response(JSON.stringify({
        access: jwt(now + 4 * 60 * 60 * 1000, 'concurrent-access'),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const broker = new OAuthBroker({
      config: config(),
      store: new InMemorySessionStore('respan-mcp:test:', () => now),
      now: () => now,
      fetch: fetchMock,
    });
    const { pair } = await issuePair(broker, now);
    const first = broker.refresh({
      refreshToken: pair.refresh_token,
      clientId: 'enc_client',
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await expect(broker.refresh({
      refreshToken: pair.refresh_token,
      clientId: 'enc_client',
    })).rejects.toMatchObject({ oauthError: 'temporarily_unavailable' });
    release();
    await expect(first).resolves.toMatchObject({ token_type: 'Bearer' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves a refresh session after backend 5xx or network failure', async () => {
    const now = Date.UTC(2026, 6, 28);
    const store = new InMemorySessionStore('respan-mcp:test:', () => now);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access: jwt(now + 4 * 60 * 60 * 1000, 'eventual-access'),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const broker = new OAuthBroker({
      config: config(),
      store,
      now: () => now,
      fetch: fetchMock,
    });
    const { pair } = await issuePair(broker, now);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(broker.refresh({
        refreshToken: pair.refresh_token,
        clientId: 'enc_client',
      })).rejects.toMatchObject({ oauthError: 'temporarily_unavailable' });
      expect(await store.getRefreshSession(
        'platform',
        hashOpaqueToken(pair.refresh_token),
      )).not.toBeNull();
    }
    await expect(broker.refresh({
      refreshToken: pair.refresh_token,
      clientId: 'enc_client',
    })).resolves.toMatchObject({ token_type: 'Bearer' });
  });

  it('deletes the old session when the backend rejects its refresh JWT', async () => {
    const now = Date.UTC(2026, 6, 28);
    const store = new InMemorySessionStore('respan-mcp:test:', () => now);
    const broker = new OAuthBroker({
      config: config(),
      store,
      now: () => now,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 })),
    });
    const { pair } = await issuePair(broker, now);
    await expect(broker.refresh({
      refreshToken: pair.refresh_token,
      clientId: 'enc_client',
    })).rejects.toMatchObject({ oauthError: 'invalid_grant' });
    expect(await store.getRefreshSession(
      'platform',
      hashOpaqueToken(pair.refresh_token),
    )).toBeNull();
  });

  it('stores a replacement backend refresh JWT and honors the absolute session cap', async () => {
    let now = Date.UTC(2026, 6, 28);
    const replacement = jwt(
      now + 30 * 24 * 60 * 60 * 1000,
      'replacement-refresh',
    );
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access: jwt(now + 4 * 60 * 60 * 1000, 'first-access'),
        refresh: replacement,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access: jwt(now + 4 * 60 * 60 * 1000, 'second-access'),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const store = new InMemorySessionStore('respan-mcp:test:', () => now);
    const broker = new OAuthBroker({
      config: config(),
      store,
      now: () => now,
      fetch: fetchMock,
    });
    const { pair } = await issuePair(broker, now);
    const first = await broker.refresh({
      refreshToken: pair.refresh_token,
      clientId: 'enc_client',
    });
    await broker.refresh({
      refreshToken: first.refresh_token,
      clientId: 'enc_client',
    });
    const secondRequest = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    );
    expect(secondRequest.refresh).toBe(replacement);

    const cappedStore = new InMemorySessionStore('respan-mcp:cap:', () => now);
    const cappedFetch = vi.fn<typeof fetch>();
    const cappedBroker = new OAuthBroker({
      config: config(),
      store: cappedStore,
      now: () => now,
      fetch: cappedFetch,
    });
    const cappedPair = await issuePair(cappedBroker, now);
    now += 30 * 24 * 60 * 60 * 1000 + 1;
    await expect(cappedBroker.refresh({
      refreshToken: cappedPair.pair.refresh_token,
      clientId: 'enc_client',
    })).rejects.toMatchObject({ oauthError: 'invalid_grant' });
    expect(cappedFetch).not.toHaveBeenCalled();
  });
});
