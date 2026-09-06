import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getServerInfo } from '../lib/shared/server-info.js';
import { createToolServer } from '../lib/shared/tools.js';

/**
 * GET /health — unauthenticated deployment identity probe.
 *
 * Reports the deployed commit, deploy/boot timestamps, tool count, tool schema
 * fingerprint and backend targets so CI and operators can confirm the live
 * server picked up a change. Static metadata only: nothing from the request
 * is echoed and no secrets are included. The same payload is available to
 * agent sessions through the `server_info` MCP tool.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const info = await getServerInfo(() => createToolServer(null));
    return res.status(200).json({ ok: true, ...info });
  } catch (error) {
    console.error('Health probe failed', error instanceof Error ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Health probe failed' });
  }
}
