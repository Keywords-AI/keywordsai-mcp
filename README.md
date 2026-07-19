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
