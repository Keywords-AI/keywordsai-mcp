import type { VercelRequest } from '@vercel/node';
import {
  securelyMatchesHash,
  hashBrowserCsrf,
  hashOpaqueToken,
} from './crypto.js';

const SECURE_COOKIE_PREFIX = '__Host-respan_mcp_oauth_csrf';
const LOCAL_COOKIE_PREFIX = 'respan_mcp_oauth_csrf';

function cookieName(transactionToken: string, isSecure: boolean): string {
  const prefix = isSecure ? SECURE_COOKIE_PREFIX : LOCAL_COOKIE_PREFIX;
  return `${prefix}_${hashOpaqueToken(transactionToken)}`;
}

function cookieValue(req: VercelRequest, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [cookie, ...value] = part.trim().split('=');
    if (cookie === name) {
      return value.join('=');
    }
  }
  return undefined;
}

export function hasValidBrowserCsrfCookie(
  req: VercelRequest,
  transactionToken: string,
  browserCsrf: string,
  isSecure: boolean,
): boolean {
  const cookie = cookieValue(
    req,
    cookieName(transactionToken, isSecure),
  );
  return Boolean(
    cookie
    && securelyMatchesHash(cookie, hashBrowserCsrf(browserCsrf)),
  );
}

export function browserCsrfCookie(
  transactionToken: string,
  browserCsrf: string,
  isSecure: boolean,
): string {
  return [
    `${cookieName(transactionToken, isSecure)}=${browserCsrf}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=600',
    ...(isSecure ? ['Secure'] : []),
  ].join('; ');
}

export function clearBrowserCsrfCookie(
  transactionToken: string,
  isSecure: boolean,
): string {
  return [
    `${cookieName(transactionToken, isSecure)}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
    ...(isSecure ? ['Secure'] : []),
  ].join('; ');
}
