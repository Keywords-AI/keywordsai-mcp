import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes } from 'node:crypto';
import { createClientRegistration } from '../../lib/shared/oauth.js';
import { getSessionStore } from '../../lib/oauth/store-factory.js';
import { enforceRateLimit } from '../../lib/oauth/rate-limit.js';
import { RateLimitError } from '../../lib/oauth/errors.js';
import { SessionStoreUnavailableError } from '../../lib/oauth/store.js';
import {
  isAllowedOAuthRedirectUri,
  normalizeOAuthClientName,
} from '../../lib/oauth/redirect-uri.js';

const MAX_REDIRECT_URIS = 10;

function requestIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, MCP-Protocol-Version');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await enforceRateLimit(
      getSessionStore(),
      'platform',
      'register-ip',
      requestIp(req),
      20,
    );
    const { redirect_uris, client_name } = req.body || {};

    if (
      !Array.isArray(redirect_uris)
      || redirect_uris.length === 0
      || redirect_uris.length > MAX_REDIRECT_URIS
    ) {
      return res.status(400).json({ error: 'redirect_uris is required and must be a non-empty array' });
    }

    const uniqueRedirectUris = new Set<string>();
    for (const uri of redirect_uris) {
      if (
        typeof uri !== 'string'
        || !isAllowedOAuthRedirectUri(uri)
        || uniqueRedirectUris.has(uri)
      ) {
        return res.status(400).json({
          error: 'Each redirect_uri must be unique HTTPS or loopback HTTP without credentials or fragments',
        });
      }
      uniqueRedirectUris.add(uri);
    }

    const clientId = randomBytes(16).toString('hex');
    const normalizedClientName = normalizeOAuthClientName(client_name);
    const token = createClientRegistration(
      clientId,
      redirect_uris,
      normalizedClientName,
    );

    return res.status(201).json({
      client_id: `enc_${token}`,
      client_name: normalizedClientName,
      redirect_uris,
      token_endpoint_auth_method: 'none',
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'temporarily_unavailable' });
    }
    if (err instanceof SessionStoreUnavailableError) {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
    console.error('Registration failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
}
