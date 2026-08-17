import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OrganizationSelectionError,
  registerOrganizationTools,
  resolveTeamId,
  toOrganizations,
} from '../lib/account/organizations.js';
import type { AuthenticatedClient } from '../lib/shared/client.js';

const ACME = {
  id: 11,
  role: 'admin',
  organization: { unique_organization_id: 'org-acme', name: 'Acme' },
};
const GLOBEX = {
  id: 22,
  role: 'member',
  organization: { unique_organization_id: 'org-globex', name: 'Globex' },
};
// Sibling org in the same company that the user has no membership in — the
// backend synthesizes these with id/role null (organization/utils: get_visible_teams_for_user).
const SIBLING = {
  id: null,
  role: null,
  organization: { unique_organization_id: 'org-sibling', name: 'Initech' },
};

function organizations() {
  return toOrganizations([ACME, GLOBEX, SIBLING], 'org-globex');
}

describe('toOrganizations', () => {
  it('flags the active organization and non-member rows', () => {
    const [acme, globex, sibling] = organizations();
    expect(acme).toMatchObject({
      team_id: 11,
      name: 'Acme',
      organization_id: 'org-acme',
      role: 'admin',
      is_current: false,
      is_switchable: true,
    });
    expect(globex.is_current).toBe(true);
    expect(sibling).toMatchObject({ team_id: null, is_switchable: false });
  });

  it('marks nothing current when the active organization is unknown', () => {
    expect(toOrganizations([ACME], undefined).some((o) => o.is_current)).toBe(false);
  });
});

describe('resolveTeamId', () => {
  it.each([
    ['name', 'Acme'],
    ['name in a different case', 'aCMe'],
    ['organization_id', 'org-acme'],
    ['team_id', '11'],
  ])('resolves by %s', (_label, selector) => {
    expect(resolveTeamId(organizations(), selector)).toBe(11);
  });

  it('trims surrounding whitespace', () => {
    expect(resolveTeamId(organizations(), '  Acme ')).toBe(11);
  });

  it('rejects an unknown organization and names the options', () => {
    expect(() => resolveTeamId(organizations(), 'Nope'))
      .toThrow(/No organization matches "Nope".*Acme \(org-acme\)/s);
  });

  it('rejects an ambiguous name instead of guessing', () => {
    const duplicates = toOrganizations(
      [ACME, { ...GLOBEX, organization: { unique_organization_id: 'org-2', name: 'Acme' } }],
      undefined,
    );
    expect(() => resolveTeamId(duplicates, 'Acme'))
      .toThrow(/matches more than one organization/);
  });

  it('refuses an organization the user is not a member of', () => {
    expect(() => resolveTeamId(organizations(), 'Initech'))
      .toThrow(OrganizationSelectionError);
    expect(() => resolveTeamId(organizations(), 'Initech'))
      .toThrow(/not a member/);
  });
});

type ToolHandler = (args: any) => Promise<{ content: Array<{ text: string }> }>;

function registerTools() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  const client = { baseUrl: 'https://api.example', auth: 'Bearer jwt' } as AuthenticatedClient;
  registerOrganizationTools(server as never, client);
  return handlers;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => JSON.stringify(body),
  } as Response;
}

async function callTool(name: string, args: unknown = {}) {
  const handler = registerTools().get(name);
  if (!handler) throw new Error(`${name} was not registered`);
  const result = await handler(args);
  return JSON.parse(result.content[0].text);
}

describe('organization tools', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers both tools', () => {
    expect([...registerTools().keys()].sort())
      .toEqual(['list_organizations', 'switch_organization']);
  });

  it('lists organizations with the active one flagged', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.endsWith('/auth/teams/')
        ? jsonResponse([ACME, GLOBEX])
        : jsonResponse({ unique_organization_id: 'org-globex' })
    )));
    const payload = await callTool('list_organizations');
    expect(payload.organizations.find((o: any) => o.is_current).name).toBe('Globex');
  });

  it('still lists when the current-organization lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.endsWith('/auth/teams/')
        ? jsonResponse([ACME])
        : jsonResponse({ error: 'boom' }, 500)
    )));
    const payload = await callTool('list_organizations');
    expect(payload.organizations).toHaveLength(1);
    expect(payload.organizations[0].is_current).toBe(false);
  });

  it('switches by name and PATCHes the resolved team id', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/teams/') && init?.method === 'PATCH') {
        return jsonResponse({ message: 'Team switched successfully.' });
      }
      return url.endsWith('/auth/teams/')
        ? jsonResponse([ACME, GLOBEX])
        : jsonResponse({ unique_organization_id: 'org-globex' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const payload = await callTool('switch_organization', { organization: 'Acme' });
    expect(payload).toMatchObject({ switched: true, active_organization: 'Acme' });

    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(patch![1]!.body as string)).toEqual({ team: 11 });
  });

  it('reports a selection problem as a message, not a thrown tool error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.endsWith('/auth/teams/')
        ? jsonResponse([ACME, GLOBEX])
        : jsonResponse({ unique_organization_id: 'org-acme' })
    )));
    const payload = await callTool('switch_organization', { organization: 'Nope' });
    expect(payload.error).toMatch(/No organization matches "Nope"/);
  });

  it('explains that API-key sessions cannot switch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'no' }, 401)));
    const listed = await callTool('list_organizations');
    expect(listed.error).toMatch(/only available when signed in through OAuth/);
    const switched = await callTool('switch_organization', { organization: 'Acme' });
    expect(switched.error).toMatch(/only available when signed in through OAuth/);
  });
});
