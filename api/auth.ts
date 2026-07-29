import type { VercelRequest, VercelResponse } from '@vercel/node';
import { OAuthBroker } from '../lib/oauth/broker.js';
import { getOAuthConfig, type OAuthRealm } from '../lib/oauth/config.js';
import { decryptCredential, encryptCredential } from '../lib/oauth/crypto.js';
import { OAuthRequestError, RateLimitError } from '../lib/oauth/errors.js';
import { enforceRateLimit } from '../lib/oauth/rate-limit.js';
import { getSessionStore } from '../lib/oauth/store-factory.js';
import { SessionStoreUnavailableError } from '../lib/oauth/store.js';
import {
  clearBrowserCsrfCookie,
  hasValidBrowserCsrfCookie,
} from '../lib/oauth/browser-csrf.js';
import {
  DisallowedBackendUrlError,
  resolveAllowedBackendUrl,
} from '../lib/shared/backend-url.js';

const DEFAULT_BASE_URL = 'https://api.respan.ai/api';

function requestIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

function backendOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/api\/?$/, '');
}

function oauthContext(body: Record<string, unknown>): {
  realm: OAuthRealm;
  transactionId: string;
  csrf: string;
} | null {
  if (
    typeof body.oauth_transaction !== 'string'
    || typeof body.oauth_csrf !== 'string'
  ) {
    return null;
  }
  return {
    realm: body.enterprise === true ? 'enterprise' : 'platform',
    transactionId: body.oauth_transaction,
    csrf: body.oauth_csrf,
  };
}

function oauthErrorResponse(
  res: VercelResponse,
  error: unknown,
): VercelResponse {
  if (
    error instanceof SessionStoreUnavailableError
    || (error instanceof OAuthRequestError && error.oauthError === 'temporarily_unavailable')
  ) {
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: 'temporarily_unavailable' });
  }
  if (error instanceof RateLimitError) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'temporarily_unavailable' });
  }
  if (error instanceof OAuthRequestError) {
    return res.status(error.statusCode).json({ error: error.oauthError });
  }
  return res.status(502).json({ error: 'temporarily_unavailable' });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const {
    action,
    email,
    password,
    refresh,
    redirect_uri,
    code,
    state,
    _backend_cookies,
  } = body;
  const validActions = ['login', 'refresh', 'google_url', 'google_jwt'];
  if (typeof action !== 'string' || !validActions.includes(action)) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  const context = oauthContext(body);
  const hasOAuthFields = body.oauth_transaction !== undefined
    || body.oauth_csrf !== undefined;
  if ((hasOAuthFields && !context) || (context && action === 'refresh')) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  const config = context ? getOAuthConfig() : undefined;
  const store = context ? getSessionStore() : undefined;
  const broker = context && config && store
    ? new OAuthBroker({ config, store })
    : undefined;

  const requestedBaseUrl = (req.headers['respan-api-base-url'] as string)
    || (req.headers['keywords-api-base-url'] as string)
    || undefined;
  const defaultBaseUrl = body.enterprise === true
    ? process.env.RESPAN_ENTERPRISE_API_BASE_URL || 'https://endpoint.respan.ai/api'
    : process.env.RESPAN_API_BASE_URL || DEFAULT_BASE_URL;
  let baseUrl: string;
  try {
    baseUrl = resolveAllowedBackendUrl(requestedBaseUrl, defaultBaseUrl);
  } catch (error) {
    if (error instanceof DisallowedBackendUrlError) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    throw error;
  }
  if (context && config) {
    baseUrl = config.realms[context.realm].backendBaseUrl;
  }
  const origin = backendOrigin(baseUrl);

  try {
    if (context && store && broker) {
      if (!hasValidBrowserCsrfCookie(
        req,
        context.transactionId,
        context.csrf,
        config!.publicBaseUrl.startsWith('https://'),
      )) {
        throw new OAuthRequestError('invalid_request', 400, 'Invalid browser CSRF binding');
      }
      await enforceRateLimit(
        store,
        context.realm,
        'login-ip',
        requestIp(req),
        10,
      );
    }

    if (action === 'google_url') {
      if (typeof redirect_uri !== 'string') {
        return res.status(400).json({ error: 'invalid_request' });
      }
      if (context && redirect_uri !== `${config!.publicBaseUrl}/login`) {
        return res.status(400).json({ error: 'invalid_request' });
      }
      const url = `${origin}/auth/o/google-oauth2/?redirect_uri=${encodeURIComponent(redirect_uri)}`;
      const response = await fetch(url, { method: 'GET', redirect: 'manual' });
      const setCookieHeaders = response.headers.getSetCookie?.() ?? [];
      const backendCookies = setCookieHeaders.map((cookie) => cookie.split(';')[0]).join('; ');
      const data = await response.json() as Record<string, unknown>;
      if (context && broker) {
        if (body.approve !== true) {
          throw new OAuthRequestError('access_denied', 400, 'Client approval required');
        }
        await broker.approveAuthorization(
          context.realm,
          context.transactionId,
          context.csrf,
          encryptCredential(backendCookies, config!.secret),
        );
        const { _backend_cookies: ignored, ...safeData } = data;
        void ignored;
        return res.status(response.status).json(safeData);
      }
      return res.status(response.status).json({
        ...data,
        _backend_cookies: backendCookies,
      });
    }

    if (action === 'google_jwt') {
      if (typeof code !== 'string' || typeof state !== 'string') {
        return res.status(400).json({ error: 'invalid_request' });
      }
      let backendCookies = typeof _backend_cookies === 'string'
        ? _backend_cookies
        : '';
      if (context && broker) {
        const pending = await broker.getPendingAuthorization(
          context.realm,
          context.transactionId,
          context.csrf,
        );
        if (!pending.value.isApproved || !pending.value.encryptedBackendCookies) {
          throw new OAuthRequestError('access_denied', 400, 'Client approval required');
        }
        backendCookies = decryptCredential(
          pending.value.encryptedBackendCookies,
          config!.secret,
        );
      }
      const params = new URLSearchParams({ code, state });
      const csrfMatch = backendCookies.match(/csrftoken=([^;,\s]+)/);
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (backendCookies) headers.Cookie = backendCookies;
      if (csrfMatch?.[1]) headers['X-CSRFToken'] = csrfMatch[1];
      const response = await fetch(`${origin}/auth/o/google-oauth2/?${params}`, {
        method: 'POST',
        headers,
      });
      const data = await response.json() as Record<string, unknown>;
      if (context && broker && response.ok) {
        if (typeof data.access !== 'string' || typeof data.refresh !== 'string') {
          throw new OAuthRequestError(
            'temporarily_unavailable',
            503,
            'Invalid authentication backend response',
          );
        }
        const redirectUrl = await broker.completeAuthorization({
          realm: context.realm,
          transactionToken: context.transactionId,
          browserCsrf: context.csrf,
          backendAccessJwt: data.access,
          backendRefreshJwt: data.refresh,
        });
        res.setHeader(
          'Set-Cookie',
          clearBrowserCsrfCookie(
            context.transactionId,
            config!.publicBaseUrl.startsWith('https://'),
          ),
        );
        return res.status(200).json({ redirect_url: redirectUrl });
      }
      return res.status(response.status).json(data);
    }

    let backendUrl: string;
    let backendBody: Record<string, string>;
    if (action === 'login') {
      if (typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'invalid_request' });
      }
      if (context && body.approve !== true) {
        throw new OAuthRequestError('access_denied', 400, 'Client approval required');
      }
      if (context && broker) {
        await broker.approveAuthorization(
          context.realm,
          context.transactionId,
          context.csrf,
        );
      }
      backendUrl = `${origin}/auth/jwt/create/`;
      backendBody = { email, password };
    } else {
      if (typeof refresh !== 'string') {
        return res.status(400).json({ error: 'invalid_request' });
      }
      backendUrl = `${origin}/auth/jwt/refresh/`;
      backendBody = { refresh };
    }

    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backendBody),
    });
    const data = await response.json() as Record<string, unknown>;
    if (context && broker && action === 'login' && response.ok) {
      if (typeof data.access !== 'string' || typeof data.refresh !== 'string') {
        throw new OAuthRequestError(
          'temporarily_unavailable',
          503,
          'Invalid authentication backend response',
        );
      }
      const redirectUrl = await broker.completeAuthorization({
        realm: context.realm,
        transactionToken: context.transactionId,
        browserCsrf: context.csrf,
        backendAccessJwt: data.access,
        backendRefreshJwt: data.refresh,
      });
      res.setHeader(
        'Set-Cookie',
        clearBrowserCsrfCookie(
          context.transactionId,
          config!.publicBaseUrl.startsWith('https://'),
        ),
      );
      return res.status(200).json({ redirect_url: redirectUrl });
    }
    return res.status(response.status).json(data);
  } catch (error) {
    if (context) return oauthErrorResponse(res, error);
    console.error('Auth proxy request failed');
    return res.status(502).json({ error: 'Failed to reach authentication backend.' });
  }
}
