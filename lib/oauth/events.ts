import type { OAuthRealm } from './config.js';

export type OAuthEvent =
  | 'authorization_started'
  | 'authorization_completed'
  | 'code_exchange_succeeded'
  | 'code_exchange_failed'
  | 'refresh_succeeded'
  | 'refresh_reuse'
  | 'refresh_backend_failed'
  | 'invalid_access_token'
  | 'audience_mismatch'
  | 'session_store_failed';

export function emitOAuthEvent(
  event: OAuthEvent,
  realm: OAuthRealm,
  identifierHash?: string,
): void {
  console.info(JSON.stringify({
    event,
    realm,
    ...(identifierHash ? { identifierHash } : {}),
  }));
}
