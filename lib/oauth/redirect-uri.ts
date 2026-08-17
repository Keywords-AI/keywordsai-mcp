const MAX_REDIRECT_URI_LENGTH = 2_048;
const MAX_CLIENT_NAME_LENGTH = 100;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

// `localhost` is accepted alongside the IP literals because every mainstream
// MCP client registers `http://localhost:<port>/callback` — Claude Code and the
// MCP Inspector both do — and rejecting the name fails Dynamic Client
// Registration before the browser flow can start. RFC 8252 section 7.3 prefers
// the IP literal (the name can be redirected via DNS or a hosts file), but
// section 8.3 requires the server to permit loopback redirects, and an attacker
// who can repoint `localhost` on the victim's machine already has local
// control. Exact match only: `localhost.attacker.example` and
// `sub.localhost` are not loopback and stay rejected.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

export function parseAllowedOAuthRedirectUri(value: string): URL | null {
  if (!value || value.length > MAX_REDIRECT_URI_LENGTH) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.hash || parsed.username || parsed.password) return null;
  if (parsed.protocol === 'https:' && parsed.hostname) return parsed;
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) {
    return parsed;
  }
  return null;
}

export function isAllowedOAuthRedirectUri(value: string): boolean {
  return parseAllowedOAuthRedirectUri(value) !== null;
}

export function normalizeOAuthClientName(value: unknown): string {
  if (typeof value !== 'string') return 'Unnamed MCP client';
  const normalized = value
    .replace(UNSAFE_DISPLAY_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CLIENT_NAME_LENGTH);
  return normalized || 'Unnamed MCP client';
}
