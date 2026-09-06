// Server identity for the hosted MCP.
//
// Mirrors the backend admin MCP's `server_info` tool: reports the deployed
// commit, boot timestamp, tool count and a 16-char fingerprint of the tool
// schema surface. `/health` and the `server_info` tool both read from here so
// an operator (or an agent session) can tell whether the live deployment has
// picked up a change without any other out-of-band signal.
//
// Everything reported is static deployment metadata. Nothing is derived from
// the incoming request and no credentials or secrets are included.
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { backendTargets } from './backend-url.js';
import { BUILD_BRANCH, BUILD_COMMIT_SHA, BUILD_TIMESTAMP } from './build-info.js';

// Bump when the tool surface changes in a way clients must notice. Advisory
// only; `commit_sha` is authoritative for "is this deployment current?".
export const MCP_SERVER_VERSION = '1.0.0';

// Captured at module load so it reflects when this function instance booted,
// not when the probe was called. A change here without a change in
// `commit_sha` is just a cold start; a change in both is a new deployment.
const STARTED_AT = new Date().toISOString();

export interface ServerInfo {
  service: 'respan-mcp';
  version: string;
  commit_sha: string;
  branch: string;
  deployed_at: string;
  started_at: string;
  tool_count: number;
  tool_schema_fingerprint: string;
  backend_targets: { platform: string; enterprise: string };
}

export type ToolSurface = Pick<Tool, 'name' | 'description' | 'inputSchema' | 'outputSchema'>;

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Hash the tool schema surface so a caller can tell whether the deployed
 * schemas match what they expect. Stable across registration order and JSON
 * key order; changes when a tool is added, removed, renamed, re-described
 * or gets a different input/output schema.
 */
export function computeToolSchemaFingerprint(tools: Iterable<ToolSurface>): string {
  const payload = [...tools]
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(canonicalJson(payload)).digest('hex').slice(0, 16);
}

/**
 * Enumerate a server's tools exactly as an MCP client would see them
 * (JSON Schema, not zod), by driving `tools/list` over an in-memory transport.
 * The server is closed afterwards; pass a freshly built one.
 */
export async function listRegisteredTools(server: McpServer): Promise<Tool[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'respan-server-info', version: MCP_SERVER_VERSION });
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

export function deployedCommitSha(env: NodeJS.ProcessEnv = process.env): string {
  return env.VERCEL_GIT_COMMIT_SHA || BUILD_COMMIT_SHA;
}

export function deployedBranch(env: NodeJS.ProcessEnv = process.env): string {
  return env.VERCEL_GIT_COMMIT_REF || BUILD_BRANCH;
}

// The tool surface is fixed for the lifetime of a deployment, so it is
// enumerated once per function instance and reused.
let toolSurface: Promise<{ tool_count: number; tool_schema_fingerprint: string }> | undefined;

async function describeToolSurface(buildServer: () => McpServer) {
  if (!toolSurface) {
    toolSurface = listRegisteredTools(buildServer())
      .then((tools) => ({
        tool_count: tools.length,
        tool_schema_fingerprint: computeToolSchemaFingerprint(tools),
      }))
      .catch((error) => {
        toolSurface = undefined;
        throw error;
      });
  }
  return toolSurface;
}

/**
 * Build the identity payload. `buildServer` must return a fresh, unconnected
 * server with the full (unfiltered) tool set registered, so the fingerprint
 * describes the deployment rather than one request's `respan-enabled-tools`.
 */
export async function getServerInfo(buildServer: () => McpServer): Promise<ServerInfo> {
  const surface = await describeToolSurface(buildServer);
  return {
    service: 'respan-mcp',
    version: MCP_SERVER_VERSION,
    commit_sha: deployedCommitSha(),
    branch: deployedBranch(),
    deployed_at: BUILD_TIMESTAMP || STARTED_AT,
    started_at: STARTED_AT,
    tool_count: surface.tool_count,
    tool_schema_fingerprint: surface.tool_schema_fingerprint,
    backend_targets: backendTargets(),
  };
}

export function registerServerInfoTool(server: McpServer, buildServer: () => McpServer) {
  server.tool(
    'server_info',
    `Return this MCP server's identity: deployed git commit sha, branch, deploy and boot timestamps, tool count, a 16-char fingerprint of the tool schema surface, and the backend base URLs it routes to.

Use this to detect a stale deployment or a stale client tool cache after the MCP code changes. Compare commit_sha against the expected tip of main, or diff tool_schema_fingerprint against the value from a fresh session. The same data is served unauthenticated at GET /health.

Takes no arguments. Read-only; makes no backend calls.`,
    {},
    async () => {
      const info = await getServerInfo(buildServer);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
      };
    },
  );
}
