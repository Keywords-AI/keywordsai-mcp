import type { OAuthRealm } from './config.js';
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
import {
  SessionStoreUnavailableError,
  type AuthorizationCompletionInput,
  type CodeExchangeInput,
  type RefreshRotationInput,
  type SessionStore,
  type StoredRecord,
} from './store.js';
import { StoreKeys } from './store-keys.js';

export interface RedisCommands {
  get(key: string): Promise<string | null>;
  setEx(key: string, ttlSeconds: number, value: string): Promise<void>;
  setNxEx(key: string, ttlSeconds: number, value: string): Promise<boolean>;
  del(keys: string[]): Promise<void>;
  eval(script: string, keys: string[], args: string[]): Promise<number>;
  incrementWithExpiry(key: string, windowSeconds: number): Promise<number>;
  close?(): Promise<void>;
}

const COMPARE_AND_REPLACE = `
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

const EXCHANGE_CODE = `
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[5])
redis.call('DEL', KEYS[1])
return 1
`;

const COMPLETE_AUTHORIZATION = `
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('DEL', KEYS[1])
return 1
`;

const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const ROTATE_REFRESH = `
local refresh = redis.call('GET', KEYS[1])
local lockOwner = redis.call('GET', KEYS[2])
if not refresh or refresh ~= ARGV[1] or lockOwner ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[4], ARGV[5], 'EX', ARGV[6])
redis.call('DEL', KEYS[1], KEYS[2], KEYS[5])
return 1
`;

export class ScriptedRedisSessionStore implements SessionStore {
  private readonly keys: StoreKeys;

  constructor(
    prefix: string,
    private readonly redis: RedisCommands,
  ) {
    this.keys = new StoreKeys(prefix);
  }

  private async command<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new SessionStoreUnavailableError(undefined, { cause: error });
    }
  }

  private async getParsed<T>(
    key: string,
    parse: (value: unknown) => T,
  ): Promise<StoredRecord<T> | null> {
    const serialized = await this.command(() => this.redis.get(key));
    if (!serialized) return null;
    return { value: parse(JSON.parse(serialized)), serialized };
  }

  async createPendingAuthorization(
    realm: OAuthRealm,
    transactionHash: string,
    transaction: PendingAuthorization,
    ttlSeconds: number,
  ): Promise<void> {
    await this.command(() => this.redis.setEx(
      this.keys.pending(realm, transactionHash),
      ttlSeconds,
      JSON.stringify(transaction),
    ));
  }

  getPendingAuthorization(
    realm: OAuthRealm,
    transactionHash: string,
  ): Promise<StoredRecord<PendingAuthorization> | null> {
    return this.getParsed(
      this.keys.pending(realm, transactionHash),
      parsePendingAuthorization,
    );
  }

  async replacePendingAuthorization(
    realm: OAuthRealm,
    transactionHash: string,
    expectedSerialized: string,
    transaction: PendingAuthorization,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.command(() => this.redis.eval(
      COMPARE_AND_REPLACE,
      [this.keys.pending(realm, transactionHash)],
      [expectedSerialized, JSON.stringify(transaction), String(ttlSeconds)],
    ));
    return result === 1;
  }

  async deletePendingAuthorization(
    realm: OAuthRealm,
    transactionHash: string,
  ): Promise<void> {
    await this.command(() => this.redis.del([
      this.keys.pending(realm, transactionHash),
    ]));
  }

  async createAuthorizationCode(
    realm: OAuthRealm,
    codeHash: string,
    code: AuthorizationCode,
    ttlSeconds: number,
  ): Promise<void> {
    await this.command(() => this.redis.setEx(
      this.keys.code(realm, codeHash),
      ttlSeconds,
      JSON.stringify(code),
    ));
  }

  async completeAuthorization(input: AuthorizationCompletionInput): Promise<boolean> {
    const result = await this.command(() => this.redis.eval(
      COMPLETE_AUTHORIZATION,
      [
        this.keys.pending(input.realm, input.transactionHash),
        this.keys.code(input.realm, input.codeHash),
      ],
      [
        input.expectedTransactionSerialized,
        JSON.stringify(input.code),
        String(input.codeTtlSeconds),
      ],
    ));
    return result === 1;
  }

  getAuthorizationCode(
    realm: OAuthRealm,
    codeHash: string,
  ): Promise<StoredRecord<AuthorizationCode> | null> {
    return this.getParsed(
      this.keys.code(realm, codeHash),
      parseAuthorizationCode,
    );
  }

  async exchangeAuthorizationCode(input: CodeExchangeInput): Promise<boolean> {
    const result = await this.command(() => this.redis.eval(
      EXCHANGE_CODE,
      [
        this.keys.code(input.realm, input.codeHash),
        this.keys.access(input.realm, input.accessTokenHash),
        this.keys.refresh(input.realm, input.refreshTokenHash),
      ],
      [
        input.expectedCodeSerialized,
        JSON.stringify(input.accessSession),
        String(input.accessTtlSeconds),
        JSON.stringify(input.refreshSession),
        String(input.refreshTtlSeconds),
      ],
    ));
    return result === 1;
  }

  getAccessSession(
    realm: OAuthRealm,
    accessTokenHash: string,
  ): Promise<StoredRecord<AccessSession> | null> {
    return this.getParsed(
      this.keys.access(realm, accessTokenHash),
      parseAccessSession,
    );
  }

  async deleteAccessSession(
    realm: OAuthRealm,
    accessTokenHash: string,
  ): Promise<void> {
    await this.command(() => this.redis.del([
      this.keys.access(realm, accessTokenHash),
    ]));
  }

  getRefreshSession(
    realm: OAuthRealm,
    refreshTokenHash: string,
  ): Promise<StoredRecord<RefreshSession> | null> {
    return this.getParsed(
      this.keys.refresh(realm, refreshTokenHash),
      parseRefreshSession,
    );
  }

  acquireRefreshLock(
    realm: OAuthRealm,
    sessionId: string,
    owner: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    return this.command(() => this.redis.setNxEx(
      this.keys.refreshLock(realm, sessionId),
      ttlSeconds,
      owner,
    ));
  }

  async releaseRefreshLock(
    realm: OAuthRealm,
    sessionId: string,
    owner: string,
  ): Promise<void> {
    await this.command(() => this.redis.eval(
      RELEASE_LOCK,
      [this.keys.refreshLock(realm, sessionId)],
      [owner],
    ));
  }

  async rotateRefreshSession(input: RefreshRotationInput): Promise<boolean> {
    const result = await this.command(() => this.redis.eval(
      ROTATE_REFRESH,
      [
        this.keys.refresh(input.realm, input.oldRefreshTokenHash),
        this.keys.refreshLock(input.realm, input.newRefreshSession.sessionId),
        this.keys.access(input.realm, input.newAccessTokenHash),
        this.keys.refresh(input.realm, input.newRefreshTokenHash),
        this.keys.access(input.realm, input.oldAccessTokenHash),
      ],
      [
        input.expectedRefreshSerialized,
        input.lockOwner,
        JSON.stringify(input.newAccessSession),
        String(input.accessTtlSeconds),
        JSON.stringify(input.newRefreshSession),
        String(input.refreshTtlSeconds),
      ],
    ));
    return result === 1;
  }

  async deleteRefreshSession(
    realm: OAuthRealm,
    refreshTokenHash: string,
    accessTokenHash: string,
  ): Promise<void> {
    await this.command(() => this.redis.del([
      this.keys.refresh(realm, refreshTokenHash),
      this.keys.access(realm, accessTokenHash),
    ]));
  }

  incrementRateLimit(
    realm: OAuthRealm,
    bucket: string,
    subjectHash: string,
    windowSeconds: number,
  ): Promise<number> {
    return this.command(() => this.redis.incrementWithExpiry(
      this.keys.rateLimit(realm, bucket, subjectHash),
      windowSeconds,
    ));
  }

  async close(): Promise<void> {
    await this.redis.close?.();
  }
}
