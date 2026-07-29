const MAX_REDIRECT_URI_LENGTH = 2_048;
const MAX_CLIENT_NAME_LENGTH = 100;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]';
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
