#!/usr/bin/env node
// Entry point for Respan MCP Server (stdio mode)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveAuthFromEnv, createClient } from "./shared/client.js";
import { registerLogTools } from "./observe/logs.js";
import { registerTraceTools } from "./observe/traces.js";
import { registerUserTools } from "./observe/users.js";
import { registerPromptTools } from "./develop/prompts.js";
import { registerExperimentTools } from "./develop/experiments.js";
import { registerEvaluatorTools } from "./evaluate/evaluators.js";
import { registerDatasetTools } from "./evaluate/datasets.js";
import { registerEvaluationPipelineTools } from "./evaluate/pipelines.js";
import { registerWorkflowTools } from "./develop/workflows.js";
import { registerSyncedTools } from "./generated/register.js";

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

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Respan MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
