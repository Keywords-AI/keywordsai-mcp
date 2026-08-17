// lib/account/organizations.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { rawFetch, requireClient } from "../shared/client.js";

const TEAMS_PATH = "/auth/teams/";
const CURRENT_ORGANIZATION_PATH = "/auth/current-organization/";

/** One row of `GET /auth/teams/`, narrowed to what these tools use. */
type TeamRow = {
  // Role id, and the value `PATCH /auth/teams/` expects as `team`. Null for
  // sibling orgs in the same company that the user has no membership in —
  // those are visible but cannot be switched to.
  id: number | null;
  role: string | null;
  organization?: {
    id?: string;
    unique_organization_id?: string;
    name?: string;
  } | null;
};

export type Organization = {
  team_id: number | null;
  name: string;
  organization_id: string;
  role: string | null;
  is_current: boolean;
  is_switchable: boolean;
};

/** True when the backend rejected the call because it was not JWT-authenticated. */
function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && /^401\b/.test(error.message);
}

const API_KEY_HINT = "Organization switching is only available when signed in through "
  + "OAuth. An API key is already bound to a single organization — to use a different "
  + "one, create a key in that organization.";

export function toOrganizations(
  rows: TeamRow[],
  currentOrganizationId: string | undefined,
): Organization[] {
  return rows.map((row) => {
    const organizationId = row.organization?.unique_organization_id
      ?? row.organization?.id
      ?? "";
    return {
      team_id: row.id,
      name: row.organization?.name ?? "(unnamed)",
      organization_id: organizationId,
      role: row.role,
      is_current: Boolean(currentOrganizationId)
        && organizationId === currentOrganizationId,
      // A row with no role id is a sibling org the user is not a member of.
      is_switchable: row.id !== null,
    };
  });
}

export class OrganizationSelectionError extends Error {}

/**
 * Resolve what the caller typed — an org name, an org UUID, or a role id —
 * to the role id `PATCH /auth/teams/` wants.
 *
 * Names are matched case-insensitively. An ambiguous or unknown selector is an
 * error naming the candidates rather than a silent pick, because guessing wrong
 * here silently points every later tool call at another customer's data.
 */
export function resolveTeamId(
  organizations: Organization[],
  selector: string,
): number {
  const wanted = selector.trim();
  const lowered = wanted.toLowerCase();
  const matches = organizations.filter((organization) => (
    organization.organization_id === wanted
    || String(organization.team_id) === wanted
    || organization.name.toLowerCase() === lowered
  ));

  if (matches.length === 0) {
    const known = organizations.map((o) => `${o.name} (${o.organization_id})`).join(", ");
    throw new OrganizationSelectionError(
      `No organization matches "${selector}". Available: ${known || "none"}.`,
    );
  }
  if (matches.length > 1) {
    const candidates = matches
      .map((o) => `${o.name} (${o.organization_id})`)
      .join(", ");
    throw new OrganizationSelectionError(
      `"${selector}" matches more than one organization: ${candidates}. `
      + "Retry with the organization_id.",
    );
  }

  const [match] = matches;
  if (match.team_id === null) {
    throw new OrganizationSelectionError(
      `You are not a member of "${match.name}" — it is visible because it belongs `
      + "to your company, but it cannot be selected. Ask an admin for an invitation.",
    );
  }
  return match.team_id;
}

async function fetchOrganizations(
  client: AuthenticatedClient,
): Promise<Organization[]> {
  const [teams, current] = await Promise.all([
    rawFetch(client, TEAMS_PATH, { method: "GET" }),
    // Only used to flag which row is active; a failure here must not take the
    // listing down with it.
    rawFetch(client, CURRENT_ORGANIZATION_PATH, { method: "GET" })
      .catch(() => null),
  ]);
  const currentOrganizationId = (current as { unique_organization_id?: string } | null)
    ?.unique_organization_id;
  return toOrganizations(
    Array.isArray(teams) ? teams as TeamRow[] : [],
    currentOrganizationId,
  );
}

function asText(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function registerOrganizationTools(
  server: McpServer,
  client: AuthenticatedClient | null,
) {
  // --- List Organizations ---
  server.tool(
    "list_organizations",
    `List the organizations (teams/projects) your account can act as, and show which one is active.

Every other tool reads and writes the ACTIVE organization only. If results look
empty or belong to the wrong team, call this first to confirm which organization
is active, then use switch_organization.

RESPONSE FIELDS:
- team_id: Identifier used by switch_organization (null if you are not a member)
- name: Organization name
- organization_id: Stable organization UUID — the unambiguous way to select one
- role: Your role in that organization (null if you are not a member)
- is_current: Whether this organization is currently active
- is_switchable: False for organizations in your company that you have not been
  invited to; these are visible but cannot be selected`,
    {},
    async () => {
      const c = requireClient(client);
      try {
        return asText({ organizations: await fetchOrganizations(c) });
      } catch (error) {
        if (isUnauthorized(error)) return asText({ error: API_KEY_HINT });
        throw error;
      }
    },
  );

  // --- Switch Organization ---
  server.tool(
    "switch_organization",
    `Switch the active organization for your Respan account.

Accepts an organization name, an organization_id UUID, or a team_id — run
list_organizations first to see the options. Names are matched
case-insensitively, and an ambiguous name is rejected rather than guessed.

IMPORTANT — this changes the active organization for your whole account, not
just this conversation. The Respan web app will show the newly selected
organization too, and any other active session follows the same switch. It
persists until it is changed again.

After switching, every subsequent tool call reads and writes the new
organization.`,
    {
      organization: z.string().describe(
        "Organization name, organization_id UUID, or team_id from list_organizations",
      ),
    },
    async ({ organization }) => {
      const c = requireClient(client);
      try {
        const organizations = await fetchOrganizations(c);
        const teamId = resolveTeamId(organizations, organization);
        await rawFetch(c, TEAMS_PATH, {
          method: "PATCH",
          body: { team: teamId },
        });
        const selected = organizations.find((o) => o.team_id === teamId);
        return asText({
          switched: true,
          active_organization: selected?.name,
          organization_id: selected?.organization_id,
          note: "This is account-wide: the Respan web app and other sessions now "
            + "use this organization too.",
        });
      } catch (error) {
        if (error instanceof OrganizationSelectionError) {
          return asText({ error: error.message });
        }
        if (isUnauthorized(error)) return asText({ error: API_KEY_HINT });
        throw error;
      }
    },
  );
}
