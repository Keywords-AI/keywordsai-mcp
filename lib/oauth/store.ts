import type {
  AccessSession,
  AuthorizationCode,
  PendingAuthorization,
  RefreshSession,
} from './records.js';
import type { OAuthRealm } from './config.js';

export class SessionStoreUnavailableError extends Error {
  constructor(message = 'OAuth session store unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionStoreUnavailableError';
  }
}

export type StoredRecord<T> = {
  value: T;
  serialized: string;
};

export type CodeExchangeInput = {
  realm: OAuthRealm;
  codeHash: string;
  expectedCodeSerialized: string;
  accessTokenHash: string;
  accessSession: AccessSession;
  accessTtlSeconds: number;
  refreshTokenHash: string;
  refreshSession: RefreshSession;
  refreshTtlSeconds: number;
};

export type AuthorizationCompletionInput = {
  realm: OAuthRealm;
  transactionHash: string;
  expectedTransactionSerialized: string;
  codeHash: string;
  code: AuthorizationCode;
  codeTtlSeconds: number;
};

export type RefreshRotationInput = {
  realm: OAuthRealm;
  oldRefreshTokenHash: string;
  expectedRefreshSerialized: string;
  oldAccessTokenHash: string;
  newAccessTokenHash: string;
  newAccessSession: AccessSession;
  accessTtlSeconds: number;
  newRefreshTokenHash: string;
  newRefreshSession: RefreshSession;
  refreshTtlSeconds: number;
  lockOwner: string;
};

export interface SessionStore {
  createPendingAuthorization(
    realm: OAuthRealm,
    transactionHash: string,
    transaction: PendingAuthorization,
    ttlSeconds: number,
  ): Promise<void>;
  getPendingAuthorization(
    realm: OAuthRealm,
    transactionHash: string,
  ): Promise<StoredRecord<PendingAuthorization> | null>;
  replacePendingAuthorization(
    realm: OAuthRealm,
    transactionHash: string,
    expectedSerialized: string,
    transaction: PendingAuthorization,
    ttlSeconds: number,
  ): Promise<boolean>;
  deletePendingAuthorization(realm: OAuthRealm, transactionHash: string): Promise<void>;
  createAuthorizationCode(
    realm: OAuthRealm,
    codeHash: string,
    code: AuthorizationCode,
    ttlSeconds: number,
  ): Promise<void>;
  completeAuthorization(input: AuthorizationCompletionInput): Promise<boolean>;
  getAuthorizationCode(
    realm: OAuthRealm,
    codeHash: string,
  ): Promise<StoredRecord<AuthorizationCode> | null>;
  exchangeAuthorizationCode(input: CodeExchangeInput): Promise<boolean>;
  getAccessSession(
    realm: OAuthRealm,
    accessTokenHash: string,
  ): Promise<StoredRecord<AccessSession> | null>;
  deleteAccessSession(realm: OAuthRealm, accessTokenHash: string): Promise<void>;
  getRefreshSession(
    realm: OAuthRealm,
    refreshTokenHash: string,
  ): Promise<StoredRecord<RefreshSession> | null>;
  acquireRefreshLock(
    realm: OAuthRealm,
    sessionId: string,
    owner: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  releaseRefreshLock(realm: OAuthRealm, sessionId: string, owner: string): Promise<void>;
  rotateRefreshSession(input: RefreshRotationInput): Promise<boolean>;
  deleteRefreshSession(
    realm: OAuthRealm,
    refreshTokenHash: string,
    accessTokenHash: string,
  ): Promise<void>;
  incrementRateLimit(
    realm: OAuthRealm,
    bucket: string,
    subjectHash: string,
    windowSeconds: number,
  ): Promise<number>;
  close?(): Promise<void>;
}
