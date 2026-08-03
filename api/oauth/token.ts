import type { VercelRequest, VercelResponse } from '@vercel/node';
import { OAuthBroker } from '../../lib/oauth/broker.js';
import { getOAuthConfig } from '../../lib/oauth/config.js';
import { OAuthRequestError, RateLimitError } from '../../lib/oauth/errors.js';
import { enforceRateLimit } from '../../lib/oauth/rate-limit.js';
import { getSessionStore } from '../../lib/oauth/store-factory.js';
import { SessionStoreUnavailableError } from '../../lib/oauth/store.js';

function parseBody(req: VercelRequest): Record<string, string> {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    if (typeof req.body === 'string') {
      return Object.fromEntries(new URLSearchParams(req.body));
    }
    return req.body || {};
  }
  return req.body || {};
}

function requestIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

function sendOAuthError(
  res: VercelResponse,
  error: string,
  statusCode: number,
): VercelResponse {
  if (statusCode === 503 || statusCode === 429) {
    res.setHeader('Retry-After', statusCode === 429 ? '60' : '5');
  }
  return res.status(statusCode).json({ error });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, MCP-Protocol-Version');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return sendOAuthError(res, 'invalid_request', 405);
  }

  const params = parseBody(req);
  const config = getOAuthConfig();
  const store = getSessionStore();
  const broker = new OAuthBroker({ config, store });
  try {
    await enforceRateLimit(
      store,
      'platform',
      'token-ip',
      requestIp(req),
      60,
    );
    if (params.client_id) {
      await enforceRateLimit(
        store,
        'platform',
        'token-client',
        params.client_id,
        60,
      );
    }

    if (params.grant_type === 'authorization_code') {
      if (
        !params.code
        || !params.code_verifier
        || !params.client_id
        || !params.redirect_uri
      ) {
        return sendOAuthError(res, 'invalid_request', 400);
      }
      const pair = await broker.exchangeAuthorizationCode({
        code: params.code,
        codeVerifier: params.code_verifier,
        clientId: params.client_id,
        redirectUri: params.redirect_uri,
        resource: params.resource,
      });
      return res.status(200).json(pair);
    }

    if (params.grant_type === 'refresh_token') {
      if (!params.refresh_token || !params.client_id) {
        return sendOAuthError(res, 'invalid_request', 400);
      }
      const pair = await broker.refresh({
        refreshToken: params.refresh_token,
        clientId: params.client_id,
        resource: params.resource,
      });
      return res.status(200).json(pair);
    }

    return sendOAuthError(res, 'unsupported_grant_type', 400);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return sendOAuthError(res, 'temporarily_unavailable', 429);
    }
    if (error instanceof SessionStoreUnavailableError) {
      return sendOAuthError(res, 'temporarily_unavailable', 503);
    }
    if (error instanceof OAuthRequestError) {
      return sendOAuthError(res, error.oauthError, error.statusCode);
    }
    return sendOAuthError(res, 'temporarily_unavailable', 503);
  }
}
