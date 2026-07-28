import type { OAuthRealm } from './config.js';

export class StoreKeys {
  constructor(private readonly prefix: string) {}

  pending(realm: OAuthRealm, hash: string): string {
    return `${this.prefix}${realm}:auth-tx:${hash}`;
  }

  code(realm: OAuthRealm, hash: string): string {
    return `${this.prefix}${realm}:auth-code:${hash}`;
  }

  access(realm: OAuthRealm, hash: string): string {
    return `${this.prefix}${realm}:access:${hash}`;
  }

  refresh(realm: OAuthRealm, hash: string): string {
    return `${this.prefix}${realm}:refresh:${hash}`;
  }

  refreshLock(realm: OAuthRealm, sessionId: string): string {
    return `${this.prefix}${realm}:refresh-lock:${sessionId}`;
  }

  rateLimit(realm: OAuthRealm, bucket: string, subjectHash: string): string {
    return `${this.prefix}${realm}:rate:${bucket}:${subjectHash}`;
  }
}
