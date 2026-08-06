import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
import { registerSyncedTools } from '../generated/register.js';

function createServer(client: AuthenticatedClient | null, enabledTools?: Set<string>): McpServer {
  const server = new McpServer({
    name: 'respan',
    version: '1.0.0',
  });

  // If Respan-Enabled-Tools header is set, only register whitelisted tools
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
  registerSyncedTools(server, client);

  return server;
}

function extractApiKey(req: VercelRequest): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return process.env.RESPAN_API_KEY;
}

export function createMcpHandler(defaultBaseUrl: string, resourceMetadataPath: string) {
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

    try {
      const apiKey = extractApiKey(req);

      if (!apiKey) {
        const host = req.headers.host || 'mcp.respan.ai';
        const resourceMetadataUrl = `https://${host}${resourceMetadataPath}`;
        res.setHeader(
          'WWW-Authenticate',
          `Bearer resource_metadata="${resourceMetadataUrl}"`
        );
        return res.status(401).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Unauthorized: API key required. Use Authorization: Bearer YOUR_KEY header or set RESPAN_API_KEY environment variable.',
          },
          id: null,
        });
      }

      const baseUrl = (req.headers['respan-api-base-url'] as string)
        || (req.headers['keywords-api-base-url'] as string)
        || process.env.RESPAN_API_BASE_URL
        || defaultBaseUrl;

      const authenticatedClient: AuthenticatedClient = {
        client: new RespanClient({
          environment: baseUrl,
        }),
        auth: `Bearer ${apiKey}`,
        baseUrl,
      };

      const enabledToolsHeader = req.headers['respan-enabled-tools'] as string | undefined;
      const enabledTools = enabledToolsHeader
        ? new Set(enabledToolsHeader.split(',').map(t => t.trim()).filter(Boolean))
        : undefined;

      const server = createServer(authenticatedClient, enabledTools);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);

      await transport.handleRequest(
        req as any,
        res as any,
        req.body
      );
    } catch (error) {
      console.error('MCP Handler error:', error);

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  };
}
