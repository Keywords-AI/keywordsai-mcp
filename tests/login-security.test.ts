import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const loginHtml = readFileSync(
  new URL('../public/login.html', import.meta.url),
  'utf8',
);
const vercelConfig = JSON.parse(readFileSync(
  new URL('../vercel.json', import.meta.url),
  'utf8',
)) as {
  headers: Array<{
    source: string;
    headers: Array<{ key: string; value: string }>;
  }>;
};

describe('OAuth login browser defenses', () => {
  it('never assigns a server-provided callback directly to location.href', () => {
    expect(loginHtml).not.toContain('window.location.href = data.redirect_url');
    expect(loginHtml).toContain('navigateToOAuthRedirect(data.redirect_url)');
  });

  it('pins the exact inline login script in the CSP', () => {
    const script = loginHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const hash = `sha256-${createHash('sha256').update(script!).digest('base64')}`;
    const loginHeaders = vercelConfig.headers.find(
      ({ source }) => source === '/login',
    )?.headers;
    const csp = loginHeaders?.find(
      ({ key }) => key === 'Content-Security-Policy',
    )?.value;
    expect(csp).toContain(`script-src '${hash}'`);
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
