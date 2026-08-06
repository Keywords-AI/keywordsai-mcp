import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthenticatedClient } from '../shared/client.js';
import { rawFetch } from '../shared/client.js';
import { registerManifestTool } from '../shared/manifestTool.js';
import { clampPagination } from '../shared/pagination.js';

/**
 * Pulse reads: error groups, incidents and behaviour rollups.
 *
 * Every one is a POST whose arguments ride in the body rather than the query.
 * Each endpoint accepts a fixed set of body keys, so the sets are declared here
 * and nothing outside them is forwarded.
 */

const ERROR_GROUPS_BODY_KEYS = [
  'start_time',
  'end_time',
  'environment',
  'error_class',
  'provider',
  'status',
  'fault_domain',
];
const ERROR_GROUP_GET_BODY_KEYS = ['start_time', 'end_time', 'environment', 'limit'];
const INCIDENTS_BODY_KEYS = [
  'start_time',
  'end_time',
  'environment',
  'state',
  'severity',
  'fault_domain',
];
const BEHAVIORS_BODY_KEYS = ['start_time', 'end_time', 'environment'];

function bodyFrom(args: Record<string, any>, keys: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined && args[key] !== null) body[key] = args[key];
  }
  return body;
}

export function registerPulseTools(server: McpServer, client: AuthenticatedClient | null) {
  registerManifestTool(server, client, 'pulse_error_groups_list', async (c, args) =>
    rawFetch(c, '/api/pulses/errors/', {
      method: 'POST',
      body: bodyFrom(args, ERROR_GROUPS_BODY_KEYS),
    }),
  );

  registerManifestTool(server, client, 'pulse_error_group_get', async (c, args) =>
    rawFetch(c, `/api/pulses/errors/${encodeURIComponent(String(args.fingerprint))}/`, {
      method: 'POST',
      body: bodyFrom(args, ERROR_GROUP_GET_BODY_KEYS),
    }),
  );

  registerManifestTool(server, client, 'pulse_incidents_list', async (c, args) => {
    const paging = clampPagination('pulse_incidents_list', args);
    const q = new URLSearchParams({
      page: String(paging.page),
      page_size: String(paging.page_size),
    });
    return rawFetch(c, `/api/pulses/incidents/?${q.toString()}`, {
      method: 'POST',
      body: bodyFrom(args, INCIDENTS_BODY_KEYS),
    });
  });

  registerManifestTool(server, client, 'pulse_behaviors_summary', async (c, args) =>
    rawFetch(c, '/api/pulses/behaviors/', {
      method: 'POST',
      body: bodyFrom(args, BEHAVIORS_BODY_KEYS),
    }),
  );
}
