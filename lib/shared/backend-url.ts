export const PLATFORM_BACKEND = 'https://api.respan.ai/api';
export const ENTERPRISE_BACKEND = 'https://endpoint.respan.ai/api';

/**
 * The backend base URLs this deployment routes to, after env overrides.
 * Reported by `/health` and `server_info`; never derived from the request.
 */
export function backendTargets(): { platform: string; enterprise: string } {
  return {
    platform: process.env.RESPAN_API_BASE_URL || PLATFORM_BACKEND,
    enterprise: process.env.RESPAN_ENTERPRISE_API_BASE_URL || ENTERPRISE_BACKEND,
  };
}

export class DisallowedBackendUrlError extends Error {
  constructor() {
    super('Backend URL is not allowlisted');
    this.name = 'DisallowedBackendUrlError';
  }
}

function normalizeBackendUrl(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    throw new DisallowedBackendUrlError();
  }
  return parsed.toString().replace(/\/+$/, '');
}

function allowedBackendUrls(defaultBaseUrl: string): Set<string> {
  return new Set([
    PLATFORM_BACKEND,
    ENTERPRISE_BACKEND,
    defaultBaseUrl,
    process.env.RESPAN_API_BASE_URL,
    process.env.RESPAN_ENTERPRISE_API_BASE_URL,
  ].filter((value): value is string => Boolean(value)).map((value) => (
    normalizeBackendUrl(value)
  )));
}

export function resolveAllowedBackendUrl(
  requestedBaseUrl: string | undefined,
  defaultBaseUrl: string,
): string {
  const normalizedDefault = normalizeBackendUrl(defaultBaseUrl);
  if (!requestedBaseUrl) return normalizedDefault;

  let normalizedRequested: string;
  try {
    normalizedRequested = normalizeBackendUrl(requestedBaseUrl);
  } catch {
    throw new DisallowedBackendUrlError();
  }
  if (!allowedBackendUrls(defaultBaseUrl).has(normalizedRequested)) {
    throw new DisallowedBackendUrlError();
  }
  return normalizedRequested;
}
