import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isAllowedOAuthRedirectUri } from '../lib/oauth/redirect-uri.js';

// `public/login.html` re-implements the redirect-uri check in plain browser JS
// because it is served statically and cannot import the module. The two copies
// drifting is not hypothetical: the server side started accepting `localhost`
// while this page still rejected it, so Dynamic Client Registration succeeded
// and the flow then died at the final hop with "The OAuth callback destination
// is unsafe." These tests execute the page's own function and require it to
// agree with lib/oauth/redirect-uri.ts.

const loginHtml = readFileSync(
  fileURLToPath(new URL('../public/login.html', import.meta.url)),
  'utf8',
);

function extractClientValidator(): (target: string) => boolean {
  // Lazy up to the first `];` — the array itself contains a `]` in '[::1]'.
  const hosts = loginHtml.match(
    /const LOOPBACK_HOSTS = \[[\s\S]*?\];/,
  );
  const fn = loginHtml.match(
    /function isAllowedOAuthRedirect\(target\) \{[\s\S]*?\n {8}\}/,
  );
  if (!hosts || !fn) {
    throw new Error(
      'Could not find LOOPBACK_HOSTS / isAllowedOAuthRedirect in public/login.html. '
      + 'If they were renamed, update this test — do not delete it.',
    );
  }
  return new Function(
    `${hosts[0]}\n${fn[0]}\nreturn isAllowedOAuthRedirect;`,
  )() as (target: string) => boolean;
}

describe('login page redirect validation parity', () => {
  const isAllowedInBrowser = extractClientValidator();

  it.each([
    'https://client.example/oauth/callback',
    'https://client.example:8443/oauth/callback?source=mcp',
    'http://127.0.0.1:3199/callback',
    'http://[::1]:3199/callback',
    'http://localhost:3199/callback',
    'http://localhost.attacker.example/callback',
    'http://sub.localhost:3199/callback',
    'http://127.0.0.1.attacker.example/callback',
    'http://attacker.example/callback',
    'javascript:fetch("https://attacker.example")//',
    'data:text/html,<script>alert(1)</script>',
    'file:///tmp/oauth-code',
    'https://user:password@client.example/callback',
    'https://client.example/callback#fragment',
    '/relative/callback',
  ])('agrees with the server validator on %s', (value) => {
    expect(isAllowedInBrowser(value)).toBe(isAllowedOAuthRedirectUri(value));
  });

  it('accepts every loopback host the server accepts', () => {
    for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
      const uri = `http://${host}:8976/callback`;
      expect(isAllowedOAuthRedirectUri(uri)).toBe(true);
      expect(isAllowedInBrowser(uri)).toBe(true);
    }
  });
});
