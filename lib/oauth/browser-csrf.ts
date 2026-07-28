import type { VercelRequest } from '@vercel/node';
import { securelyMatchesHash, hashBrowserCsrf } from './crypto.js';

const COOKIE_NAME = 'respan_mcp_oauth_csrf';

function cookieValue(req: VercelRequest): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE_NAME) return value.join('=');
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
  return [
    `${COOKIE_NAME}=${browserCsrf}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=600',
    ...(isSecure ? ['Secure'] : []),
  ].join('; ');
}

export function clearBrowserCsrfCookie(isSecure: boolean): string {
  return [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
    ...(isSecure ? ['Secure'] : []),
  ].join('; ');
}
