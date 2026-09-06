// Single registration list for every tool the Respan MCP exposes.
//
// Both entry points (`api/mcp.ts` via createMcpHandler, and the stdio
// `lib/index.ts`) and the `/health` probe build servers through here so the
// tool surface, and therefore the schema fingerprint, is the same everywhere.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import { registerOrganizationTools } from '../account/organizations.js';
import { MCP_SERVER_VERSION, registerServerInfoTool } from './server-info.js';

export function registerAllTools(server: McpServer, client: AuthenticatedClient | null): void {
  registerLogTools(server, client);
  registerTraceTools(server, client);
  registerUserTools(server, client);
  registerPromptTools(server, client);
  registerExperimentTools(server, client);
  registerEvaluatorTools(server, client);
  registerDatasetTools(server, client);
  registerEvaluationPipelineTools(server, client);
  registerWorkflowTools(server, client);
  registerOrganizationTools(server, client);
  // server_info describes the full surface, so it always enumerates an
  // unfiltered server regardless of which tools this one has enabled.
  registerServerInfoTool(server, () => createToolServer(null));
}

/**
 * Build an unconnected server with every tool registered. When `enabledTools`
 * is given, registrations for other names are dropped (the
 * `respan-enabled-tools` header).
 */
export function createToolServer(
  client: AuthenticatedClient | null,
  enabledTools?: Set<string>,
): McpServer {
  const server = new McpServer({
    name: 'respan',
    version: MCP_SERVER_VERSION,
  });

  if (enabledTools?.size) {
    const originalTool = server.tool.bind(server);
    (server as any).tool = function (name: string) {
      if (!enabledTools.has(name)) return;
      return originalTool.apply(server, arguments as any);
    };
  }

  registerAllTools(server, client);
  return server;
}
