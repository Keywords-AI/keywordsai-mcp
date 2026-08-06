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

Tools come from two places.

**Synced tools** are generated from the Respan backend's own tool registry, so
their names, descriptions and parameter schemas match the in-product agent
exactly. They live in `lib/generated/manifest.json` and use the backend's
`noun_verb` naming (`log_list`, `trace_get`, `prompt_create`). Regenerate them
with `scripts/generate_manifest.py`; see [Syncing the tool surface](#syncing-the-tool-surface).

**Legacy tools** are the original hand-written set below, using `verb_noun`
naming (`list_logs`, `get_trace_tree`). They are unchanged and still supported.
Where a legacy tool and a synced tool cover the same endpoint, either works.
The legacy set is expected to be retired once the sync reaches full coverage,
which will be announced before it happens.

Not every backend tool is exposed here. A tool is held back when its endpoint
requires JWT authentication (an API key cannot call it), when its backend
behaviour could not be verified mechanically, or when it is known to fail under
API-key auth. Each held-back tool carries a machine-readable `excluded` reason
in the manifest.

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

## Organization scoping

Every request this server makes carries `X-Respan-Agent-Scope: own-org`. This is
a security invariant, not a setting.

A token presented to this server may belong to a Respan staff member. Without
that header such a token resolves to `is_superadmin()` on the backend and reads
across organizations through `SuperAdminMixin`. The header makes the backend
force `is_superadmin()` to false, so the request is served from the caller's own
organization only. It can never raise privilege, only drop it.

All three outbound transports set it: the generated SDK client (via constructor
headers), `rawFetch`, and the synced-tool dispatcher. **Any new transport must
set it too.** There is a check for exactly this:

```bash
npm run build:server && node scripts/verify-own-org-header.mjs
```

It runs one tool through each transport against a local server and exits
non-zero if any request is missing the header.

Note that this scopes a staff token down; it does not reject one. Refusing
staff-owned credentials outright cannot be done here, because an API key cannot
query its own privilege level (`/auth/users/me/` is JWT-only). That gate belongs
on the backend and is tracked as a follow-up.

## Syncing the tool surface

`lib/generated/manifest.json` is generated, not hand-edited. It is produced from
the backend's `utils.mcp.tool_bridge.register_tools`, which is the same registry
the in-product agent uses, so the two surfaces cannot drift on tool names,
descriptions or schemas.

Routes are derived rather than written by hand. The generator invokes each
backend executor with the HTTP layer stubbed and unique sentinel arguments, then
inspects the request that would have been sent to learn where every argument
belongs (URL segment, query parameter, or request body). A tool is registered
only when every one of its arguments was located. Anything unresolved is
recorded with a reason and left unregistered, so no tool is ever wired to a
guessed endpoint.

To regenerate, run against a backend checkout using its virtualenv:

```bash
cd <respan-backend>
./.venv/bin/python <respan-mcp>/scripts/generate_manifest.py \
    --out <respan-mcp>/lib/generated/manifest.json
```

The script prints how many tools were registered and why each remaining one was
held back. Re-running it on an unchanged backend reproduces the file exactly.

## Local Development

```bash
npm run build        # Compile TypeScript
npm run watch        # Watch mode
npm run stdio        # Build and run in stdio mode
```

---

## Documentation

Full documentation at [docs.respan.ai/documentation/resources/mcp](https://docs.respan.ai/documentation/resources/mcp)

## License

MIT
