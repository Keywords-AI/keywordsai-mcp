import type { OAuthConfig } from './config.js';
import { getOAuthConfig } from './config.js';
import { InMemorySessionStore } from './memory-store.js';
import { createLocalRedisSessionStore } from './redis-store.js';
import type { SessionStore } from './store.js';
import { createUpstashSessionStore } from './upstash-store.js';

let cachedStore: SessionStore | undefined;

export function createSessionStore(config: OAuthConfig): SessionStore {
  if (config.sessionStore === 'memory') {
    return new InMemorySessionStore(config.redisKeyPrefix);
  }
  if (config.sessionStore === 'redis') {
    return createLocalRedisSessionStore(
      config.redisUrl!,
      config.redisKeyPrefix,
    );
  }
  return createUpstashSessionStore(
    config.upstashRedisRestUrl!,
    config.upstashRedisRestToken!,
    config.redisKeyPrefix,
  );
}

export function getSessionStore(): SessionStore {
  cachedStore ??= createSessionStore(getOAuthConfig());
  return cachedStore;
}

export async function resetSessionStoreForTests(): Promise<void> {
  await cachedStore?.close?.();
  cachedStore = undefined;
}

export function setSessionStoreForTests(store: SessionStore): void {
  cachedStore = store;
}
