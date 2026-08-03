import { config as loadEnv } from 'dotenv';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { Redis as UpstashRedis } from '@upstash/redis';
import { createClient } from 'redis';

loadEnv({ path: '.env.local' });

const baseUrl = 'http://127.0.0.1:3100';
const callbackUrl = 'http://127.0.0.1:3199/callback';
const email = process.env.OAUTH_TEST_EMAIL;
const password = process.env.OAUTH_TEST_PASSWORD;
const apiKey = process.env.OAUTH_TEST_API_KEY;
const sessionStore = process.env.OAUTH_SESSION_STORE || 'redis';
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379/15';
const verifyRefreshExpiry = process.env.OAUTH_VERIFY_REFRESH_EXPIRY === 'true';
const refreshSessionTtlSeconds = Number(
  process.env.MCP_REFRESH_SESSION_TTL_SECONDS || 0,
);
const probeId = randomBytes(8).toString('hex');
const keyPrefix = `respan-mcp:local:probe:${probeId}:`;

type JsonObject = Record<string, any>;

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required in .env.local`);
  return value;
}

async function step<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    console.info(`PASS ${name} (${Date.now() - startedAt}ms)`);
    return result;
  } catch (error) {
    console.error(`FAIL ${name} (${Date.now() - startedAt}ms)`);
    throw error;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function json(response: Response): Promise<JsonObject> {
  const body = await response.json() as JsonObject;
  return body;
}

function parseMcpBody(text: string): JsonObject {
  if (text.trim().startsWith('{')) return JSON.parse(text);
  const dataLines = text.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
  assert(dataLines.length > 0, 'MCP response did not contain a message');
  return dataLines[dataLines.length - 1];
}

async function mcpRequest(
  credential: string,
  method: string,
  params: JsonObject,
  id: number,
  path = '/mcp',
): Promise<{ response: Response; body: JsonObject }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await response.text();
  return {
    response,
    body: text ? parseMcpBody(text) : {},
  };
}

async function waitForServer(child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Local OAuth server exited during startup');
    try {
      const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Local OAuth server did not become ready');
}

type RedisInspector = {
  ping(): Promise<unknown>;
  keys(): Promise<string[]>;
  get(key: string): Promise<unknown>;
  delete(keys: string[]): Promise<void>;
  close(): Promise<void>;
};

async function createRedisInspector(): Promise<RedisInspector> {
  if (sessionStore === 'upstash') {
    const url = required(process.env.UPSTASH_REDIS_REST_URL, 'UPSTASH_REDIS_REST_URL');
    const token = required(process.env.UPSTASH_REDIS_REST_TOKEN, 'UPSTASH_REDIS_REST_TOKEN');
    const client = new UpstashRedis({ url, token });
    return {
      ping: () => client.ping(),
      keys: async () => {
        const keys: string[] = [];
        let cursor = '0';
        do {
          const [nextCursor, page] = await client.scan(cursor, {
            match: `${keyPrefix}*`,
            count: 100,
          });
          keys.push(...page);
          cursor = nextCursor;
        } while (cursor !== '0');
        return keys;
      },
      get: (key) => client.get(key),
      delete: async (keys) => {
        if (keys.length > 0) await client.del(...keys);
      },
      close: async () => {},
    };
  }

  const client = createClient({ url: redisUrl });
  await client.connect();
  return {
    ping: () => client.ping(),
    keys: async () => {
      const keys: string[] = [];
      for await (const key of client.scanIterator({ MATCH: `${keyPrefix}*`, COUNT: 100 })) {
        keys.push(String(key));
      }
      return keys;
    },
    get: (key) => client.get(key),
    delete: async (keys) => {
      if (keys.length > 0) await client.del(keys);
    },
    close: () => client.quit(),
  };
}

async function run(): Promise<void> {
  required(email, 'OAUTH_TEST_EMAIL');
  required(password, 'OAUTH_TEST_PASSWORD');
  required(apiKey, 'OAUTH_TEST_API_KEY');
  if (
    verifyRefreshExpiry
    && (!Number.isInteger(refreshSessionTtlSeconds) || refreshSessionTtlSeconds < 60)
  ) {
    throw new Error(
      'MCP_REFRESH_SESSION_TTL_SECONDS must be at least 60 when OAUTH_VERIFY_REFRESH_EXPIRY=true',
    );
  }

  await step('local backend reachable', async () => {
    const response = await fetch(
      `${(process.env.RESPAN_API_BASE_URL || 'http://127.0.0.1:8000/api').replace(/\/api\/?$/, '')}/`,
    );
    assert(response.status < 500, 'Local backend is unavailable');
  });

  const redis = await createRedisInspector();
  await step(`${sessionStore} Redis reachable`, async () => {
    await redis.ping();
  });

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/oauth-dev-server.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OAUTH_SECRET: process.env.OAUTH_SECRET || randomBytes(48).toString('base64url'),
        OAUTH_SESSION_STORE: sessionStore,
        REDIS_URL: redisUrl,
        MCP_REDIS_KEY_PREFIX: keyPrefix,
        MCP_PUBLIC_BASE_URL: baseUrl,
        MCP_ACCESS_TOKEN_TTL_SECONDS: '60',
        RESPAN_API_BASE_URL: process.env.RESPAN_API_BASE_URL || 'http://127.0.0.1:8000/api',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );

  try {
    await step('local OAuth server starts', () => waitForServer(child));

    const metadata = await step('OAuth metadata discovery', async () => {
      const protectedResource = await json(await fetch(
        `${baseUrl}/.well-known/oauth-protected-resource`,
      ));
      assert(protectedResource.resource === `${baseUrl}/mcp`, 'Unexpected resource metadata');
      const authorizationServer = await json(await fetch(
        `${baseUrl}/.well-known/oauth-authorization-server`,
      ));
      assert(
        authorizationServer.grant_types_supported.includes('refresh_token'),
        'Refresh grant is not advertised',
      );
      return authorizationServer;
    });

    const registration = await step('dynamic client registration', async () => {
      const response = await fetch(metadata.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Local OAuth verification probe',
          redirect_uris: [callbackUrl],
          token_endpoint_auth_method: 'none',
        }),
      });
      assert(response.status === 201, 'Client registration failed');
      return json(response);
    });

    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const clientState = randomBytes(24).toString('base64url');
    const authorization = await step('authorization transaction and PKCE binding', async () => {
      const authorize = new URL(metadata.authorization_endpoint);
      authorize.search = new URLSearchParams({
        response_type: 'code',
        client_id: registration.client_id,
        redirect_uri: callbackUrl,
        state: clientState,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: `${baseUrl}/mcp`,
      }).toString();
      const response = await fetch(authorize, { redirect: 'manual' });
      assert(response.status === 302, 'Authorization did not redirect to login');
      return {
        loginLocation: new URL(required(response.headers.get('location') || undefined, 'Login redirect'), baseUrl),
        csrfCookie: required(response.headers.get('set-cookie')?.split(';')[0], 'CSRF cookie'),
      };
    });
    const loginLocation = authorization.loginLocation;
    const csrfCookie = authorization.csrfCookie;
    const transactionId = required(loginLocation.searchParams.get('transaction_id') || undefined, 'transaction_id');
    const csrf = required(loginLocation.searchParams.get('csrf') || undefined, 'csrf');

    await step('client confirmation content', async () => {
      const loginHtml = await (await fetch(loginLocation)).text();
      assert(loginHtml.includes('oauth-confirmation'), 'Login page lacks client confirmation');
      const context = await json(await fetch(
        `${baseUrl}/oauth/code?${new URLSearchParams({
          transaction_id: transactionId,
          csrf,
        })}`,
        { headers: { Cookie: csrfCookie } },
      ));
      assert(context.client_name === 'Local OAuth verification probe', 'Client name mismatch');
      assert(context.redirect_uri === callbackUrl, 'Redirect URI mismatch');
    });

    const callback = await step('approved email and password login', async () => {
      const response = await fetch(`${baseUrl}/auth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: csrfCookie,
        },
        body: JSON.stringify({
          action: 'login',
          email,
          password,
          oauth_transaction: transactionId,
          oauth_csrf: csrf,
          approve: true,
          enterprise: false,
        }),
      });
      const responseBody = await json(response);
      assert(response.ok, 'Backend login failed');
      assert(typeof responseBody.redirect_url === 'string', 'Browser received no callback URL');
      assert(!JSON.stringify(responseBody).includes('"access"'), 'Browser received backend access JWT');
      assert(!JSON.stringify(responseBody).includes('"refresh"'), 'Browser received backend refresh JWT');
      return new URL(responseBody.redirect_url);
    });
    assert(callback.searchParams.get('state') === clientState, 'Client state was not preserved');
    const code = required(callback.searchParams.get('code') || undefined, 'authorization code');
    assert(code.startsWith('mcp_ac_'), 'Authorization code is not opaque');

    const exchangeBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: registration.client_id,
      redirect_uri: callbackUrl,
      resource: `${baseUrl}/mcp`,
    });
    const pair = await step('one-use authorization code exchange', async () => {
      const response = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: exchangeBody,
      });
      const responseBody = await json(response);
      assert(response.ok, 'Authorization code exchange failed');
      assert(responseBody.access_token.startsWith('mcp_at_'), 'Invalid MCP access token');
      assert(responseBody.refresh_token.startsWith('mcp_rt_'), 'Invalid MCP refresh token');
      assert(responseBody.token_type === 'Bearer', 'Invalid token type');
      assert(responseBody.expires_in === 60, 'Local access TTL is not 60 seconds');
      assert(!JSON.stringify(responseBody).includes('eyJ'), 'Token response contains a backend JWT');
      return responseBody;
    });
    const refreshSessionIssuedAt = Date.now();

    await step('authorization code reuse rejected', async () => {
      const response = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: exchangeBody,
      });
      assert(response.status === 400, 'Reused code did not fail');
      assert((await json(response)).error === 'invalid_grant', 'Reused code returned wrong error');
    });

    await step('hashed Redis keys and encrypted credentials', async () => {
      const keys = await redis.keys();
      assert(keys.length > 0, 'Probe session did not create Redis records');
      assert(keys.every((key) => !key.includes('mcp_at_') && !key.includes('mcp_rt_')), 'Redis key contains an opaque token');
      for (const key of keys) {
        const value = await redis.get(key);
        assert(!String(value).includes(pair.access_token), 'Redis value contains MCP access token');
        assert(!String(value).includes(pair.refresh_token), 'Redis value contains MCP refresh token');
        assert(!/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\./.test(String(value)), 'Redis value contains a backend JWT');
      }
    });

    await step('OAuth MCP initialization and tool discovery', async () => {
      const initialized = await mcpRequest(pair.access_token, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'oauth-probe', version: '1.0.0' },
      }, 1);
      assert(initialized.response.ok && initialized.body.result, 'MCP initialization failed');
      const tools = await mcpRequest(pair.access_token, 'tools/list', {}, 2);
      assert(tools.response.ok && Array.isArray(tools.body.result?.tools), 'Tool discovery failed');
    });

    await step('read-only OAuth tool call', async () => {
      const result = await mcpRequest(pair.access_token, 'tools/call', {
        name: 'list_customers',
        arguments: { page_size: 1, page: 1 },
      }, 3);
      assert(result.response.ok && result.body.result && !result.body.result.isError, 'OAuth tool call failed');
    });

    await step('access expiry returns canonical 401', async () => {
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      const expired = await mcpRequest(pair.access_token, 'tools/list', {}, 4);
      assert(expired.response.status === 401, 'Expired access token did not return 401');
      assert(
        expired.response.headers.get('www-authenticate')?.includes('/.well-known/oauth-protected-resource'),
        'Expired access token lacks canonical challenge',
      );
    });

    const rotated = await step('refresh rotates both MCP tokens', async () => {
      const response = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: pair.refresh_token,
          client_id: registration.client_id,
          resource: `${baseUrl}/mcp`,
        }),
      });
      const responseBody = await json(response);
      assert(response.ok, 'Refresh failed');
      assert(responseBody.access_token !== pair.access_token, 'Access token did not rotate');
      assert(responseBody.refresh_token !== pair.refresh_token, 'Refresh token did not rotate');
      return responseBody;
    });

    await step('post-refresh MCP tool call', async () => {
      const result = await mcpRequest(rotated.access_token, 'tools/call', {
        name: 'list_customers',
        arguments: { page_size: 1, page: 1 },
      }, 5);
      assert(result.response.ok && result.body.result && !result.body.result.isError, 'Post-refresh tool call failed');
    });

    await step('old refresh reuse cannot revoke newer pair', async () => {
      const response = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: pair.refresh_token,
          client_id: registration.client_id,
        }),
      });
      assert(response.status === 400 && (await json(response)).error === 'invalid_grant', 'Old refresh token reuse was accepted');
      const stillValid = await mcpRequest(rotated.access_token, 'tools/list', {}, 6);
      assert(stillValid.response.ok && stillValid.body.result, 'Newer access token was revoked by reuse');
    });

    await step('platform token rejected by enterprise audience', async () => {
      const response = await mcpRequest(
        rotated.access_token,
        'tools/list',
        {},
        7,
        '/mcp/enterprise',
      );
      assert(response.response.status === 401, 'Cross-audience token was accepted');
    });

    await step('API key path performs zero Redis writes and calls a tool', async () => {
      const before = (await redis.keys()).sort();
      const result = await mcpRequest(apiKey!, 'tools/call', {
        name: 'list_customers',
        arguments: { page_size: 1, page: 1 },
      }, 8);
      assert(result.response.ok && result.body.result && !result.body.result.isError, 'API key tool call failed');
      const after = (await redis.keys()).sort();
      assert(JSON.stringify(after) === JSON.stringify(before), 'API key path changed Redis state');
    });

    if (verifyRefreshExpiry) {
      await step('refresh expiry requires reauthorization', async () => {
        const expiresAt = refreshSessionIssuedAt + refreshSessionTtlSeconds * 1000;
        const waitMs = Math.max(0, expiresAt - Date.now() + 2_000);
        await new Promise((resolve) => setTimeout(resolve, waitMs));

        const refreshResponse = await fetch(metadata.token_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: rotated.refresh_token,
            client_id: registration.client_id,
            resource: `${baseUrl}/mcp`,
          }),
        });
        assert(refreshResponse.status === 400, 'Expired refresh token did not fail');
        assert(
          (await json(refreshResponse)).error === 'invalid_grant',
          'Expired refresh token returned the wrong OAuth error',
        );

        const accessResponse = await mcpRequest(
          rotated.access_token,
          'tools/list',
          {},
          9,
        );
        assert(
          accessResponse.response.status === 401,
          'Access token remained valid after the refresh session expired',
        );
      });
    }
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    const keys = await redis.keys();
    await redis.delete(keys);
    await redis.close();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : 'OAuth verification failed');
  process.exitCode = 1;
});
