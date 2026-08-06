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

Tool names follow the Respan backend exactly: `noun_verb`, lowercase, with the
resource first. `log_list`, `trace_get`, `prompt_create`, `monitor_deploy`. The
resource leads because that is what you are usually searching for.

Earlier releases used the opposite order (`list_logs`, `create_workflow`). Those
names have been **replaced, not aliased** — see [Migrating from the old tool
names](#migrating-from-the-old-tool-names).

### Workflow resources are typed

There is no generic workflow tool. Each kind of workflow gets its own set:

| Resource | What it does |
| --- | --- |
| `monitor_*` | Watches incoming telemetry and alerts when a condition trips |
| `automation_*` | Runs a task sequence against incoming telemetry (online eval) |
| `report_*` | Scheduled digest assembled from logs, traces and pulses |
| `evaluator_*` | Grading pipeline composed of one or more graders |
| `grader_*` | The individual graders an evaluator is built from |

Each carries the same lifecycle verbs where they apply: `_list`, `_get`,
`_create`, `_update`, `_commit`, `_deploy`, `_undeploy`, `_version_list`,
`_validate`.

This split is deliberate. A single `create_workflow` taking a `type` argument
reads as the obvious choice for "create a monitor", and the type then has to be
guessed. `monitor_create` removes the guess, so the workflow kind is fixed by
the tool you picked rather than by an argument you filled in.

Note the vocabulary: a **grader** is one scoring unit, an **evaluator** is a
pipeline composed of graders. `grader_create` builds a scorer;
`evaluator_create` assembles them.

### Getting the current list

Tool definitions are generated, so this README is not the source of truth. Call
`tools/list`, or read `lib/generated/manifest.json`, which carries every tool's
name, description and parameter schema.

The server publishes **171 tools**, covering the full in-product agent surface.
`npm run verify` fails if a tool in that surface is missing here without a
recorded reason, so the two cannot drift apart silently.

One tool is deliberately not exposed: `dashboard_platform_public_stats` returns
Respan-wide aggregates rather than your own data. Its reason is recorded in
`scripts/verify-agent-parity.mjs`.

### Loading only the tools you need

171 tools is roughly 67k tokens of definitions, which every client loads before
making a call. If that is more than you want, send a `Respan-Enabled-Tools`
header listing the tool names to register, and the server skips the rest:

```json
{
  "mcpServers": {
    "respan": {
      "url": "https://mcp.respan.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_RESPAN_API_KEY",
        "Respan-Enabled-Tools": "log_list,log_get,trace_list,trace_get"
      }
    }
  }
}
```

This is a convenience filter, not a permission boundary. It changes what is
advertised, not what your token can reach.

## Migrating from the old tool names

If you pinned specific tool names, rename them. There is no compatibility
period, because leaving the old names registered would keep them competing with
the new ones for the same request.

| Old | New |
| --- | --- |
| `list_logs`, `get_log_detail`, `get_spans_summary` | `log_list`, `log_get`, `log_summary` |
| `list_traces`, `get_trace_tree` | `trace_list`, `trace_get` |
| `list_customers`, `get_customer_detail` | `customer_list`, `customer_get` |
| `list_prompts`, `get_prompt_detail` | `prompt_list`, `prompt_get` |
| `create_prompt_version` | `prompt_commit` |
| `deploy_prompt_version` | `prompt_deploy` |
| `list_experiments`, `get_experiment` | `experiment_list`, `experiment_get` |
| `list_experiment_spans` | `experiment_logs_list` |
| `list_datasets`, `get_dataset` | `dataset_list`, `dataset_get` |
| `list_dataset_logs`, `summarize_dataset_logs` | `dataset_logs_list`, `dataset_logs_summary` |
| `import_dataset_logs` | `dataset_logs_import` |
| `retrieve_dataset_log`, `replace_dataset_log` | `dataset_log_get`, `dataset_log_update` |
| `remove_dataset_logs`, `list_dataset_eval_runs` | `dataset_logs_delete`, `dataset_eval_runs_list` |
| `list_evaluators`, `create_evaluator` | `grader_list`, `grader_create` |
| `test_evaluator`, `run_evaluator` | `grader_run` |
| `create_evaluation_pipeline` | `evaluator_create` |
| `search_docs` | `docs_search` |
| `create_workflow`, `get_workflow`, `commit_workflow`, … | `monitor_*`, `automation_*`, `report_*`, `evaluator_*` |

`scripts/verify-tool-naming.mjs` enforces the convention: it fails if any tool
name contains "workflow", if a verb-first name reappears, or if names collide.


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
│   ├── mcp/enterprise.ts     # Same handler, enterprise base URL
│   └── mcp/docs.ts           # Unauthenticated documentation server
├── lib/
│   ├── index.ts              # Stdio entry point (local mode)
│   ├── shared/
│   │   ├── client.ts         # API client, auth, org scoping headers
│   │   ├── sanitize.ts       # Credential masking for tool output
│   │   └── mcp-handler.ts    # HTTP server factory, tool whitelist
│   ├── generated/
│   │   ├── manifest.json     # Generated tool surface (do not hand-edit)
│   │   ├── register.ts       # Registers tools that have a verified route
│   │   └── schema-to-zod.ts  # JSON Schema -> Zod for the manifest
│   ├── observe/              # log_*, trace_*, customer_*
│   ├── develop/              # prompt_*, experiment_*, and the typed
│   │                         #   monitor_* / automation_* / report_* sets
│   ├── evaluate/             # grader_*, evaluator_*, dataset_*
│   └── docs/                 # docs_search
├── scripts/
│   ├── generate_manifest.py       # Regenerates the tool surface
│   ├── verify-own-org-header.mjs  # Security check (org scoping)
│   └── verify-tool-naming.mjs     # Naming convention check
├── vercel.json
├── tsconfig.json
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

Run every check at once with:

```bash
npm run verify
```

That covers naming (`noun_verb`, no generic workflow tools, no descriptions
pointing at tools this server does not publish), agent-tier parity, pagination
bounds against the backend, and the scoping headers above.

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
