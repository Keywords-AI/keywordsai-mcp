import {
  parseAccessSession,
  parseAuthorizationCode,
  parsePendingAuthorization,
  parseRefreshSession,
  type AccessSession,
  type AuthorizationCode,
  type PendingAuthorization,
  type RefreshSession,
} from './records.js';
import type { OAuthRealm } from './config.js';
import type {
  AuthorizationCompletionInput,
  CodeExchangeInput,
  RefreshRotationInput,
  SessionStore,
  StoredRecord,
} from './store.js';
import { StoreKeys } from './store-keys.js';

type Entry = {
  value: string;
  expiresAt: number;
};

export class InMemorySessionStore implements SessionStore {
  private readonly entries = new Map<string, Entry>();
  private readonly keys: StoreKeys;
  private operationCount = 0;

  constructor(
    prefix = 'respan-mcp:test:',
    private readonly now: () => number = Date.now,
  ) {
    this.keys = new StoreKeys(prefix);
  }

  get operations(): number {
    return this.operationCount;
  }

  resetOperationCount(): void {
    this.operationCount = 0;
  }

  private read(key: string): string | null {
    this.operationCount += 1;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  private write(key: string, value: unknown, ttlSeconds: number): void {
    this.operationCount += 1;
    this.entries.set(key, {
      value: JSON.stringify(value),
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  private remove(...keys: string[]): void {
    this.operationCount += 1;
    for (const key of keys) this.entries.delete(key);
  }

  async createPendingAuthorization(
    realm: OAuthRealm,
    transactionHash: string,
    transaction: PendingAuthorization,
    ttlSeconds: number,
  ): Promise<void> {
    this.write(this.keys.pending(realm, transactionHash), transaction, ttlSeconds);
  }

  async getPendingAuthorization(
    realm: OAuthRealm,
    transactionHash: string,
  ): Promise<StoredRecord<PendingAuthorization> | null> {
    const serialized = this.read(this.keys.pending(realm, transactionHash));
    if (!serialized) return null;
    return { value: parsePendingAuthorization(JSON.parse(serialized)), serialized };
  }

  async replacePendingAuthorization(
    realm: OAuthRealm,
    transactionHash: string,
    expectedSerialized: string,
    transaction: PendingAuthorization,
    ttlSeconds: number,
  ): Promise<boolean> {
    const key = this.keys.pending(realm, transactionHash);
    const current = this.read(key);
    if (current !== expectedSerialized) return false;
    this.write(key, transaction, ttlSeconds);
    return true;
  }

  async deletePendingAuthorization(
    realm: OAuthRealm,
    transactionHash: string,
  ): Promise<void> {
    this.remove(this.keys.pending(realm, transactionHash));
  }

  async createAuthorizationCode(
    realm: OAuthRealm,
    codeHash: string,
    code: AuthorizationCode,
    ttlSeconds: number,
  ): Promise<void> {
    this.write(this.keys.code(realm, codeHash), code, ttlSeconds);
  }

  async completeAuthorization(input: AuthorizationCompletionInput): Promise<boolean> {
    const transactionKey = this.keys.pending(input.realm, input.transactionHash);
    const current = this.read(transactionKey);
    if (current !== input.expectedTransactionSerialized) return false;
    this.write(
      this.keys.code(input.realm, input.codeHash),
      input.code,
      input.codeTtlSeconds,
    );
    this.remove(transactionKey);
    return true;
  }

  async getAuthorizationCode(
    realm: OAuthRealm,
    codeHash: string,
  ): Promise<StoredRecord<AuthorizationCode> | null> {
    const serialized = this.read(this.keys.code(realm, codeHash));
    if (!serialized) return null;
    return { value: parseAuthorizationCode(JSON.parse(serialized)), serialized };
  }

  async exchangeAuthorizationCode(input: CodeExchangeInput): Promise<boolean> {
    const codeKey = this.keys.code(input.realm, input.codeHash);
    const current = this.read(codeKey);
    if (current !== input.expectedCodeSerialized) return false;
    this.write(
      this.keys.access(input.realm, input.accessTokenHash),
      input.accessSession,
      input.accessTtlSeconds,
    );
    this.write(
      this.keys.refresh(input.realm, input.refreshTokenHash),
      input.refreshSession,
      input.refreshTtlSeconds,
    );
    this.remove(codeKey);
    return true;
  }

  async getAccessSession(
    realm: OAuthRealm,
    accessTokenHash: string,
  ): Promise<StoredRecord<AccessSession> | null> {
    const serialized = this.read(this.keys.access(realm, accessTokenHash));
    if (!serialized) return null;
    return { value: parseAccessSession(JSON.parse(serialized)), serialized };
  }

  async deleteAccessSession(realm: OAuthRealm, accessTokenHash: string): Promise<void> {
    this.remove(this.keys.access(realm, accessTokenHash));
  }

  async getRefreshSession(
    realm: OAuthRealm,
    refreshTokenHash: string,
  ): Promise<StoredRecord<RefreshSession> | null> {
    const serialized = this.read(this.keys.refresh(realm, refreshTokenHash));
    if (!serialized) return null;
    return { value: parseRefreshSession(JSON.parse(serialized)), serialized };
  }

  async acquireRefreshLock(
    realm: OAuthRealm,
    sessionId: string,
    owner: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const key = this.keys.refreshLock(realm, sessionId);
    if (this.read(key) !== null) return false;
    this.write(key, owner, ttlSeconds);
    return true;
  }

  async releaseRefreshLock(
    realm: OAuthRealm,
    sessionId: string,
    owner: string,
  ): Promise<void> {
    const key = this.keys.refreshLock(realm, sessionId);
    const current = this.read(key);
    if (current === JSON.stringify(owner)) this.remove(key);
  }

  async rotateRefreshSession(input: RefreshRotationInput): Promise<boolean> {
    const oldRefreshKey = this.keys.refresh(input.realm, input.oldRefreshTokenHash);
    const lockKey = this.keys.refreshLock(input.realm, input.newRefreshSession.sessionId);
    const currentRefresh = this.read(oldRefreshKey);
    const lockOwner = this.read(lockKey);
    if (
      currentRefresh !== input.expectedRefreshSerialized
      || lockOwner !== JSON.stringify(input.lockOwner)
    ) {
      return false;
    }
    this.write(
      this.keys.access(input.realm, input.newAccessTokenHash),
      input.newAccessSession,
      input.accessTtlSeconds,
    );
    this.write(
      this.keys.refresh(input.realm, input.newRefreshTokenHash),
      input.newRefreshSession,
      input.refreshTtlSeconds,
    );
    this.remove(
      oldRefreshKey,
      this.keys.access(input.realm, input.oldAccessTokenHash),
      lockKey,
    );
    return true;
  }

  async deleteRefreshSession(
    realm: OAuthRealm,
    refreshTokenHash: string,
    accessTokenHash: string,
  ): Promise<void> {
    this.remove(
      this.keys.refresh(realm, refreshTokenHash),
      this.keys.access(realm, accessTokenHash),
    );
  }

  async incrementRateLimit(
    realm: OAuthRealm,
    bucket: string,
    subjectHash: string,
    windowSeconds: number,
  ): Promise<number> {
    const key = this.keys.rateLimit(realm, bucket, subjectHash);
    const current = this.read(key);
    const count = current ? Number.parseInt(current, 10) + 1 : 1;
    this.operationCount += 1;
    this.entries.set(key, {
      value: String(count),
      expiresAt: this.now() + windowSeconds * 1000,
    });
    return count;
  }
}
