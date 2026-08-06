import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthenticatedClient } from '../shared/client.js';
import { rawFetch } from '../shared/client.js';
import { registerManifestTool, queryFrom } from '../shared/manifestTool.js';
import { clampPagination } from '../shared/pagination.js';

/**
 * Organization, catalog and integration reads.
 *
 * Several of these have an admin route and a customer route that return
 * different data for the same question. This surface always takes the customer
 * route — see provider_list below for the case where the difference is
 * credential material rather than scope.
 */

/** Resolves the org from the token; no argument can widen it. */
const CURRENT_ORGANIZATION = '/auth/current-organization/';
const ORGANIZATION_MEMBERS = '/user/organization-members/';
/** Catalog view. The admin /api/providers/ route serves credentials with it. */
const PROVIDER_CATALOG = '/llm_models/providers/';

/** Fields the customer-facing provider catalog exposes. */
const PROVIDER_CATALOG_FIELDS = [
  'provider_id',
  'provider_name',
  'litellm_provider_id',
  'moderation',
  'created_at',
  'updated_at',
];

const MEMBER_FIELDS = [
  'id',
  'user',
  'email',
  'role',
  'access_level',
  'pending',
  'organization_name',
  'user_count',
  'created_at',
];

function project(rows: unknown, fields: string[]): unknown {
  const list = Array.isArray(rows) ? rows : [];
  return list.map(row => {
    if (!row || typeof row !== 'object') return row;
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f in (row as Record<string, unknown>)) out[f] = (row as Record<string, unknown>)[f];
    }
    return out;
  });
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    const r = (result as Record<string, unknown>).results;
    if (Array.isArray(r)) return r;
  }
  return [];
}

/** {field: {operator, value}} — the shape the filter engine expects. */
function filtersFrom(
  args: Record<string, any>,
  mapping: Record<string, [string, string]>,
): Record<string, { operator: string; value: unknown }> {
  const filters: Record<string, { operator: string; value: unknown }> = {};
  for (const [arg, [field, operator]] of Object.entries(mapping)) {
    if (args[arg] !== undefined && args[arg] !== null) {
      filters[field] = { operator, value: args[arg] };
    }
  }
  return filters;
}

export function registerPlatformConfigTools(server: McpServer, client: AuthenticatedClient | null) {
  registerManifestTool(server, client, 'org_get', async c =>
    rawFetch(c, CURRENT_ORGANIZATION, { method: 'GET' }),
  );

  registerManifestTool(server, client, 'org_subscription_get', async c => {
    // The subscription rides along on the org read, which resolves the org from
    // the token. The dedicated subscription route keys on an org argument.
    const org = (await rawFetch(c, CURRENT_ORGANIZATION, { method: 'GET' })) as Record<string, any> | null;
    const subscription = org?.organization_subscription;
    if (!subscription) {
      return { error: 'not_found', message: 'No subscription found for this organization.' };
    }
    return { unique_organization_id: org?.unique_organization_id ?? '', subscription };
  });

  registerManifestTool(server, client, 'org_member_list', async (c, args) => {
    const result = await rawFetch(c, ORGANIZATION_MEMBERS, { method: 'GET' });
    let members = rowsOf(result);
    if (args.is_pending !== undefined && args.is_pending !== null) {
      members = members.filter(
        m => Boolean((m as Record<string, unknown>)?.pending) === Boolean(args.is_pending),
      );
    }
    return { members: project(members, MEMBER_FIELDS), count: members.length };
  });

  // is_managed_only is dropped: it only means anything on the admin route, and
  // that route returns custom-provider rows WITH their credential material.
  // This tool reads the catalog instead, which carries no credentials.
  registerManifestTool(
    server,
    client,
    'provider_list',
    async c => {
      const result = await rawFetch(c, PROVIDER_CATALOG, { method: 'GET' });
      const providers = project(rowsOf(result), PROVIDER_CATALOG_FIELDS);
      return { providers, count: (providers as unknown[]).length };
    },
    { omit: ['is_managed_only'] },
  );

  registerManifestTool(server, client, 'webhook_list', async (c, args) => {
    const q = queryFrom(args, ['event_type']);
    // Defaults to active-only, matching the argument's documented default.
    if (args.is_active_only !== false) q.set('active', 'true');
    const qs = q.toString();
    return rawFetch(c, qs ? `/api/webhooks/?${qs}` : '/api/webhooks/', { method: 'GET' });
  });

  registerManifestTool(server, client, 'export_list', async (c, args) => {
    const q = queryFrom(args, ['status']);
    q.set('limit', String(args.limit ?? 20));
    return rawFetch(c, `/api/export-jobs/?${q.toString()}`, { method: 'GET' });
  });

  registerManifestTool(server, client, 'model_list', async (c, args) => {
    // No organization_id IS NULL narrowing here. That is the admin convention
    // for "global models only"; a customer caller wants the visible catalog,
    // which is global plus the org's own custom models.
    const filters = filtersFrom(args, {
      provider: ['provider__provider_id', ''],
      organization: ['organization_id', ''],
      affiliation_category: ['affiliation_category', ''],
      model_name: ['model_name', 'icontains'],
    });
    const paging = clampPagination('model_list', args);
    const q = new URLSearchParams({ page: String(paging.page), page_size: String(paging.page_size) });
    if (args.sort_by) q.set('sort_by', String(args.sort_by));
    return rawFetch(c, `/api/models/list/?${q.toString()}`, {
      method: 'POST',
      body: Object.keys(filters).length ? { filters } : {},
    });
  });

  registerManifestTool(server, client, 'integration_list', async (c, args) => {
    const filters = filtersFrom(args, {
      provider: ['provider__provider_id', ''],
      is_active: ['is_active', ''],
      is_managed: ['is_managed', ''],
      organization: ['organization_id', ''],
    });
    const paging = clampPagination('integration_list', args);
    const q = new URLSearchParams({ page: String(paging.page), page_size: String(paging.page_size) });
    if (args.sort_by) q.set('sort_by', String(args.sort_by));
    return rawFetch(c, `/api/integrations/list/?${q.toString()}`, {
      method: 'POST',
      body: Object.keys(filters).length ? { filters } : {},
    });
  });

  registerManifestTool(server, client, 'integration_summary', async (c, args) => {
    const filters = filtersFrom(args, {
      provider: ['provider__provider_id', ''],
      is_active: ['is_active', ''],
      is_managed: ['is_managed', ''],
    });
    return rawFetch(c, '/api/integrations/summary/', {
      method: 'POST',
      body: Object.keys(filters).length ? { filters } : {},
    });
  });

}
