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
git clone https://github.com/Keywords-AI/keywordsai-mcp.git
cd keywordsai-mcp
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

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Keywords-AI/keywordsai-mcp&env=RESPAN_API_KEY&envDescription=Your%20Respan%20API%20key&envLink=https://platform.respan.ai/platform/api/api-keys)

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
│   └── mcp.ts                # HTTP entry point (Vercel serverless function)
├── lib/
│   ├── index.ts              # Stdio entry point (local mode)
│   ├── shared/
│   │   └── client.ts         # API client, auth config, path validation
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
- **Shared core:** Both entry points create an `AuthConfig` and pass it to the same tool registration functions via closures - no global mutable state
- **Tool modules:** Organized by domain (`observe/` for runtime data, `develop/` for prompt management)
- **API client:** `lib/shared/client.ts` handles all upstream API calls with 30s timeout, path validation, and auth

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

# Used only by the complete local verification probe:
OAUTH_TEST_EMAIL=<local-test-account-email>
OAUTH_TEST_PASSWORD=<local-test-account-password>
OAUTH_TEST_API_KEY=<local-test-api-key>
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

Run the local service and the probe:

```bash
npm run dev:oauth
npm run verify:oauth:local
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
