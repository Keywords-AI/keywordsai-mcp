import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '../lib/oauth/memory-store.js';
import { RECORD_VERSION, type AuthorizationCode } from '../lib/oauth/records.js';
import {
  ScriptedRedisSessionStore,
  type RedisCommands,
} from '../lib/oauth/scripted-redis-store.js';
import { SessionStoreUnavailableError } from '../lib/oauth/store.js';

class FailingAtomicRedis implements RedisCommands {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setEx(key: string, _ttl: number, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async setNxEx(): Promise<boolean> {
    return true;
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) this.values.delete(key);
  }

  async eval(): Promise<number> {
    throw new Error('injected atomic write failure');
  }

  async incrementWithExpiry(): Promise<number> {
    return 1;
  }
}

describe('in-memory session store contract', () => {
  it('does not consume a code unless both session writes succeed atomically', async () => {
    const now = Date.UTC(2026, 6, 28);
    const store = new InMemorySessionStore('contract:', () => now);
    const code: AuthorizationCode = {
      version: RECORD_VERSION,
      clientId: 'client',
      redirectUri: 'http://127.0.0.1/callback',
      codeChallenge: 'x'.repeat(43),
      realm: 'platform',
      resource: 'https://mcp.respan.ai/mcp',
      encryptedBackendAccessJwt: 'encrypted-access',
      backendAccessExpiresAt: now + 10_000,
      encryptedBackendRefreshJwt: 'encrypted-refresh',
      backendRefreshExpiresAt: now + 20_000,
      createdAt: now,
      expiresAt: now + 5_000,
    };
    await store.createAuthorizationCode('platform', 'a'.repeat(64), code, 5);
    const stored = await store.getAuthorizationCode('platform', 'a'.repeat(64));
    expect(stored).not.toBeNull();

    const exchanged = await store.exchangeAuthorizationCode({
      realm: 'platform',
      codeHash: 'a'.repeat(64),
      expectedCodeSerialized: `${stored!.serialized}tampered`,
      accessTokenHash: 'b'.repeat(64),
      accessSession: {
        version: RECORD_VERSION,
        tokenType: 'access',
        sessionId: 'session',
        clientId: 'client',
        realm: 'platform',
        resource: 'https://mcp.respan.ai/mcp',
        encryptedBackendAccessJwt: 'encrypted-access',
        backendAccessExpiresAt: now + 10_000,
        issuedAt: now,
        expiresAt: now + 10_000,
      },
      accessTtlSeconds: 10,
      refreshTokenHash: 'c'.repeat(64),
      refreshSession: {
        version: RECORD_VERSION,
        tokenType: 'refresh',
        sessionId: 'session',
        generation: 0,
        clientId: 'client',
        realm: 'platform',
        resource: 'https://mcp.respan.ai/mcp',
        currentAccessTokenHash: 'b'.repeat(64),
        encryptedBackendRefreshJwt: 'encrypted-refresh',
        backendRefreshExpiresAt: now + 20_000,
        issuedAt: now,
        absoluteExpiresAt: now + 20_000,
      },
      refreshTtlSeconds: 20,
    });
    expect(exchanged).toBe(false);
    expect(await store.getAuthorizationCode('platform', 'a'.repeat(64))).not.toBeNull();
    expect(await store.getAccessSession('platform', 'b'.repeat(64))).toBeNull();
    expect(await store.getRefreshSession('platform', 'c'.repeat(64))).toBeNull();
  });
});

describe('scripted Redis session-store failure contract', () => {
  it('does not consume a code when the atomic Redis operation fails', async () => {
    const now = Date.UTC(2026, 6, 28);
    const store = new ScriptedRedisSessionStore('failure:', new FailingAtomicRedis());
    const code: AuthorizationCode = {
      version: RECORD_VERSION,
      clientId: 'client',
      redirectUri: 'http://127.0.0.1/callback',
      codeChallenge: 'x'.repeat(43),
      realm: 'platform',
      resource: 'https://mcp.respan.ai/mcp',
      encryptedBackendAccessJwt: 'encrypted-access',
      backendAccessExpiresAt: now + 10_000,
      encryptedBackendRefreshJwt: 'encrypted-refresh',
      backendRefreshExpiresAt: now + 20_000,
      createdAt: now,
      expiresAt: now + 5_000,
    };
    await store.createAuthorizationCode('platform', 'a'.repeat(64), code, 5);
    const stored = await store.getAuthorizationCode('platform', 'a'.repeat(64));
    await expect(store.exchangeAuthorizationCode({
      realm: 'platform',
      codeHash: 'a'.repeat(64),
      expectedCodeSerialized: stored!.serialized,
      accessTokenHash: 'b'.repeat(64),
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
        expiresAt: now + 10_000,
      },
      accessTtlSeconds: 10,
      refreshTokenHash: 'c'.repeat(64),
      refreshSession: {
        version: RECORD_VERSION,
        tokenType: 'refresh',
        sessionId: 'session',
        generation: 0,
        clientId: 'client',
        realm: 'platform',
        resource: code.resource,
        currentAccessTokenHash: 'b'.repeat(64),
        encryptedBackendRefreshJwt: code.encryptedBackendRefreshJwt,
        backendRefreshExpiresAt: code.backendRefreshExpiresAt,
        issuedAt: now,
        absoluteExpiresAt: now + 20_000,
      },
      refreshTtlSeconds: 20,
    })).rejects.toBeInstanceOf(SessionStoreUnavailableError);
    expect(await store.getAuthorizationCode('platform', 'a'.repeat(64))).not.toBeNull();
  });
});
