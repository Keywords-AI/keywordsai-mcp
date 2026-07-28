import { z } from 'zod';

export type OAuthRealm = 'platform' | 'enterprise';

export type RealmConfig = {
  realm: OAuthRealm;
  resource: string;
  authorizationPath: string;
  resourceMetadataPath: string;
  backendBaseUrl: string;
};

export type OAuthConfig = {
  publicBaseUrl: string;
  secret: string;
  accessTokenTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
  authorizationTransactionTtlSeconds: number;
  refreshSessionTtlSeconds: number;
  refreshLockTtlSeconds: number;
  redisKeyPrefix: string;
  sessionStore: 'memory' | 'redis' | 'upstash';
  redisUrl?: string;
  upstashRedisRestUrl?: string;
  upstashRedisRestToken?: string;
  realms: Record<OAuthRealm, RealmConfig>;
};

const envSchema = z.object({
  OAUTH_SECRET: z.string().min(32, 'OAUTH_SECRET must contain at least 32 characters'),
  OAUTH_SESSION_STORE: z.enum(['memory', 'redis', 'upstash']).default('upstash'),
  REDIS_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  MCP_PUBLIC_BASE_URL: z.string().url().default('https://mcp.respan.ai'),
  MCP_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(14_400).default(14_400),
  MCP_AUTHORIZATION_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(600),
  MCP_AUTHORIZATION_TRANSACTION_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(600),
  MCP_REFRESH_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(30 * 24 * 60 * 60).default(30 * 24 * 60 * 60),
  MCP_REFRESH_LOCK_TTL_SECONDS: z.coerce.number().int().min(5).max(60).default(30),
  MCP_REDIS_KEY_PREFIX: z.string().min(1).optional(),
  RESPAN_API_BASE_URL: z.string().url().default('https://api.respan.ai/api'),
  RESPAN_ENTERPRISE_API_BASE_URL: z.string().url().default('https://endpoint.respan.ai/api'),
  VERCEL_ENV: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

let cachedConfig: OAuthConfig | undefined;

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function loadOAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): OAuthConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid OAuth configuration: ${issues}`);
  }

  const values = parsed.data;
  if (values.OAUTH_SESSION_STORE === 'redis' && !values.REDIS_URL) {
    throw new Error('Invalid OAuth configuration: REDIS_URL is required for the redis session store');
  }
  if (
    values.OAUTH_SESSION_STORE === 'upstash'
    && (!values.UPSTASH_REDIS_REST_URL || !values.UPSTASH_REDIS_REST_TOKEN)
  ) {
    throw new Error(
      'Invalid OAuth configuration: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for the upstash session store',
    );
  }

  const publicBaseUrl = withoutTrailingSlash(values.MCP_PUBLIC_BASE_URL);
  const environment = values.VERCEL_ENV || values.NODE_ENV || 'development';
  const redisKeyPrefix = values.MCP_REDIS_KEY_PREFIX
    || `respan-mcp:${environment}:`;

  return {
    publicBaseUrl,
    secret: values.OAUTH_SECRET,
    accessTokenTtlSeconds: values.MCP_ACCESS_TOKEN_TTL_SECONDS,
    authorizationCodeTtlSeconds: values.MCP_AUTHORIZATION_CODE_TTL_SECONDS,
    authorizationTransactionTtlSeconds: values.MCP_AUTHORIZATION_TRANSACTION_TTL_SECONDS,
    refreshSessionTtlSeconds: values.MCP_REFRESH_SESSION_TTL_SECONDS,
    refreshLockTtlSeconds: values.MCP_REFRESH_LOCK_TTL_SECONDS,
    redisKeyPrefix,
    sessionStore: values.OAUTH_SESSION_STORE,
    redisUrl: values.REDIS_URL,
    upstashRedisRestUrl: values.UPSTASH_REDIS_REST_URL,
    upstashRedisRestToken: values.UPSTASH_REDIS_REST_TOKEN,
    realms: {
      platform: {
        realm: 'platform',
        resource: `${publicBaseUrl}/mcp`,
        authorizationPath: '/authorize',
        resourceMetadataPath: '/.well-known/oauth-protected-resource',
        backendBaseUrl: withoutTrailingSlash(values.RESPAN_API_BASE_URL),
      },
      enterprise: {
        realm: 'enterprise',
        resource: `${publicBaseUrl}/mcp/enterprise`,
        authorizationPath: '/authorize/enterprise',
        resourceMetadataPath: '/.well-known/oauth-protected-resource/enterprise',
        backendBaseUrl: withoutTrailingSlash(values.RESPAN_ENTERPRISE_API_BASE_URL),
      },
    },
  };
}

export function getOAuthConfig(): OAuthConfig {
  cachedConfig ??= loadOAuthConfig();
  return cachedConfig;
}

export function resetOAuthConfigForTests(): void {
  cachedConfig = undefined;
}

export function getRealmConfig(realm: OAuthRealm): RealmConfig {
  return getOAuthConfig().realms[realm];
}
