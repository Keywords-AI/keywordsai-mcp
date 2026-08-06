import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RespanClient } from '@respan/respan-api';

export interface AuthConfig {
  token: string;
  baseUrl?: string;
}

export interface AuthenticatedClient {
  client: RespanClient;
  auth: string; // "Bearer <token>"
  baseUrl: string; // For endpoints not yet in the SDK
}

const DEFAULT_BASE_URL = 'https://api.respan.ai';

/**
 * Pins every request to the caller's own organization.
 *
 * This is a security invariant of this package, not a tuning knob. A token
 * presented here may belong to a Respan staff member, who would otherwise
 * resolve to is_superadmin() server-side and read across organizations through
 * SuperAdminMixin. The backend honours this header by forcing is_superadmin()
 * to false (utils/mixins/view_mixins.py), which only ever drops privilege.
 *
 * It must be sent on EVERY outbound call. Both transports below set it: the
 * generated SDK client via constructor headers, and rawFetch directly. Adding
 * a third transport without it reopens cross-org access.
 */
const OWN_ORG_SCOPE_HEADER = 'X-Respan-Agent-Scope';
const OWN_ORG_SCOPE_VALUE = 'own-org';

/**
 * Identifies traffic as coming from this server.
 *
 * This is a customer surface, so staff-owned credentials are not permitted and
 * the backend refuses them when they carry this header. The check cannot run
 * here: under API-key auth a caller cannot determine its own privilege level,
 * so the server marks its traffic and the backend decides.
 */
const CLIENT_ID_HEADER = 'X-Respan-Client';
const CLIENT_ID_VALUE = 'public-mcp';

/** Sent on every outbound request. See both comments above. */
export const OWN_ORG_SCOPE_HEADERS: Record<string, string> = {
  [OWN_ORG_SCOPE_HEADER]: OWN_ORG_SCOPE_VALUE,
  [CLIENT_ID_HEADER]: CLIENT_ID_VALUE,
};

export function createClient(auth: AuthConfig, baseUrl?: string): AuthenticatedClient {
  const resolvedBaseUrl = baseUrl || auth.baseUrl || DEFAULT_BASE_URL;
  return {
    client: new RespanClient({
      environment: resolvedBaseUrl,
      // Covers every SDK-backed tool. rawFetch sets the same header itself.
      headers: { ...OWN_ORG_SCOPE_HEADERS },
    }),
    auth: `Bearer ${auth.token}`,
    baseUrl: resolvedBaseUrl,
  };
}

/**
 * Raw fetch helper for endpoints not yet in the SDK.
 * Throws on non-2xx with the response body included.
 */
export async function rawFetch(
  client: AuthenticatedClient,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const url = new URL(path, client.baseUrl).toString();
  const res = await fetch(url, {
    method: init.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: client.auth,
      ...OWN_ORG_SCOPE_HEADERS,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

/**
 * Read credentials from ~/.respan/credentials.json (written by `respan login`).
 * Returns the active profile's token and baseUrl, or null if not available.
 */
function resolveAuthFromCredentialFile(): AuthConfig | null {
  try {
    const configDir = join(homedir(), '.respan');

    // Read active profile from config.json
    let activeProfile = 'default';
    try {
      const configRaw = readFileSync(join(configDir, 'config.json'), 'utf-8');
      const config = JSON.parse(configRaw);
      if (config.activeProfile) {
        activeProfile = config.activeProfile;
      }
    } catch {
      // No config file or invalid — use default profile
    }

    // Read credentials.json
    const credsRaw = readFileSync(join(configDir, 'credentials.json'), 'utf-8');
    const creds = JSON.parse(credsRaw);
    const credential = creds[activeProfile];
    if (!credential) return null;

    // Support both api_key and jwt credential types
    let token: string | undefined;
    if (credential.type === 'api_key' && credential.apiKey) {
      token = credential.apiKey;
    } else if (credential.type === 'jwt' && credential.accessToken) {
      token = credential.accessToken;
    }

    if (!token) return null;

    return {
      token,
      baseUrl: credential.baseUrl || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve auth from environment variables or credential file.
 * Priority: env var > credential file
 */
export function resolveAuthFromEnv(): AuthConfig | null {
  // 1. Environment variable (highest priority)
  const envToken = process.env.RESPAN_API_KEY;
  if (envToken) {
    return {
      token: envToken,
      baseUrl: process.env.RESPAN_API_BASE_URL || undefined,
    };
  }

  // 2. Credential file (~/.respan/credentials.json, written by `respan login`)
  return resolveAuthFromCredentialFile();
}

export function requireClient(client: AuthenticatedClient | null): AuthenticatedClient {
  if (!client) {
    throw new Error(
      'This tool requires authentication. Set RESPAN_API_KEY or run `respan login` to authenticate.'
    );
  }
  return client;
}
