import { config as loadEnv } from 'dotenv';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOAuthConfig } from '../lib/oauth/config.js';

type Handler = (req: any, res: any) => unknown | Promise<unknown>;

loadEnv({ path: '.env.local' });

try {
  getOAuthConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid OAuth configuration');
  process.exit(1);
}

const routeLoaders: Record<string, () => Promise<{ default: Handler }>> = {
  '/auth': () => import('../api/auth.js'),
  '/mcp': () => import('../api/mcp.js'),
  '/mcp/enterprise': () => import('../api/mcp/enterprise.js'),
  '/mcp/docs': () => import('../api/mcp/docs.js'),
  '/.well-known/oauth-protected-resource/mcp': () => import('../api/well-known/oauth-protected-resource.js'),
  '/.well-known/oauth-protected-resource/mcp/enterprise': () => import('../api/well-known/oauth-protected-resource-enterprise.js'),
  '/.well-known/oauth-protected-resource/enterprise': () => import('../api/well-known/oauth-protected-resource-enterprise.js'),
  '/.well-known/oauth-protected-resource': () => import('../api/well-known/oauth-protected-resource.js'),
  '/.well-known/oauth-authorization-server': () => import('../api/well-known/oauth-authorization-server.js'),
  '/enterprise-oauth/.well-known/oauth-authorization-server': () => import('../api/well-known/oauth-authorization-server-enterprise.js'),
  '/.well-known/oauth-authorization-server/enterprise-oauth': () => import('../api/well-known/oauth-authorization-server-enterprise.js'),
  '/register': () => import('../api/oauth/register.js'),
  '/authorize': () => import('../api/oauth/authorize.js'),
  '/authorize/enterprise': () => import('../api/oauth/authorize-enterprise.js'),
  '/oauth/code': () => import('../api/oauth/code.js'),
  '/token': () => import('../api/oauth/token.js'),
};

const repositoryRoot = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const publicRoot = join(repositoryRoot, 'public');
const builtClientRoot = join(repositoryRoot, 'dist', 'client');
const defaultPort = 3100;

function contentType(path: string): string {
  const extension = extname(path);
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

async function bodyFor(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) return JSON.parse(raw);
  if (type.includes('application/x-www-form-urlencoded')) return raw;
  return raw;
}

function responseAdapter(res: ServerResponse) {
  let statusCode = 200;
  const adapter: any = {
    get headersSent() {
      return res.headersSent;
    },
    setHeader(name: string, value: string | string[]) {
      res.setHeader(name, value);
      return adapter;
    },
    getHeader(name: string) {
      return res.getHeader(name);
    },
    status(code: number) {
      statusCode = code;
      return adapter;
    },
    json(value: unknown) {
      res.statusCode = statusCode;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
      return adapter;
    },
    send(value: unknown) {
      res.statusCode = statusCode;
      res.end(value as any);
      return adapter;
    },
    end(value?: unknown) {
      res.statusCode = statusCode;
      res.end(value as any);
      return adapter;
    },
    redirect(code: number, location: string) {
      res.statusCode = code;
      res.setHeader('Location', location);
      res.end();
      return adapter;
    },
  };
  return adapter;
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const requested = pathname === '/login'
    ? '/login.html'
    : pathname === '/' || pathname === '/docs'
      ? '/index.html'
      : pathname;
  for (const root of [publicRoot, builtClientRoot]) {
    const resolved = normalize(join(root, requested));
    if (!resolved.startsWith(root)) continue;
    try {
      const contents = await readFile(resolved);
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType(resolved));
      res.setHeader('Cache-Control', 'no-store');
      res.end(contents);
      return true;
    } catch {
      // Try the next local asset root.
    }
  }
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', process.env.MCP_PUBLIC_BASE_URL || `http://127.0.0.1:${defaultPort}`);
  const loader = routeLoaders[url.pathname];
  if (!loader) {
    if (await serveStatic(url.pathname, res)) return;
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  try {
    const body = await bodyFor(req);
    const handlerRequest = Object.assign(req, {
      query: Object.fromEntries(url.searchParams),
      body,
    });
    const module = await loader();
    await module.default(handlerRequest, responseAdapter(res));
  } catch {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

const port = Number.parseInt(process.env.MCP_OAUTH_PORT || String(defaultPort), 10);
server.listen(port, '127.0.0.1', () => {
  console.info(`OAuth development server listening on http://127.0.0.1:${port}`);
});
