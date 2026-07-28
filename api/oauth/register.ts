import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes } from 'node:crypto';
import { createClientRegistration } from '../../lib/shared/oauth.js';
import { getSessionStore } from '../../lib/oauth/store-factory.js';
import { enforceRateLimit } from '../../lib/oauth/rate-limit.js';
import { RateLimitError } from '../../lib/oauth/errors.js';
import { SessionStoreUnavailableError } from '../../lib/oauth/store.js';

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

    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({ error: 'redirect_uris is required and must be a non-empty array' });
    }

    for (const uri of redirect_uris) {
      if (typeof uri !== 'string') {
        return res.status(400).json({ error: 'Each redirect_uri must be a string' });
      }
      try {
        const parsed = new URL(uri);
        if (!parsed.protocol || parsed.hash) {
          return res.status(400).json({ error: 'Each redirect_uri must be an absolute URL without a fragment' });
        }
      } catch {
        return res.status(400).json({ error: 'Each redirect_uri must be an absolute URL without a fragment' });
      }
    }

    const clientId = randomBytes(16).toString('hex');
    const normalizedClientName = typeof client_name === 'string' && client_name.trim()
      ? client_name.trim().slice(0, 200)
      : 'Unnamed MCP client';
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
