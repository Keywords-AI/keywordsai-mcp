# Respan MCP Server

Model Context Protocol (MCP) server for [Respan](https://respan.ai) - access logs, prompts, traces, and customer data directly from your AI assistant.

## Features

- **Logs** - Query, filter, and create LLM request logs
- **Traces** - View complete execution traces with span trees
- **Customers** - Access customer data and budget information
- **Prompts** - Manage prompt templates and versions

---

## Quick Start

### Option 1: Public HTTP (Recommended)

No installation required.

1. Get your API key from [platform.respan.ai](https://platform.respan.ai/platform/api/api-keys)

2. Add to your MCP config file:

**Cursor** (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "respan": {
      "url": "https://mcp.respan.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_RESPAN_API_KEY"
      }
    }
  }
}
```

**Claude Desktop** (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "respan": {
      "url": "https://mcp.respan.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_RESPAN_API_KEY"
      }
    }
  }
}
```

3. Restart Cursor/Claude Desktop

---

### Option 2: Local Stdio

Run the MCP server locally for personal development or offline use.

**Prerequisites:** Node.js v18+

```bash
git clone https://github.com/respanai/respan-mcp.git
cd respan-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "respan": {
      "command": "node",
      "args": ["/absolute/path/to/respan-mcp/dist/lib/index.js"],
      "env": {
        "RESPAN_API_KEY": "YOUR_RESPAN_API_KEY"
      }
    }
  }
}
```

---

### Option 3: Private HTTP (Teams)

Deploy your own instance to Vercel for teams sharing a single deployment.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/respanai/respan-mcp&env=RESPAN_API_KEY&envDescription=Your%20Respan%20API%20key&envLink=https://platform.respan.ai/platform/api/api-keys)

Set `RESPAN_API_KEY` in Vercel Dashboard > Settings > Environment Variables.

Share this config with your team:
```json
{
  "mcpServers": {
    "respan": {
      "url": "https://your-project.vercel.app/mcp"
    }
  }
}
```

---

## Available Tools

### Server

| Tool | Description |
|------|-------------|
| `server_info` | Deployed commit sha, branch, deploy/boot timestamps, tool count, tool schema fingerprint and backend targets |

`server_info` takes no arguments and makes no backend calls. Use it from an
agent session to check whether the live server has picked up a change: compare
`commit_sha` with the tip of `main`, or `tool_schema_fingerprint` with the value
from a fresh session. The same payload is served unauthenticated at
[`GET /health`](#health-and-deploy-verification).

### Organizations

| Tool | Description |
|------|-------------|
| `list_organizations` | List the organizations your account can act as, and which one is active |
| `switch_organization` | Switch the active organization by name, `organization_id`, or `team_id` |

Every other tool reads and writes the **active** organization only. Switching is
account-wide and persistent — it moves the Respan web app and any other session
to the same organization, because the backend stores the active organization on
the user record rather than on the token. Requires an OAuth login; an API key is
already bound to one organization and cannot switch.

### Logs

| Tool | Description |
|------|-------------|
| `list_logs` | List and filter LLM request logs with powerful query capabilities |
| `get_log_detail` | Retrieve complete details of a single log by unique ID |
| `create_log` | Create a new log entry for any type of LLM request |

### Traces

| Tool | Description |
|------|-------------|
| `list_traces` | List and filter traces with sorting and pagination |
| `get_trace_tree` | Retrieve complete hierarchical span tree of a trace |

### Customers

| Tool | Description |
|------|-------------|
| `list_customers` | List customers with pagination and sorting |
| `get_customer_detail` | Get customer details including budget usage |

### Prompts

| Tool | Description |
|------|-------------|
| `list_prompts` | List all prompts in your organization |
| `get_prompt_detail` | Get detailed prompt information |
| `list_prompt_versions` | List all versions of a prompt |
| `get_prompt_version_detail` | Get specific version details |

### Workflows

| Tool | Description |
|------|-------------|
| `list_workflows` | List automations, monitors, scheduled exports, and evaluator pipelines |
| `filter_workflows` | Filter workflows by type or other fields |
| `get_workflow` | Retrieve a workflow and its task definitions |
| `create_automation_workflow` | Create an event-driven automation; adds the required dashboard sampling gate |
| `create_monitor_workflow` | Create a monitor from aggregation/condition and delivery tasks |
| `create_export_workflow` | Create a scheduled export from cron and export-specific options |
| `create_workflow` | Advanced low-level workflow creation escape hatch |
| `update_workflow` | Update an editable workflow draft |
| `delete_workflow` | Delete a workflow family and all versions |
| `list_workflow_versions` | List versions in a workflow family |
| `get_workflow_version` | Retrieve a specific workflow version |
| `commit_workflow` | Commit the current draft |
| `deploy_workflow` | Deploy a committed workflow version |
| `undeploy_workflow` | Stop a deployed workflow |
| `validate_workflow` | Validate workflow tasks against sample data |

The backend route is shared, but the MCP creation functions are intentionally separate. Automations are event-driven task pipelines and receive the dashboard-compatible `auto-sampling` gate; monitors accept aggregation, condition, and delivery tasks and require a notification or webhook; exports accept a UTC five-field cron plus export-specific filters, fields, inline-result behavior, and sampling.

---

## Filter Syntax

Tools that support filtering accept a `filters` object:

```json
{
  "cost": {"operator": "gt", "value": [0.01]},
  "model": {"operator": "", "value": ["gpt-4"]},
  "customer_identifier": {"operator": "contains", "value": ["user"]},
  "metadata__session_id": {"operator": "", "value": ["abc123"]}
}
```

**Operators:** `""` (equal), `not`, `lt`, `lte`, `gt`, `gte`, `contains`, `icontains`, `startswith`, `endswith`, `in`, `isnull`

---

## Project Structure

```
respan-mcp/
├── api/
│   ├── mcp.ts                # HTTP entry point (Vercel serverless function)
│   └── health.ts             # GET /health deployment identity probe
├── lib/
│   ├── index.ts              # Stdio entry point (local mode)
│   ├── shared/
│   │   ├── client.ts         # API client, auth config, path validation
│   │   ├── tools.ts          # Single tool registration list for every entry point
│   │   ├── server-info.ts    # server_info tool, /health payload, schema fingerprint
│   │   └── build-info.ts     # Build-time commit stamp (placeholders in git)
│   ├── observe/
│   │   ├── logs.ts           # list_logs, get_log_detail, create_log
│   │   ├── traces.ts         # list_traces, get_trace_tree
│   │   └── users.ts          # list_customers, get_customer_detail
│   ├── account/
│   │   └── organizations.ts  # list_organizations, switch_organization
│   └── develop/
│       └── prompts.ts        # list_prompts, get_prompt_detail, versions
├── vercel.json               # Vercel config (rewrites, function timeout)
├── tsconfig.json             # TypeScript config
└── package.json
```

### Architecture

- **Two entry points:** `api/mcp.ts` (HTTP via Vercel) and `lib/index.ts` (stdio for local use)
- **One tool registry:** both entry points build servers through `lib/shared/tools.ts`, so the hosted and stdio tool surfaces (and the `/health` schema fingerprint) cannot drift apart
- **Shared core:** Both entry points create an `AuthConfig` and pass it to the same tool registration functions via closures - no global mutable state
- **Tool modules:** Organized by domain (`observe/` for runtime data, `develop/` for prompt management)
- **API client:** `lib/shared/client.ts` handles all upstream API calls with 30s timeout, path validation, and auth

---

## Health and Deploy Verification

`GET https://mcp.respan.ai/health` needs no credentials and returns static
deployment metadata (nothing from the request is echoed):

```json
{
  "ok": true,
  "service": "respan-mcp",
  "version": "1.0.0",
  "commit_sha": "8a6f5df4fa2d30c8f372e0c4a48e674d15bdff8b",
  "branch": "main",
  "deployed_at": "2026-09-06T23:01:49.992Z",
  "started_at": "2026-09-06T23:01:49.992Z",
  "tool_count": 68,
  "tool_schema_fingerprint": "1d7a561769e5c007",
  "backend_targets": {
    "platform": "https://api.respan.ai/api",
    "enterprise": "https://endpoint.respan.ai/api"
  }
}
```

- `commit_sha` / `branch` come from Vercel's `VERCEL_GIT_COMMIT_SHA` /
  `VERCEL_GIT_COMMIT_REF` at runtime, falling back to the build-time stamp that
  `scripts/stamp-build-info.mjs` writes into `lib/shared/build-info.ts` during
  the Vercel build (the committed file holds `unknown` placeholders).
- `deployed_at` is the build timestamp when stamped, otherwise the instance boot
  time; `started_at` is always the boot time of the serving instance.
- `tool_schema_fingerprint` is the first 16 hex chars of a SHA-256 over the
  sorted, canonical-JSON list of every tool's name, description, input and
  output schema as clients see them in `tools/list`. It ignores registration
  order and the `respan-enabled-tools` header, so it changes only when the tool
  surface changes.
- `backend_targets` are the platform and enterprise base URLs this deployment
  routes to, after `RESPAN_API_BASE_URL` / `RESPAN_ENTERPRISE_API_BASE_URL`.

The `verify-production-deploy` GitHub Actions workflow runs when Vercel reports
a successful Production deployment of `main` and polls `/health` for up to ten
minutes until `commit_sha` equals the deployed commit, failing otherwise. It
can also be dispatched by hand with an `expected_sha` input.

---

## Enterprise Configuration

For custom API endpoints, set the `RESPAN_API_BASE_URL` environment variable:

**Stdio mode:**
```json
{
  "mcpServers": {
    "respan": {
      "command": "node",
      "args": ["/path/to/respan-mcp/dist/lib/index.js"],
      "env": {
        "RESPAN_API_KEY": "YOUR_API_KEY",
        "RESPAN_API_BASE_URL": "https://your-endpoint.example.com/api"
      }
    }
  }
}
```

**Private deployment:** Set `RESPAN_API_BASE_URL` in Vercel environment variables.

---

## Local Development

```bash
npm run build        # Compile TypeScript
npm run stdio        # Build and run in stdio mode
```

### Local OAuth broker

The repository includes a Vercel-independent HTTP harness for the public OAuth
and MCP routes. It uses the existing local backend and Redis services; it does
not start, restart, or clear either service.

Create a gitignored `.env.local`:

```dotenv
OAUTH_SECRET=<locally-generated-random-secret-of-at-least-32-characters>
OAUTH_SESSION_STORE=redis
REDIS_URL=redis://127.0.0.1:6379/15
MCP_REDIS_KEY_PREFIX=respan-mcp:local:
MCP_PUBLIC_BASE_URL=http://127.0.0.1:3100
MCP_ACCESS_TOKEN_TTL_SECONDS=60
RESPAN_API_BASE_URL=http://127.0.0.1:8000/api
RESPAN_ENTERPRISE_API_BASE_URL=http://127.0.0.1:8000/api

# Used only by the complete local verification probe:
OAUTH_TEST_EMAIL=<local-test-account-email>
OAUTH_TEST_PASSWORD=<local-test-account-password>
# Required by the platform probe's API-key compatibility check.
OAUTH_TEST_API_KEY=<local-test-api-key>
# Optional; defaults to platform. Also accepts enterprise.
OAUTH_TEST_REALM=platform
```

To exercise the same Upstash REST adapter used by Vercel, replace the local
Redis settings with:

```dotenv
OAUTH_SESSION_STORE=upstash
UPSTASH_REDIS_REST_URL=<upstash-rest-url>
UPSTASH_REDIS_REST_TOKEN=<upstash-rest-token>
```

Keep the local key prefix distinct from Preview and Production. The probe
always replaces it with a unique per-run prefix and deletes only those keys.

For manual browser testing, run the local service:

```bash
npm run dev:oauth
```

The automated verification command launches its own isolated broker harness,
so run it without a separate `dev:oauth` process:

```bash
npm run verify:oauth:local
```

To exercise the same lifecycle through the enterprise resource and backend,
run:

```bash
OAUTH_TEST_REALM=enterprise npm run verify:oauth:local
```

To verify that refresh rotation does not extend an absolute refresh-session
deadline, run the probe with a short local lifetime:

```bash
OAUTH_VERIFY_REFRESH_EXPIRY=true \
MCP_REFRESH_SESSION_TTL_SECONDS=180 \
npm run verify:oauth:local
```

The probe rotates the refresh token after the access token expires, waits until
three minutes from the original session issuance, and then requires
`invalid_grant` from the latest refresh token. This setting is for local
verification only.

The probe starts its own isolated harness on `127.0.0.1:3100`, uses a unique
Redis key prefix, prints only step status and duration, and removes only keys
under that unique prefix. Do not run `dev:oauth` simultaneously on the same
port. Google login requires separately configured local backend credentials;
the deterministic automated suite covers the broker behavior without them.

Hosted OAuth client registrations accept HTTPS callbacks and HTTP callbacks
bound to loopback — the literal addresses `127.0.0.1` and `[::1]`, or the
hostname `localhost`, which is what Claude Code and the MCP Inspector register.
The hostname match is exact, so `localhost.attacker.example` and
`sub.localhost` are not loopback. Other HTTP hosts, executable URL schemes,
credentials, fragments, duplicate callbacks, and oversized callback lists are
rejected.

Vercel deployments require Upstash rather than the in-memory store. Production
public and backend URLs must use HTTPS, and OAuth secrets and Redis credentials
must be configured only through the deployment secret manager.

For the complete Preview and Production setup, environment-variable matrix,
Vercel service configuration, verification gate, monitoring, and rollback
procedure, see [Public MCP OAuth Broker: Vercel Deployment Runbook](docs/vercel-oauth-deployment.md).

Automated checks:

```bash
npm test
TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm test -- --run tests/redis-store.integration.test.ts
npm run build
git diff --check
```

---

## Documentation

Full documentation at [docs.respan.ai/documentation/resources/mcp](https://docs.respan.ai/documentation/resources/mcp)

## License

MIT
