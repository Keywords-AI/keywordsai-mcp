/**
 * Registers the tools synced from the backend agent surface.
 *
 * Names, descriptions and schemas in `manifest.json` are generated verbatim
 * from the backend's own tool registry, so this package and the in-product
 * agent expose the same contract. Only tools carrying a machine-verified
 * `route` are registered; the rest keep an `excluded` reason and stay dark
 * rather than being wired to a guessed endpoint.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthenticatedClient } from '../shared/client.js';
import { requireClient, rawFetch } from '../shared/client.js';
import { sanitizeOutput } from '../shared/sanitize.js';
import { toZodShape, type JsonSchema } from './schema-to-zod.js';
import manifest from './manifest.json' with { type: 'json' };

interface ToolRoute {
  method: string;
  path: string;
  sendsBody: boolean;
  // Absent keys come back as undefined from a JSON import.
  argMap: Record<string, string[] | undefined>;
}

interface ManifestTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
  route: ToolRoute | null;
  excluded: string | null;
}

/** Placeholder the generator leaves in a path for a URL segment argument. */
function pathToken(arg: string): string {
  return `ZZ${arg.replace(/_/g, '')}ZZ`;
}

function assignNested(target: Record<string, unknown>, trail: string[], value: unknown): void {
  let node = target;
  for (const segment of trail.slice(0, -1)) {
    if (typeof node[segment] !== 'object' || node[segment] === null) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  node[trail[trail.length - 1]] = value;
}

interface BuiltRequest {
  path: string;
  body: Record<string, unknown> | undefined;
}

export function buildRequest(route: ToolRoute, args: Record<string, unknown>): BuiltRequest {
  let path = route.path;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};

  for (const [arg, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const destinations = route.argMap[arg];
    // An argument with no mapping is not forwarded. The backend executor
    // consumes some arguments locally, so dropping is correct, not a gap.
    if (!destinations) continue;

    for (const destination of destinations) {
      if (destination === 'path') {
        path = path.replace(pathToken(arg), encodeURIComponent(String(value)));
      } else if (destination.startsWith('query.')) {
        query.set(destination.slice('query.'.length), String(value));
      } else if (destination.startsWith('body.')) {
        assignNested(body, destination.slice('body.'.length).split('.'), value);
      }
    }
  }

  const queryString = query.toString();
  return {
    path: queryString ? `${path}?${queryString}` : path,
    body: route.sendsBody ? body : undefined,
  };
}

/**
 * Records every tool name registered after this is installed.
 *
 * Hand-written modules and this generated layer both use backend names now, so
 * they can collide. The SDK overwrites a duplicate registration silently, which
 * would make the winner depend on call order. Recording the names lets the
 * generated layer defer explicitly instead.
 */
export function recordRegisteredNames(server: McpServer): Set<string> {
  const names = new Set<string>();
  const original = server.tool.bind(server);
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = function (
    ...args: unknown[]
  ) {
    if (typeof args[0] === 'string') names.add(args[0]);
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  return names;
}

export function registerSyncedTools(
  server: McpServer,
  client: AuthenticatedClient | null,
  handWritten: ReadonlySet<string> = new Set(),
): void {
  const tools: ManifestTool[] = manifest.tools;

  for (const tool of tools) {
    const route = tool.route;
    if (!route) continue;
    // A hand-written implementation of the same tool wins. It is exercised
    // against the real API; this layer's route is derived.
    if (handWritten.has(tool.name)) continue;

    server.tool(
      tool.name,
      tool.description,
      toZodShape(tool.inputSchema),
      async (args: Record<string, unknown>) => {
        const c = requireClient(client);
        const { path, body } = buildRequest(route, args ?? {});
        const data = await rawFetch(c, path, { method: route.method, body });
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(sanitizeOutput(data), null, 2) },
          ],
        };
      },
    );
  }
}

/** Tool names this module registers. Useful for diagnostics and tests. */
export function syncedToolNames(): string[] {
  const tools: ManifestTool[] = manifest.tools;
  return tools.filter(tool => tool.route).map(tool => tool.name);
}
