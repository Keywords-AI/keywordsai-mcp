import { afterEach, describe, expect, it } from 'vitest';
import {
  DisallowedBackendUrlError,
  resolveAllowedBackendUrl,
} from '../lib/shared/backend-url.js';

const originalPlatformUrl = process.env.RESPAN_API_BASE_URL;
const originalEnterpriseUrl = process.env.RESPAN_ENTERPRISE_API_BASE_URL;

afterEach(() => {
  if (originalPlatformUrl === undefined) delete process.env.RESPAN_API_BASE_URL;
  else process.env.RESPAN_API_BASE_URL = originalPlatformUrl;
  if (originalEnterpriseUrl === undefined) {
    delete process.env.RESPAN_ENTERPRISE_API_BASE_URL;
  } else {
    process.env.RESPAN_ENTERPRISE_API_BASE_URL = originalEnterpriseUrl;
  }
});

describe('backend URL allowlist', () => {
  it('allows configured and canonical Respan backends', () => {
    process.env.RESPAN_API_BASE_URL = 'http://127.0.0.1:8000/api';
    expect(resolveAllowedBackendUrl(
      'http://127.0.0.1:8000/api/',
      'https://api.respan.ai/api',
    )).toBe('http://127.0.0.1:8000/api');
    expect(resolveAllowedBackendUrl(
      'https://endpoint.respan.ai/api',
      'https://api.respan.ai/api',
    )).toBe('https://endpoint.respan.ai/api');
  });

  it.each([
    'https://attacker.example/api',
    'http://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'https://user:password@api.respan.ai/api',
  ])('rejects unconfigured target %s', (value) => {
    expect(() => resolveAllowedBackendUrl(
      value,
      'https://api.respan.ai/api',
    )).toThrow(DisallowedBackendUrlError);
  });
});
