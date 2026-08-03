import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { OAuthRealm } from './config.js';
import { getOAuthConfig } from './config.js';
import { OAuthBroker } from './broker.js';
import { OAuthRequestError, RateLimitError } from './errors.js';
import { enforceRateLimit } from './rate-limit.js';
import { getSessionStore } from './store-factory.js';
import { SessionStoreUnavailableError } from './store.js';
import { verifyClientRegistration } from '../shared/oauth.js';
import { browserCsrfCookie } from './browser-csrf.js';

function requestIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

export function createAuthorizeHandler(realm: OAuthRealm) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'MCP-Protocol-Version');
      return res.status(204).end();
    }
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const {
      response_type,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
      resource,
    } = req.query as Record<string, string | undefined>;
    if (response_type !== 'code') {
      return res.status(400).json({ error: 'unsupported_response_type' });
    }
    if (
      !client_id
      || !redirect_uri
      || !code_challenge
      || !state
      || code_challenge_method !== 'S256'
      || !/^[A-Za-z0-9_-]{43,128}$/.test(code_challenge)
    ) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    if (!client_id.startsWith('enc_')) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    try {
      const registration = verifyClientRegistration(client_id.slice(4));
      if (!registration.redirectUris.includes(redirect_uri)) {
        return res.status(400).json({ error: 'invalid_request' });
      }
      const config = getOAuthConfig();
      const store = getSessionStore();
      await enforceRateLimit(
        store,
        realm,
        'authorize-ip',
        requestIp(req),
        30,
      );
      await enforceRateLimit(store, realm, 'authorize-client', client_id, 30);
      const broker = new OAuthBroker({ config, store });
      const started = await broker.startAuthorization({
        realm,
        clientId: client_id,
        clientName: registration.clientName,
        redirectUri: redirect_uri,
        clientState: state,
        codeChallenge: code_challenge,
        resource,
      });
      const loginParams = new URLSearchParams({
        mode: 'oauth',
        transaction_id: started.transactionToken,
        csrf: started.browserCsrf,
        ...(realm === 'enterprise' ? { enterprise: 'true' } : {}),
      });
      res.setHeader(
        'Set-Cookie',
        browserCsrfCookie(
          started.transactionToken,
          started.browserCsrf,
          config.publicBaseUrl.startsWith('https://'),
        ),
      );
      return res.redirect(302, `/login?${loginParams.toString()}`);
    } catch (error) {
      if (error instanceof RateLimitError) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'temporarily_unavailable' });
      }
      if (
        error instanceof SessionStoreUnavailableError
        || (error instanceof OAuthRequestError && error.oauthError === 'temporarily_unavailable')
      ) {
        res.setHeader('Retry-After', '5');
        return res.status(503).json({ error: 'temporarily_unavailable' });
      }
      if (error instanceof OAuthRequestError) {
        return res.status(error.statusCode).json({ error: error.oauthError });
      }
      return res.status(400).json({ error: 'invalid_request' });
    }
  };
}
