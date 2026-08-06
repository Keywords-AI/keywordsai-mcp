import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthenticatedClient } from './client.js';
import { registerLogTools } from '../observe/logs.js';
import { registerTraceTools } from '../observe/traces.js';
import { registerUserTools } from '../observe/users.js';
import { registerDashboardTools } from '../observe/dashboard.js';
import { registerTelemetryTools } from '../observe/telemetry.js';
import { registerPulseTools } from '../observe/pulse.js';
import { registerPromptTools } from '../develop/prompts.js';
import { registerExperimentTools } from '../develop/experiments.js';
import { registerWorkflowTools } from '../develop/workflows.js';
import { registerLifecycleTools } from '../develop/lifecycle.js';
import { registerEvaluatorTools } from '../evaluate/evaluators.js';
import { registerDatasetTools } from '../evaluate/datasets.js';
import { registerEvaluationPipelineTools } from '../evaluate/pipelines.js';
import { registerPlatformConfigTools } from '../platform/config.js';
import { registerAccountTools } from '../platform/account.js';
import { registerDocTools } from '../docs/tools.js';
import { recordRegisteredNames, registerSyncedTools } from '../generated/register.js';
import { registerDeferredTools } from './deferred.js';

/**
 * The one place every tool is registered.
 *
 * Both entry points (stdio and HTTP) and both surface modes (flat and deferred)
 * go through this, so there is a single answer to "what tools exist".
 */
export function registerAllTools(server: McpServer, client: AuthenticatedClient | null): void {
  // Names claimed by the hand-written modules; the generated layer defers to
  // them instead of silently overwriting.
  const handWritten = recordRegisteredNames(server);

  registerLogTools(server, client);
  registerTraceTools(server, client);
  registerUserTools(server, client);
  registerDashboardTools(server, client);
  registerTelemetryTools(server, client);
  registerPulseTools(server, client);
  registerPromptTools(server, client);
  registerExperimentTools(server, client);
  registerWorkflowTools(server, client);
  registerLifecycleTools(server, client);
  registerEvaluatorTools(server, client);
  registerDatasetTools(server, client);
  registerEvaluationPipelineTools(server, client);
  registerPlatformConfigTools(server, client);
  registerAccountTools(server, client);
  // Documentation search hits public docs with no auth and no backend call, so
  // it belongs on the main server too, not only the standalone docs endpoint.
  registerDocTools(server);
  registerSyncedTools(server, client, handWritten);
}

export type SurfaceMode = 'deferred' | 'flat';

/**
 * How the tools reach the client.
 *
 * `deferred` registers three meta-tools and serves the rest as data, which is
 * the default because the flat surface costs a client ~58k tokens of
 * definitions before it asks anything. `flat` registers all of them, and stays
 * available for clients that pin tool names directly.
 */
export const DEFAULT_SURFACE_MODE: SurfaceMode = 'deferred';

export function resolveSurfaceMode(requested?: string | null): SurfaceMode {
  return requested?.toLowerCase() === 'flat' ? 'flat' : DEFAULT_SURFACE_MODE;
}

/** Applies the chosen mode. The handlers are identical either way. */
export function registerSurface(
  server: McpServer,
  client: AuthenticatedClient | null,
  mode: SurfaceMode,
): void {
  if (mode === 'flat') {
    registerAllTools(server, client);
    return;
  }
  registerDeferredTools(server, s => registerAllTools(s, client));
}
