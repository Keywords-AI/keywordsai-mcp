import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { RespanClient } from '@respan/respan-api';
import type { AuthenticatedClient } from './client.js';
import { registerLogTools } from '../observe/logs.js';
import { registerTraceTools } from '../observe/traces.js';
import { registerUserTools } from '../observe/users.js';
import { registerPromptTools } from '../develop/prompts.js';
import { registerExperimentTools } from '../develop/experiments.js';
import { registerEvaluatorTools } from '../evaluate/evaluators.js';
import { registerDatasetTools } from '../evaluate/datasets.js';
import { registerEvaluationPipelineTools } from '../evaluate/pipelines.js';
import { registerWorkflowTools } from '../develop/workflows.js';
import { OAuthBroker, type ResolvedAccess } from '../oauth/broker.js';
import { getOAuthConfig, type OAuthRealm } from '../oauth/config.js';
import { InvalidAccessTokenError } from '../oauth/errors.js';
import { getSessionStore } from '../oauth/store-factory.js';
import { SessionStoreUnavailableError } from '../oauth/store.js';
import {
  DisallowedBackendUrlError,
  resolveAllowedBackendUrl,
} from './backend-url.js';

function createServer(
  client: AuthenticatedClient | null,
  enabledTools?: Set<string>,
): McpServer {
  const server = new McpServer({
    name: 'respan',
    version: '1.0.0',
  });

  if (enabledTools?.size) {
    const originalTool = server.tool.bind(server);
    (server as any).tool = function (name: string) {
      if (!enabledTools.has(name)) return;
      return originalTool.apply(server, arguments as any);
    };
  }

  registerLogTools(server, client);
  registerTraceTools(server, client);
  registerUserTools(server, client);
  registerPromptTools(server, client);
  registerExperimentTools(server, client);
  registerEvaluatorTools(server, client);
  registerDatasetTools(server, client);
  registerEvaluationPipelineTools(server, client);
  registerWorkflowTools(server, client);
  return server;
}

function bearerCredential(req: VercelRequest): string | undefined {
  const authHeader = req.headers.authorization;
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
}

function canonicalPublicBaseUrl(): string {
  return (process.env.MCP_PUBLIC_BASE_URL || 'https://mcp.respan.ai').replace(/\/+$/, '');
}

function challenge(resourceMetadataPath: string): string {
  return `Bearer resource_metadata="${canonicalPublicBaseUrl()}${resourceMetadataPath}"`;
}

function sendUnauthorized(
  res: VercelResponse,
  resourceMetadataPath: string,
): VercelResponse {
  res.setHeader('WWW-Authenticate', challenge(resourceMetadataPath));
  return res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null,
  });
}

function sdkBackendBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/api\/?$/, '');
}

function toWebRequest(req: VercelRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = req.method || 'POST';
  return new Request(
    `${canonicalPublicBaseUrl()}${req.url || '/mcp'}`,
    {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: JSON.stringify(req.body ?? {}) }),
    },
  );
}

async function bufferWebResponse(response: Response): Promise<{
  status: number;
  headers: Headers;
  body: Buffer;
}> {
  return {
    status: response.status,
    headers: response.headers,
    body: Buffer.from(await response.arrayBuffer()),
  };
}

function sendWebResponse(
  response: {
    status: number;
    headers: Headers;
    body: Buffer;
  },
  res: VercelResponse,
): void {
  for (const [name, value] of response.headers.entries()) {
    res.setHeader(name, value);
  }
  res.status(response.status).send(response.body);
}

export function createMcpHandler(
  defaultBaseUrl: string,
  resourceMetadataPath: string,
  realm: OAuthRealm,
) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');

    if (req.method === 'GET') {
      return res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'SSE streams not supported in stateless mode. Use POST for tool calls.' },
        id: null,
      });
    }
    if (req.method === 'DELETE') {
      return res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session management not supported in stateless mode.' },
        id: null,
      });
    }

    let oauthAccess: ResolvedAccess | undefined;
    try {
      const bearer = bearerCredential(req);
      let backendCredential: string | undefined;
      let baseUrl: string;
      let backendUnauthorized = false;

      if (bearer?.startsWith('mcp_at_')) {
        const config = getOAuthConfig();
        const store = getSessionStore();
        oauthAccess = await new OAuthBroker({ config, store }).resolveAccessToken(
          realm,
          bearer,
        );
        backendCredential = oauthAccess.backendAccessJwt;
        baseUrl = sdkBackendBaseUrl(config.realms[realm].backendBaseUrl);
      } else if (bearer?.startsWith('mcp_')) {
        return sendUnauthorized(res, resourceMetadataPath);
      } else {
        backendCredential = bearer || process.env.RESPAN_API_KEY;
        if (!backendCredential) {
          return sendUnauthorized(res, resourceMetadataPath);
        }
        const configuredBaseUrl = (
          realm === 'enterprise'
            ? process.env.RESPAN_ENTERPRISE_API_BASE_URL
            : process.env.RESPAN_API_BASE_URL
        ) || defaultBaseUrl;
        const requestedBaseUrl = (req.headers['respan-api-base-url'] as string)
          || (req.headers['keywords-api-base-url'] as string);
        baseUrl = bearer
          ? resolveAllowedBackendUrl(requestedBaseUrl, configuredBaseUrl)
          : resolveAllowedBackendUrl(undefined, configuredBaseUrl);
        baseUrl = sdkBackendBaseUrl(baseUrl);
      }

      const trackedFetch: typeof fetch = async (input, init) => {
        const response = await globalThis.fetch(input, init);
        if (oauthAccess && response.status === 401) backendUnauthorized = true;
        return response;
      };
      const authenticatedClient: AuthenticatedClient = {
        client: new RespanClient({
          environment: baseUrl,
          ...(oauthAccess ? { fetch: trackedFetch } : {}),
        }),
        auth: `Bearer ${backendCredential}`,
        baseUrl,
      };
      const enabledToolsHeader = req.headers['respan-enabled-tools'] as string | undefined;
      const enabledTools = enabledToolsHeader
        ? new Set(enabledToolsHeader.split(',').map((tool) => tool.trim()).filter(Boolean))
        : undefined;

      const server = createServer(authenticatedClient, enabledTools);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      const transportResponse = await transport.handleRequest(
        toWebRequest(req),
        { parsedBody: req.body },
      );
      const bufferedResponse = await bufferWebResponse(transportResponse);

      if (backendUnauthorized && oauthAccess) {
        await getSessionStore().deleteAccessSession(
          realm,
          oauthAccess.accessTokenHash,
        );
        return sendUnauthorized(res, resourceMetadataPath);
      }
      sendWebResponse(bufferedResponse, res);
    } catch (error) {
      if (
        error instanceof InvalidAccessTokenError
        || (error instanceof Error && error.name === 'ZodError')
      ) {
        return sendUnauthorized(res, resourceMetadataPath);
      }
      if (error instanceof DisallowedBackendUrlError) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32602, message: 'Invalid backend URL' },
          id: null,
        });
      }
      if (error instanceof SessionStoreUnavailableError) {
        res.setHeader('Retry-After', '5');
        return res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32002, message: 'Authentication service unavailable' },
          id: null,
        });
      }
      console.error('MCP handler failed');
      if (!res.headersSent) {
        return res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };
}
