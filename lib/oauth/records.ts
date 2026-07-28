import { z } from 'zod';

export const RECORD_VERSION = 1 as const;

const realmSchema = z.enum(['platform', 'enterprise']);
const timestampSchema = z.number().int().nonnegative();
const encryptedCredentialSchema = z.string().min(1);

export const pendingAuthorizationSchema = z.object({
  version: z.literal(RECORD_VERSION),
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  redirectUri: z.string().url(),
  clientState: z.string().min(1),
  codeChallenge: z.string().min(43).max(128),
  codeChallengeMethod: z.literal('S256'),
  realm: realmSchema,
  resource: z.string().url(),
  browserCsrfHash: z.string().length(64),
  isApproved: z.boolean(),
  approvedAt: timestampSchema.optional(),
  encryptedBackendCookies: encryptedCredentialSchema.optional(),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
});

export const authorizationCodeSchema = z.object({
  version: z.literal(RECORD_VERSION),
  clientId: z.string().min(1),
  redirectUri: z.string().url(),
  codeChallenge: z.string().min(43).max(128),
  realm: realmSchema,
  resource: z.string().url(),
  encryptedBackendAccessJwt: encryptedCredentialSchema,
  backendAccessExpiresAt: timestampSchema,
  encryptedBackendRefreshJwt: encryptedCredentialSchema,
  backendRefreshExpiresAt: timestampSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
});

export const accessSessionSchema = z.object({
  version: z.literal(RECORD_VERSION),
  tokenType: z.literal('access'),
  sessionId: z.string().min(1),
  clientId: z.string().min(1),
  realm: realmSchema,
  resource: z.string().url(),
  encryptedBackendAccessJwt: encryptedCredentialSchema,
  backendAccessExpiresAt: timestampSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
});

export const refreshSessionSchema = z.object({
  version: z.literal(RECORD_VERSION),
  tokenType: z.literal('refresh'),
  sessionId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  clientId: z.string().min(1),
  realm: realmSchema,
  resource: z.string().url(),
  currentAccessTokenHash: z.string().length(64),
  encryptedBackendRefreshJwt: encryptedCredentialSchema,
  backendRefreshExpiresAt: timestampSchema,
  issuedAt: timestampSchema,
  absoluteExpiresAt: timestampSchema,
});

export type PendingAuthorization = z.infer<typeof pendingAuthorizationSchema>;
export type AuthorizationCode = z.infer<typeof authorizationCodeSchema>;
export type AccessSession = z.infer<typeof accessSessionSchema>;
export type RefreshSession = z.infer<typeof refreshSessionSchema>;

export function parsePendingAuthorization(value: unknown): PendingAuthorization {
  return pendingAuthorizationSchema.parse(value);
}

export function parseAuthorizationCode(value: unknown): AuthorizationCode {
  return authorizationCodeSchema.parse(value);
}

export function parseAccessSession(value: unknown): AccessSession {
  return accessSessionSchema.parse(value);
}

export function parseRefreshSession(value: unknown): RefreshSession {
  return refreshSessionSchema.parse(value);
}
