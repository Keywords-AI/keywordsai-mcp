const PLATFORM_BACKEND = 'https://api.respan.ai/api';
const ENTERPRISE_BACKEND = 'https://endpoint.respan.ai/api';

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
