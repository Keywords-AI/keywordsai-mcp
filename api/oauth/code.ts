import type { VercelRequest, VercelResponse } from '@vercel/node';
import { OAuthBroker } from '../../lib/oauth/broker.js';
import { getOAuthConfig, type OAuthRealm } from '../../lib/oauth/config.js';
import { OAuthRequestError } from '../../lib/oauth/errors.js';
import { hashOpaqueToken } from '../../lib/oauth/crypto.js';
import { getSessionStore } from '../../lib/oauth/store-factory.js';
import { SessionStoreUnavailableError } from '../../lib/oauth/store.js';
import {
  clearBrowserCsrfCookie,
  hasValidBrowserCsrfCookie,
} from '../../lib/oauth/browser-csrf.js';

function getRealm(req: VercelRequest): OAuthRealm {
  return req.query.enterprise === 'true' ? 'enterprise' : 'platform';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const transactionId = typeof req.query.transaction_id === 'string'
    ? req.query.transaction_id
    : '';
  const csrf = typeof req.query.csrf === 'string' ? req.query.csrf : '';
  if (!transactionId || !csrf) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  const realm = getRealm(req);
  try {
    const config = getOAuthConfig();
    if (!hasValidBrowserCsrfCookie(req, csrf)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const store = getSessionStore();
    const broker = new OAuthBroker({ config, store });
    const pending = await broker.getPendingAuthorization(
      realm,
      transactionId,
      csrf,
    );
    if (req.method === 'DELETE') {
      await store.deletePendingAuthorization(realm, hashOpaqueToken(transactionId));
      const callback = new URL(pending.value.redirectUri);
      callback.searchParams.set('error', 'access_denied');
      callback.searchParams.set('state', pending.value.clientState);
      res.setHeader(
        'Set-Cookie',
        clearBrowserCsrfCookie(config.publicBaseUrl.startsWith('https://')),
      );
      return res.status(200).json({ redirect_url: callback.toString() });
    }
    return res.status(200).json({
      client_name: pending.value.clientName,
      redirect_uri: pending.value.redirectUri,
      resource: pending.value.resource,
    });
  } catch (error) {
    if (error instanceof SessionStoreUnavailableError) {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
    if (error instanceof OAuthRequestError) {
      return res.status(error.statusCode).json({ error: error.oauthError });
    }
    return res.status(400).json({ error: 'invalid_request' });
  }
}
