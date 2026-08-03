import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLocalRedisSessionStore } from '../lib/oauth/redis-store.js';
import { RECORD_VERSION, type AuthorizationCode } from '../lib/oauth/records.js';

const redisIt = process.env.TEST_REDIS_URL ? it : it.skip;

describe('local Redis session-store contract', () => {
  redisIt('atomically consumes a code and creates both records under an isolated prefix', async () => {
    const now = Date.now();
    const prefix = `respan-mcp:test:${randomBytes(8).toString('hex')}:`;
    const store = createLocalRedisSessionStore(process.env.TEST_REDIS_URL!, prefix);
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
    try {
      await store.createAuthorizationCode('platform', codeHash, code, 60);
      const stored = await store.getAuthorizationCode('platform', codeHash);
      expect(stored).not.toBeNull();
      const exchanged = await store.exchangeAuthorizationCode({
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
      });
      expect(exchanged).toBe(true);
      expect(await store.getAuthorizationCode('platform', codeHash)).toBeNull();
      expect(await store.getAccessSession('platform', accessHash)).not.toBeNull();
      expect(await store.getRefreshSession('platform', refreshHash)).not.toBeNull();
    } finally {
      await store.deleteRefreshSession('platform', refreshHash, accessHash);
      await store.close();
    }
  });
});
