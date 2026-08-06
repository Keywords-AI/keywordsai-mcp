import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthenticatedClient } from './client.js';
import { requireClient } from './client.js';
import { sanitizeOutput } from './sanitize.js';
import { toZodShape, type JsonSchema } from '../generated/schema-to-zod.js';
import manifest from '../generated/manifest.json' with { type: 'json' };

/**
 * Registers a tool whose name, description and argument schema come from the
 * generated manifest, but whose route is written by hand.
 *
 * The generator derives a route only when it can locate every argument by
 * introspection. Executors with real branching defeat that, so those tools would
 * otherwise stay dark. This closes the gap without giving up the property that
 * matters: the contract a caller sees is still the backend's own, character for
 * character, and regenerating the manifest updates it.
 *
 * Only the ROUTE is hand-written. Never hand-write the description or schema
 * here — that reintroduces the drift the manifest exists to prevent.
 */

interface ManifestTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

const BY_NAME = new Map<string, ManifestTool>(
  (manifest.tools as ManifestTool[]).map(t => [t.name, t]),
);

/** Builds the request and returns the parsed payload. */
export type ManifestHandler = (
  c: AuthenticatedClient,
  args: Record<string, any>,
) => Promise<unknown>;

export interface ManifestToolOptions {
  /**
   * Arguments to drop from the advertised schema.
   *
   * Use only for arguments this surface genuinely cannot honor. An argument
   * left advertised but unsent is worse than an absent one: the model believes
   * it applied.
   */
  omit?: string[];
}

export function registerManifestTool(
  server: McpServer,
  client: AuthenticatedClient | null,
  name: string,
  handler: ManifestHandler,
  options: ManifestToolOptions = {},
): void {
  const tool = BY_NAME.get(name);
  if (!tool) {
    // A rename in the backend must fail loudly here rather than silently drop
    // the tool from the surface.
    throw new Error(`registerManifestTool: no manifest entry for '${name}'`);
  }

  let schema = tool.inputSchema;
  if (options.omit?.length) {
    const properties = { ...(schema.properties ?? {}) };
    for (const key of options.omit) delete properties[key];
    schema = {
      ...schema,
      properties,
      required: (schema.required ?? []).filter(k => !options.omit!.includes(k)),
    };
  }

  server.tool(name, tool.description, toZodShape(schema), async (args: Record<string, unknown>) => {
    const c = requireClient(client);
    const data = await handler(c, (args ?? {}) as Record<string, any>);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(sanitizeOutput(data), null, 2) }],
    };
  });
}

/** Names carried in the manifest. Used by the parity check. */
export function manifestToolNames(): string[] {
  return [...BY_NAME.keys()];
}

/**
 * Query string from the args the endpoint honors, in a stable order.
 *
 * Absent and null values are skipped, so an omitted optional never becomes a
 * literal "undefined" in the URL.
 */
export function queryFrom(args: Record<string, any>, keys: string[]): URLSearchParams {
  const q = new URLSearchParams();
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    q.set(key, String(value));
  }
  return q;
}
