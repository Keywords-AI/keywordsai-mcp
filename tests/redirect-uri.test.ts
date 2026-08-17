import { describe, expect, it } from 'vitest';
import {
  isAllowedOAuthRedirectUri,
  normalizeOAuthClientName,
  parseAllowedOAuthRedirectUri,
} from '../lib/oauth/redirect-uri.js';

describe('OAuth redirect URI validation', () => {
  it.each([
    'https://client.example/oauth/callback',
    'https://client.example:8443/oauth/callback?source=mcp',
    'http://127.0.0.1:3199/callback',
    'http://[::1]:3199/callback',
    'http://localhost:3199/callback',
  ])('allows secure or loopback callback %s', (value) => {
    expect(isAllowedOAuthRedirectUri(value)).toBe(true);
  });

  it.each([
    'javascript:fetch("https://attacker.example")//',
    'data:text/html,<script>alert(1)</script>',
    'file:///tmp/oauth-code',
    'http://attacker.example/callback',
    'http://localhost.attacker.example/callback',
    'http://sub.localhost:3199/callback',
    'http://127.0.0.1.attacker.example/callback',
    'https://user:password@client.example/callback',
    'https://client.example/callback#fragment',
    '/relative/callback',
  ])('rejects unsafe callback %s', (value) => {
    expect(isAllowedOAuthRedirectUri(value)).toBe(false);
  });

  it('rejects oversized callbacks', () => {
    expect(parseAllowedOAuthRedirectUri(
      `https://client.example/${'a'.repeat(2_100)}`,
    )).toBeNull();
  });

  it('removes control and bidirectional display characters from client names', () => {
    expect(normalizeOAuthClientName('  Official\u202eexe.Respan\u0000 Client  '))
      .toBe('Official exe.Respan Client');
    expect(normalizeOAuthClientName('')).toBe('Unnamed MCP client');
    expect(normalizeOAuthClientName('a'.repeat(120))).toHaveLength(100);
  });
});
