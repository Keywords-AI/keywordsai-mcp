import type { OAuthRealm } from './config.js';
import { hashOpaqueToken } from './crypto.js';
import { RateLimitError } from './errors.js';
import type { SessionStore } from './store.js';

export async function enforceRateLimit(
  store: SessionStore,
  realm: OAuthRealm,
  bucket: string,
  subject: string,
  limit: number,
  windowSeconds = 60,
): Promise<void> {
  const count = await store.incrementRateLimit(
    realm,
    bucket,
    hashOpaqueToken(subject),
    windowSeconds,
  );
  if (count > limit) throw new RateLimitError();
}
