#!/usr/bin/env node
// Entry point for Respan MCP Server (stdio mode)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveAuthFromEnv, createClient } from "./shared/client.js";
import { registerSurface, resolveSurfaceMode } from "./shared/registry.js";

async function main() {
  const auth = resolveAuthFromEnv();
  const client = auth ? createClient(auth, auth.baseUrl) : null;

  if (!auth) {
    console.error("No credentials found. Set RESPAN_API_KEY or run `respan login` to authenticate.");
    console.error("Only public tools will be available.");
  }

  const server = new McpServer({
    name: "respan",
    version: "1.0.0",
  });

  // Deferred by default. Set RESPAN_TOOL_MODE=flat to register every tool
  // directly instead, for a client that pins tool names.
  const mode = resolveSurfaceMode(process.env.RESPAN_TOOL_MODE);
  registerSurface(server, client, mode);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`Respan MCP Server running on stdio (${mode} tool surface)`);
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
