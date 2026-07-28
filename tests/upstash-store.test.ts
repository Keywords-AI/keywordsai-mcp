import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpstashSessionStore } from '../lib/oauth/upstash-store.js';
import { RECORD_VERSION, type AuthorizationCode } from '../lib/oauth/records.js';

describe('mocked Upstash session-store contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses one EVAL command to exchange a code for both session records', async () => {
    const values = new Map<string, string>();
    const commands: unknown[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as unknown[];
      const isPipeline = Array.isArray(payload[0]);
      const batch = (isPipeline ? payload : [payload]) as unknown[][];
      const results = batch.map((command) => {
        commands.push(command);
        const name = String(command[0]).toLowerCase();
        let result: unknown;
        if (name === 'set') {
          values.set(String(command[1]), String(command[2]));
          result = 'OK';
        } else if (name === 'get') {
          result = values.get(String(command[1])) ?? null;
        } else if (name === 'eval') {
          const keyCount = Number(command[2]);
          const keys = command.slice(3, 3 + keyCount).map(String);
          const args = command.slice(3 + keyCount).map(String);
          const current = values.get(keys[0]);
          if (current !== args[0]) {
            result = 0;
          } else {
            values.set(keys[1], args[1]);
            values.set(keys[2], args[3]);
            values.delete(keys[0]);
            result = 1;
          }
        } else if (name === 'del') {
          result = 0;
          for (const key of command.slice(1).map(String)) {
            if (values.delete(key)) result = Number(result) + 1;
          }
        } else {
          throw new Error(`Unexpected mock command: ${name}`);
        }
        return { result };
      });
      return new Response(JSON.stringify(isPipeline ? results : results[0]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const now = Date.UTC(2026, 6, 28);
    const store = createUpstashSessionStore(
      'https://mock-upstash.invalid',
      'mock-token',
      'upstash-test:',
    );
    const codeHash = 'a'.repeat(64);
    const accessHash = 'b'.repeat(64);
    const refreshHash = 'c'.repeat(64);
    const code: AuthorizationCode = {
      version: RECORD_VERSION,
      clientId: 'client',
      redirectUri: 'http://127.0.0.1/callback',
      codeChallenge: 'x'.repeat(43),
      realm: 'platform',
      resource: 'https://mcp.respan.ai/mcp',
      encryptedBackendAccessJwt: 'encrypted-access',
      backendAccessExpiresAt: now + 60_000,
      encryptedBackendRefreshJwt: 'encrypted-refresh',
      backendRefreshExpiresAt: now + 120_000,
      createdAt: now,
      expiresAt: now + 60_000,
    };
    await store.createAuthorizationCode('platform', codeHash, code, 60);
    const stored = await store.getAuthorizationCode('platform', codeHash);
    expect(stored).not.toBeNull();
    expect(await store.exchangeAuthorizationCode({
      realm: 'platform',
      codeHash,
      expectedCodeSerialized: stored!.serialized,
      accessTokenHash: accessHash,
      accessSession: {
        version: RECORD_VERSION,
        tokenType: 'access',
        sessionId: 'session',
        clientId: 'client',
        realm: 'platform',
        resource: code.resource,
        encryptedBackendAccessJwt: code.encryptedBackendAccessJwt,
        backendAccessExpiresAt: code.backendAccessExpiresAt,
        issuedAt: now,
        expiresAt: now + 60_000,
      },
      accessTtlSeconds: 60,
      refreshTokenHash: refreshHash,
      refreshSession: {
        version: RECORD_VERSION,
        tokenType: 'refresh',
        sessionId: 'session',
        generation: 0,
        clientId: 'client',
        realm: 'platform',
        resource: code.resource,
        currentAccessTokenHash: accessHash,
        encryptedBackendRefreshJwt: code.encryptedBackendRefreshJwt,
        backendRefreshExpiresAt: code.backendRefreshExpiresAt,
        issuedAt: now,
        absoluteExpiresAt: now + 120_000,
      },
      refreshTtlSeconds: 120,
    })).toBe(true);
    expect(commands.filter((command) => String(command[0]).toLowerCase() === 'eval')).toHaveLength(1);
    expect(await store.getAuthorizationCode('platform', codeHash)).toBeNull();
    expect(await store.getAccessSession('platform', accessHash)).not.toBeNull();
    expect(await store.getRefreshSession('platform', refreshHash)).not.toBeNull();
  });
});
