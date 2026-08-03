import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const TOKEN_ENTROPY_BYTES = 32;

export type OpaqueTokenPrefix = 'mcp_tx_' | 'mcp_ac_' | 'mcp_at_' | 'mcp_rt_';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function generateOpaqueToken(prefix: OpaqueTokenPrefix): string {
  return `${prefix}${randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url')}`;
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hashBrowserCsrf(value: string): string {
  return hashOpaqueToken(value);
}

export function securelyMatchesHash(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueToken(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function encryptCredential(credential: string, secret: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(credential, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

export function decryptCredential(encrypted: string, secret: string): string {
  const combined = Buffer.from(encrypted, 'base64url');
  if (combined.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid encrypted credential');
  }
  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

export function readJwtExpiryMs(jwt: string): number | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}
