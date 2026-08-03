import { createHash, randomBytes } from 'node:crypto';
import type { OAuthConfig, OAuthRealm } from './config.js';
import {
  decryptCredential,
  encryptCredential,
  generateOpaqueToken,
  hashBrowserCsrf,
  hashOpaqueToken,
  readJwtExpiryMs,
  securelyMatchesHash,
} from './crypto.js';
import { emitOAuthEvent } from './events.js';
import { InvalidAccessTokenError, OAuthRequestError } from './errors.js';
import {
  RECORD_VERSION,
  type AccessSession,
  type AuthorizationCode,
  type PendingAuthorization,
  type RefreshSession,
} from './records.js';
import {
  SessionStoreUnavailableError,
  type SessionStore,
} from './store.js';

export type BrokerDependencies = {
  config: OAuthConfig;
  store: SessionStore;
  now?: () => number;
  fetch?: typeof fetch;
};

export type TokenPair = {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
};

export type ResolvedAccess = {
  backendAccessJwt: string;
  accessTokenHash: string;
  session: AccessSession;
};

type BackendTokenPair = {
  access: string;
  refresh: string;
};

type AuthorizationInput = {
  realm: OAuthRealm;
  clientId: string;
  clientName: string;
  redirectUri: string;
  clientState: string;
  codeChallenge: string;
  resource?: string;
};

type CompleteAuthorizationInput = {
  realm: OAuthRealm;
  transactionToken: string;
  browserCsrf: string;
  backendAccessJwt: string;
  backendRefreshJwt: string;
};

function remainingSeconds(expiresAt: number, now: number): number {
  return Math.floor((expiresAt - now) / 1000);
}

function requireBackendExpiry(
  jwt: string,
  fallbackExpiresAt: number,
  now: number,
): number {
  const expiresAt = readJwtExpiryMs(jwt) ?? fallbackExpiresAt;
  if (expiresAt <= now) {
    throw new OAuthRequestError('invalid_grant', 400, 'Backend credential expired');
  }
  return expiresAt;
}

function tokenPairRecords(
  config: OAuthConfig,
  code: AuthorizationCode,
  now: number,
  generation = 0,
): {
  pair: TokenPair;
  accessTokenHash: string;
  accessSession: AccessSession;
  accessTtlSeconds: number;
  refreshTokenHash: string;
  refreshSession: RefreshSession;
  refreshTtlSeconds: number;
} {
  const accessToken = generateOpaqueToken('mcp_at_');
  const refreshToken = generateOpaqueToken('mcp_rt_');
  const accessTokenHash = hashOpaqueToken(accessToken);
  const refreshTokenHash = hashOpaqueToken(refreshToken);
  const sessionId = randomBytes(32).toString('base64url');
  const accessTtlSeconds = Math.min(
    config.accessTokenTtlSeconds,
    remainingSeconds(code.backendAccessExpiresAt, now),
  );
  const refreshTtlSeconds = Math.min(
    config.refreshSessionTtlSeconds,
    remainingSeconds(code.backendRefreshExpiresAt, now),
  );
  if (accessTtlSeconds <= 0 || refreshTtlSeconds <= 0) {
    throw new OAuthRequestError('invalid_grant', 400, 'Backend credential expired');
  }
  const accessSession: AccessSession = {
    version: RECORD_VERSION,
    tokenType: 'access',
    sessionId,
    clientId: code.clientId,
    realm: code.realm,
    resource: code.resource,
    encryptedBackendAccessJwt: code.encryptedBackendAccessJwt,
    backendAccessExpiresAt: code.backendAccessExpiresAt,
    issuedAt: now,
    expiresAt: now + accessTtlSeconds * 1000,
  };
  const refreshSession: RefreshSession = {
    version: RECORD_VERSION,
    tokenType: 'refresh',
    sessionId,
    generation,
    clientId: code.clientId,
    realm: code.realm,
    resource: code.resource,
    currentAccessTokenHash: accessTokenHash,
    encryptedBackendRefreshJwt: code.encryptedBackendRefreshJwt,
    backendRefreshExpiresAt: code.backendRefreshExpiresAt,
    issuedAt: now,
    absoluteExpiresAt: now + refreshTtlSeconds * 1000,
  };
  return {
    pair: {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: accessTtlSeconds,
    },
    accessTokenHash,
    accessSession,
    accessTtlSeconds,
    refreshTokenHash,
    refreshSession,
    refreshTtlSeconds,
  };
}

export class OAuthBroker {
  private readonly now: () => number;
  private readonly fetch: typeof fetch;

  constructor(private readonly dependencies: BrokerDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.fetch = dependencies.fetch ?? globalThis.fetch;
  }

  async startAuthorization(input: AuthorizationInput): Promise<{
    transactionToken: string;
    browserCsrf: string;
    transaction: PendingAuthorization;
  }> {
    const realmConfig = this.dependencies.config.realms[input.realm];
    const resource = input.resource || realmConfig.resource;
    if (resource !== realmConfig.resource) {
      throw new OAuthRequestError('invalid_request', 400, 'Invalid OAuth resource');
    }
    const now = this.now();
    const transactionToken = generateOpaqueToken('mcp_tx_');
    const browserCsrf = randomBytes(32).toString('base64url');
    const transaction: PendingAuthorization = {
      version: RECORD_VERSION,
      clientId: input.clientId,
      clientName: input.clientName,
      redirectUri: input.redirectUri,
      clientState: input.clientState,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: 'S256',
      realm: input.realm,
      resource,
      browserCsrfHash: hashBrowserCsrf(browserCsrf),
      isApproved: false,
      createdAt: now,
      expiresAt: now + this.dependencies.config.authorizationTransactionTtlSeconds * 1000,
    };
    await this.dependencies.store.createPendingAuthorization(
      input.realm,
      hashOpaqueToken(transactionToken),
      transaction,
      this.dependencies.config.authorizationTransactionTtlSeconds,
    );
    emitOAuthEvent(
      'authorization_started',
      input.realm,
      hashOpaqueToken(transactionToken),
    );
    return { transactionToken, browserCsrf, transaction };
  }

  async getPendingAuthorization(
    realm: OAuthRealm,
    transactionToken: string,
    browserCsrf: string,
  ) {
    if (!transactionToken.startsWith('mcp_tx_')) {
      throw new OAuthRequestError('invalid_request', 400, 'Invalid authorization transaction');
    }
    const stored = await this.dependencies.store.getPendingAuthorization(
      realm,
      hashOpaqueToken(transactionToken),
    );
    if (
      !stored
      || stored.value.expiresAt <= this.now()
      || !securelyMatchesHash(browserCsrf, stored.value.browserCsrfHash)
      || stored.value.realm !== realm
      || stored.value.resource !== this.dependencies.config.realms[realm].resource
    ) {
      throw new OAuthRequestError('invalid_request', 400, 'Invalid authorization transaction');
    }
    return stored;
  }

  async approveAuthorization(
    realm: OAuthRealm,
    transactionToken: string,
    browserCsrf: string,
    encryptedBackendCookies?: string,
  ): Promise<PendingAuthorization> {
    const stored = await this.getPendingAuthorization(
      realm,
      transactionToken,
      browserCsrf,
    );
    const now = this.now();
    const approved: PendingAuthorization = {
      ...stored.value,
      isApproved: true,
      approvedAt: now,
      ...(encryptedBackendCookies ? { encryptedBackendCookies } : {}),
    };
    const ttlSeconds = Math.max(1, remainingSeconds(stored.value.expiresAt, now));
    const replaced = await this.dependencies.store.replacePendingAuthorization(
      realm,
      hashOpaqueToken(transactionToken),
      stored.serialized,
      approved,
      ttlSeconds,
    );
    if (!replaced) {
      throw new OAuthRequestError('invalid_request', 400, 'Authorization transaction changed');
    }
    return approved;
  }

  async completeAuthorization(input: CompleteAuthorizationInput): Promise<string> {
    const stored = await this.getPendingAuthorization(
      input.realm,
      input.transactionToken,
      input.browserCsrf,
    );
    if (!stored.value.isApproved) {
      throw new OAuthRequestError('access_denied', 400, 'Client approval required');
    }
    const now = this.now();
    const backendAccessExpiresAt = requireBackendExpiry(
      input.backendAccessJwt,
      now + 14_400 * 1000,
      now,
    );
    const backendRefreshExpiresAt = requireBackendExpiry(
      input.backendRefreshJwt,
      now + this.dependencies.config.refreshSessionTtlSeconds * 1000,
      now,
    );
    const codeToken = generateOpaqueToken('mcp_ac_');
    const code: AuthorizationCode = {
      version: RECORD_VERSION,
      clientId: stored.value.clientId,
      redirectUri: stored.value.redirectUri,
      codeChallenge: stored.value.codeChallenge,
      realm: stored.value.realm,
      resource: stored.value.resource,
      encryptedBackendAccessJwt: encryptCredential(
        input.backendAccessJwt,
        this.dependencies.config.secret,
      ),
      backendAccessExpiresAt,
      encryptedBackendRefreshJwt: encryptCredential(
        input.backendRefreshJwt,
        this.dependencies.config.secret,
      ),
      backendRefreshExpiresAt,
      createdAt: now,
      expiresAt: now + this.dependencies.config.authorizationCodeTtlSeconds * 1000,
    };
    const completed = await this.dependencies.store.completeAuthorization({
      realm: input.realm,
      transactionHash: hashOpaqueToken(input.transactionToken),
      expectedTransactionSerialized: stored.serialized,
      codeHash: hashOpaqueToken(codeToken),
      code,
      codeTtlSeconds: this.dependencies.config.authorizationCodeTtlSeconds,
    });
    if (!completed) {
      throw new OAuthRequestError('invalid_grant', 400, 'Authorization transaction already used');
    }
    const callback = new URL(stored.value.redirectUri);
    callback.searchParams.set('code', codeToken);
    callback.searchParams.set('state', stored.value.clientState);
    emitOAuthEvent(
      'authorization_completed',
      input.realm,
      hashOpaqueToken(codeToken),
    );
    return callback.toString();
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
    resource?: string;
  }): Promise<TokenPair> {
    if (!input.code.startsWith('mcp_ac_')) {
      throw new OAuthRequestError('invalid_grant', 400, 'Invalid authorization code');
    }
    const codeHash = hashOpaqueToken(input.code);
    let stored;
    try {
      stored = await this.findAuthorizationCode(codeHash);
    } catch (error) {
      if (error instanceof SessionStoreUnavailableError) throw error;
      emitOAuthEvent('code_exchange_failed', 'platform', codeHash);
      throw new OAuthRequestError('invalid_grant', 400, 'Invalid authorization code');
    }
    if (!stored || stored.value.expiresAt <= this.now()) {
      throw new OAuthRequestError('invalid_grant', 400, 'Invalid authorization code');
    }
    const code = stored.value;
    const expectedChallenge = createHash('sha256')
      .update(input.codeVerifier)
      .digest('base64url');
    if (
      expectedChallenge !== code.codeChallenge
      || input.clientId !== code.clientId
      || input.redirectUri !== code.redirectUri
      || (input.resource !== undefined && input.resource !== code.resource)
      || code.resource !== this.dependencies.config.realms[code.realm].resource
    ) {
      throw new OAuthRequestError('invalid_grant', 400, 'Authorization code binding mismatch');
    }
    const records = tokenPairRecords(
      this.dependencies.config,
      code,
      this.now(),
    );
    const exchanged = await this.dependencies.store.exchangeAuthorizationCode({
      realm: code.realm,
      codeHash,
      expectedCodeSerialized: stored.serialized,
      accessTokenHash: records.accessTokenHash,
      accessSession: records.accessSession,
      accessTtlSeconds: records.accessTtlSeconds,
      refreshTokenHash: records.refreshTokenHash,
      refreshSession: records.refreshSession,
      refreshTtlSeconds: records.refreshTtlSeconds,
    });
    if (!exchanged) {
      emitOAuthEvent('code_exchange_failed', code.realm, codeHash);
      throw new OAuthRequestError('invalid_grant', 400, 'Authorization code already used');
    }
    emitOAuthEvent('code_exchange_succeeded', code.realm, codeHash);
    return records.pair;
  }

  private async findAuthorizationCode(codeHash: string) {
    const platform = await this.dependencies.store.getAuthorizationCode(
      'platform',
      codeHash,
    );
    if (platform) return platform;
    return this.dependencies.store.getAuthorizationCode('enterprise', codeHash);
  }

  async resolveAccessToken(
    realm: OAuthRealm,
    accessToken: string,
  ): Promise<ResolvedAccess> {
    if (!accessToken.startsWith('mcp_at_')) throw new InvalidAccessTokenError();
    const accessTokenHash = hashOpaqueToken(accessToken);
    let stored;
    try {
      stored = await this.dependencies.store.getAccessSession(
        realm,
        accessTokenHash,
      );
    } catch (error) {
      emitOAuthEvent('session_store_failed', realm, accessTokenHash);
      throw error;
    }
    const now = this.now();
    if (
      !stored
      || stored.value.expiresAt <= now
      || stored.value.backendAccessExpiresAt <= now
      || stored.value.realm !== realm
      || stored.value.resource !== this.dependencies.config.realms[realm].resource
    ) {
      emitOAuthEvent(
        stored && (
          stored.value.realm !== realm
          || stored.value.resource !== this.dependencies.config.realms[realm].resource
        )
          ? 'audience_mismatch'
          : 'invalid_access_token',
        realm,
        accessTokenHash,
      );
      throw new InvalidAccessTokenError();
    }
    return {
      backendAccessJwt: decryptCredential(
        stored.value.encryptedBackendAccessJwt,
        this.dependencies.config.secret,
      ),
      accessTokenHash,
      session: stored.value,
    };
  }

  async refresh(input: {
    refreshToken: string;
    clientId: string;
    resource?: string;
  }): Promise<TokenPair> {
    if (!input.refreshToken.startsWith('mcp_rt_')) {
      throw new OAuthRequestError('invalid_grant', 400, 'Invalid refresh token');
    }
    const refreshTokenHash = hashOpaqueToken(input.refreshToken);
    const found = await this.findRefreshSession(refreshTokenHash);
    if (!found) {
      emitOAuthEvent('refresh_reuse', 'platform', refreshTokenHash);
      throw new OAuthRequestError('invalid_grant', 400, 'Invalid refresh token');
    }
    const { realm, stored } = found;
    const record = stored.value;
    const now = this.now();
    if (
      record.absoluteExpiresAt <= now
      || record.backendRefreshExpiresAt <= now
      || record.clientId !== input.clientId
      || record.resource !== this.dependencies.config.realms[realm].resource
      || (input.resource !== undefined && input.resource !== record.resource)
    ) {
      await this.dependencies.store.deleteRefreshSession(
        realm,
        refreshTokenHash,
        record.currentAccessTokenHash,
      );
      throw new OAuthRequestError('invalid_grant', 400, 'Invalid refresh token');
    }
    const lockOwner = randomBytes(32).toString('base64url');
    const isLocked = await this.dependencies.store.acquireRefreshLock(
      realm,
      record.sessionId,
      lockOwner,
      this.dependencies.config.refreshLockTtlSeconds,
    );
    if (!isLocked) {
      throw new OAuthRequestError(
        'temporarily_unavailable',
        503,
        'Refresh already in progress',
      );
    }
    try {
      const backendRefreshJwt = decryptCredential(
        record.encryptedBackendRefreshJwt,
        this.dependencies.config.secret,
      );
      const backendTokens = await this.refreshBackend(
        realm,
        backendRefreshJwt,
      );
      const backendAccessExpiresAt = requireBackendExpiry(
        backendTokens.access,
        now + 14_400 * 1000,
        now,
      );
      const replacementRefresh = backendTokens.refresh || backendRefreshJwt;
      const backendRefreshExpiresAt = Math.min(
        record.backendRefreshExpiresAt,
        requireBackendExpiry(
          replacementRefresh,
          record.backendRefreshExpiresAt,
          now,
        ),
      );
      const codeLike: AuthorizationCode = {
        version: RECORD_VERSION,
        clientId: record.clientId,
        redirectUri: 'https://unused.invalid/callback',
        codeChallenge: 'x'.repeat(43),
        realm,
        resource: record.resource,
        encryptedBackendAccessJwt: encryptCredential(
          backendTokens.access,
          this.dependencies.config.secret,
        ),
        backendAccessExpiresAt,
        encryptedBackendRefreshJwt: encryptCredential(
          replacementRefresh,
          this.dependencies.config.secret,
        ),
        backendRefreshExpiresAt,
        createdAt: now,
        expiresAt: now,
      };
      const rotated = tokenPairRecords(
        this.dependencies.config,
        codeLike,
        now,
        record.generation + 1,
      );
      rotated.refreshSession = {
        ...rotated.refreshSession,
        sessionId: record.sessionId,
        absoluteExpiresAt: record.absoluteExpiresAt,
      };
      rotated.accessSession = {
        ...rotated.accessSession,
        sessionId: record.sessionId,
      };
      rotated.refreshTtlSeconds = remainingSeconds(record.absoluteExpiresAt, now);
      const didRotate = await this.dependencies.store.rotateRefreshSession({
        realm,
        oldRefreshTokenHash: refreshTokenHash,
        expectedRefreshSerialized: stored.serialized,
        oldAccessTokenHash: record.currentAccessTokenHash,
        newAccessTokenHash: rotated.accessTokenHash,
        newAccessSession: rotated.accessSession,
        accessTtlSeconds: rotated.accessTtlSeconds,
        newRefreshTokenHash: rotated.refreshTokenHash,
        newRefreshSession: rotated.refreshSession,
        refreshTtlSeconds: rotated.refreshTtlSeconds,
        lockOwner,
      });
      if (!didRotate) {
        throw new OAuthRequestError('invalid_grant', 400, 'Refresh token already used');
      }
      emitOAuthEvent('refresh_succeeded', realm, refreshTokenHash);
      return rotated.pair;
    } catch (error) {
      if (error instanceof OAuthRequestError) {
        if (
          error.oauthError === 'invalid_grant'
          && error.message === 'Backend refresh rejected'
        ) {
          await this.dependencies.store.deleteRefreshSession(
            realm,
            refreshTokenHash,
            record.currentAccessTokenHash,
          );
        }
        throw error;
      }
      if (error instanceof SessionStoreUnavailableError) {
        throw new OAuthRequestError(
          'temporarily_unavailable',
          503,
          'Session store unavailable',
        );
      }
      throw error;
    } finally {
      try {
        await this.dependencies.store.releaseRefreshLock(
          realm,
          record.sessionId,
          lockOwner,
        );
      } catch {
        // The lock has a short TTL and successful rotation releases it atomically.
      }
    }
  }

  private async findRefreshSession(refreshTokenHash: string) {
    const platform = await this.dependencies.store.getRefreshSession(
      'platform',
      refreshTokenHash,
    );
    if (platform) return { realm: 'platform' as const, stored: platform };
    const enterprise = await this.dependencies.store.getRefreshSession(
      'enterprise',
      refreshTokenHash,
    );
    return enterprise
      ? { realm: 'enterprise' as const, stored: enterprise }
      : null;
  }

  private async refreshBackend(
    realm: OAuthRealm,
    refreshJwt: string,
  ): Promise<BackendTokenPair> {
    const baseUrl = this.dependencies.config.realms[realm].backendBaseUrl;
    const origin = baseUrl.replace(/\/api\/?$/, '');
    let response: Response;
    try {
      response = await this.fetch(`${origin}/auth/jwt/refresh/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: refreshJwt }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      emitOAuthEvent('refresh_backend_failed', realm);
      throw new OAuthRequestError(
        'temporarily_unavailable',
        503,
        'Authentication backend unavailable',
      );
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new OAuthRequestError('invalid_grant', 400, 'Backend refresh rejected');
    }
    if (response.status >= 500) {
      emitOAuthEvent('refresh_backend_failed', realm);
      throw new OAuthRequestError(
        'temporarily_unavailable',
        503,
        'Authentication backend unavailable',
      );
    }
    if (!response.ok) {
      throw new OAuthRequestError('invalid_grant', 400, 'Backend refresh rejected');
    }
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.access !== 'string') {
      throw new OAuthRequestError(
        'temporarily_unavailable',
        503,
        'Invalid authentication backend response',
      );
    }
    return {
      access: body.access,
      refresh: typeof body.refresh === 'string' ? body.refresh : '',
    };
  }
}
