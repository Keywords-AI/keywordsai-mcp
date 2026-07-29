import type { VercelRequest } from '@vercel/node';
import { securelyMatchesHash, hashBrowserCsrf } from './crypto.js';

const SECURE_COOKIE_NAME = '__Host-respan_mcp_oauth_csrf';
const LOCAL_COOKIE_NAME = 'respan_mcp_oauth_csrf';

function cookieValue(req: VercelRequest): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SECURE_COOKIE_NAME || name === LOCAL_COOKIE_NAME) {
      return value.join('=');
    }
  }
  return undefined;
}

export function hasValidBrowserCsrfCookie(
  req: VercelRequest,
  browserCsrf: string,
): boolean {
  const cookie = cookieValue(req);
  return Boolean(
    cookie
    && securelyMatchesHash(cookie, hashBrowserCsrf(browserCsrf)),
  );
}

export function browserCsrfCookie(
  browserCsrf: string,
  isSecure: boolean,
): string {
  const cookieName = isSecure ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME;
  return [
    `${cookieName}=${browserCsrf}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=600',
    ...(isSecure ? ['Secure'] : []),
  ].join('; ');
}

export function clearBrowserCsrfCookie(isSecure: boolean): string {
  const cookieName = isSecure ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME;
  return [
    `${cookieName}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
    ...(isSecure ? ['Secure'] : []),
  ].join('; ');
}
