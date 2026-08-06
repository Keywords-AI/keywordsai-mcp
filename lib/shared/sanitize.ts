/**
 * Credential masking for tool output.
 *
 * Port of the backend's `_sanitize_output` (admin/mcp_server/core.py). It was
 * added there after `integration_list` returned a full `aws_secret_access_key`
 * into model context. The same endpoints are reachable from this package, so
 * the masking has to travel with them.
 */

const SENSITIVE_SUBSTRINGS = [
  'secret',
  'token',
  'api_key',
  'apikey',
  'access_key',
  'credential',
  'password',
  'private_key',
  'client_secret',
  'authorization',
];

const SENSITIVE_EXACT = new Set([
  'key',
  'aws_secret_access_key',
  'aws_access_key_id',
  'openai_api_key',
  'anthropic_api_key',
  'azure_api_key',
]);

function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase();
  if (SENSITIVE_EXACT.has(lowered)) return true;
  return SENSITIVE_SUBSTRINGS.some(fragment => lowered.includes(fragment));
}

/** Keep a short prefix so a value stays identifiable without being usable. */
function maskValue(value: string, showPrefix: number): string {
  if (value.length <= showPrefix) return '***';
  return `${value.slice(0, showPrefix)}...***`;
}

/**
 * Recursively mask credential-shaped values. Returns a new structure; the
 * input is never mutated.
 */
export function sanitizeOutput(data: unknown, showPrefix = 4): unknown {
  if (Array.isArray(data)) {
    return data.map(item => sanitizeOutput(item, showPrefix));
  }
  if (data !== null && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (isSensitiveKey(key) && typeof value === 'string' && value) {
        out[key] = maskValue(value, showPrefix);
      } else {
        out[key] = sanitizeOutput(value, showPrefix);
      }
    }
    return out;
  }
  return data;
}
