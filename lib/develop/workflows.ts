import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient, rawFetch } from "../shared/client.js";

const eventDrivenTriggerSchema = z.enum([
  "request_log",
  "trace_completed",
  "customer_budget_limit_reached",
  "credit_low_balance_threshold_reached",
  "spend_cap_warning",
  "limit_policy_soft_triggered",
  "limit_policy_hard_triggered",
  "on_eval_result_ingested",
  "custom_event",
]);

const conditionRuleSchema = z.object({
  operator: z.enum(["eq", "not", "in", "gt", "gte", "lt", "lte", "icontains", "startswith", "empty", "not_empty"]),
  value: z.any(),
});

const taskEnvelope = {
  id: z.string().min(1).describe("Unique task ID used by next pointers and state references."),
  label: z.string().min(1).describe("Human-readable task label."),
  next: z.string().min(1).optional().describe("ID of the next task. Omit for a terminal task."),
};

const conditionTaskSchema = z.object({
  ...taskEnvelope,
  type: z.literal("condition"),
  config: z.object({
    condition_policy: z.record(conditionRuleSchema),
    on_true: z.enum(["continue", "stop"]).optional(),
    on_false: z.enum(["continue", "stop"]).optional(),
  }),
});

const aggregationMetricSchema = z.object({
  field_name: z.string().optional().describe("Event/state field; may be omitted for count."),
  aggregation_function: z.enum(["sum", "avg", "count", "max", "min"]),
  output_field_name: z.string().min(1),
  filters: z.record(conditionRuleSchema).optional(),
});

const aggregationTaskSchema = z.object({
  ...taskEnvelope,
  type: z.literal("aggregation"),
  config: z.object({
    time_step_minutes: z.number().int().min(1).max(10080).optional(),
    metrics: z.array(aggregationMetricSchema).min(1),
    emission_mode: z.enum(["streaming", "periodic", "mixed"]).optional(),
    is_comparing_to_previous: z.boolean().optional(),
  }),
});

const webhookTaskSchema = z.object({
  ...taskEnvelope,
  type: z.literal("webhook"),
  config: z.object({
    webhook_url: z.string().url(),
    webhook_secret: z.string().optional(),
    is_including_scores: z.boolean().optional(),
    source: z.string().optional().describe('"event", "input", or "state.<task_id>".'),
  }),
});

const notificationTaskSchema = z.object({
  ...taskEnvelope,
  type: z.literal("notification"),
  config: z.object({
    notification_method_id: z.string().min(1),
    message_template: z.string().optional(),
    subject_template: z.string().optional(),
    selected_variables: z.array(z.string()).optional(),
    severity: z.enum(["low", "medium", "high", "urgent"]).optional(),
  }),
});

const throttleTaskSchema = z.object({
  ...taskEnvelope,
  type: z.literal("throttle"),
  config: z.object({ cooldown_seconds: z.number().int().min(1).max(86400) }),
});

const evalTaskSchema = z.object({
  ...taskEnvelope,
  type: z.literal("eval"),
  config: z.object({ evaluator_id: z.string().min(1) }),
});

const ingestTaskSchema = z.object({
  ...taskEnvelope,
  type: z.literal("ingest"),
  config: z.object({
    target_type: z.enum(["dataset", "log", "experiment"]),
    target: z.record(z.any()),
    source: z.string().optional(),
  }),
});

const computeTaskSchema = z.object({
  ...taskEnvelope,
  type: z.literal("compute"),
  config: z.object({
    function: z.enum(["ratio", "percentage", "difference", "weighted_average"]),
    inputs: z.array(z.object({
      source: z.string().min(1),
      field: z.string().min(1),
      weight: z.number().optional(),
    })).min(2),
  }),
});

const switchTaskSchema = z.object({
  ...taskEnvelope,
  type: z.literal("switch"),
  config: z.object({
    cases: z.array(z.object({
      condition_policy: z.record(conditionRuleSchema),
      target: z.string().min(1),
    })).min(1),
    default: z.string().optional(),
  }),
});

const automationTaskSchema = z.discriminatedUnion("type", [
  conditionTaskSchema,
  throttleTaskSchema,
  aggregationTaskSchema,
  computeTaskSchema,
  switchTaskSchema,
  webhookTaskSchema,
  notificationTaskSchema,
  evalTaskSchema,
  ingestTaskSchema,
]);

const monitorTaskSchema = z.discriminatedUnion("type", [
  aggregationTaskSchema,
  conditionTaskSchema,
  notificationTaskSchema,
  webhookTaskSchema,
]);

export function registerWorkflowTools(
  server: McpServer,
  client: AuthenticatedClient | null
) {
  server.tool(
    "list_workflows",
    "List all workflows (automations, monitors, scheduled exports, and evaluator pipelines) in your organization.",
    {
      page: z.number().optional().describe("Page number (default 1)."),
      page_size: z.number().optional().describe("Results per page."),
    },
    async ({ page, page_size }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.listWorkflows({
        Authorization: c.auth,
        ...(page ? { page } : {}),
        ...(page_size ? { page_size } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "filter_workflows",
    `Filter workflows by type and other fields.

Use the filters parameter to scope by type:
- { "type": { "value": ["automations"], "operator": "eq" } }
- { "type": { "value": ["monitors"], "operator": "eq" } }
- { "type": { "value": ["exports"], "operator": "eq" } }
- { "type": { "value": ["evaluators"], "operator": "eq" } }`,
    {
      filters: z.record(z.any()).describe('Filter object. Example: { "type": { "value": ["monitors"], "operator": "eq" } }'),
      page: z.number().optional().describe("Page number."),
      page_size: z.number().optional().describe("Results per page."),
      sort_by: z.string().optional().describe("Sort field. Prefix with - for descending."),
    },
    async ({ filters, page, page_size, sort_by }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.filterWorkflows({
        Authorization: c.auth,
        filters,
        ...(page ? { page } : {}),
        ...(page_size ? { page_size } : {}),
        ...(sort_by ? { sort_by } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "get_workflow",
    "Retrieve detailed information about a workflow including its task definitions.",
    {
      workflow_id: z.string().describe("Workflow ID."),
    },
    async ({ workflow_id }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.getWorkflow({
        Authorization: c.auth,
        workflow_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "create_automation_workflow",
    `Create an event-driven Automation workflow.

This tool fixes type to "automations" and automatically prepends the dashboard-compatible
{id: "auto-sampling", type: "sampling"} gate. Provide the business tasks that follow it.
Use condition/throttle gates, aggregation/compute/switch logic, and webhook/notification/eval/ingest actions.`,
    {
      name: z.string().min(1).describe("Automation name."),
      description: z.string().optional().describe("Human-readable purpose."),
      trigger_event_type: eventDrivenTriggerSchema.describe("Event that starts the automation."),
      sampling_rate: z.number().min(0).max(1).optional().describe("Fraction of events allowed through; defaults to 1 (100%)."),
      tasks: z.array(automationTaskSchema).min(1).describe("Business tasks after the automatic sampling gate. Chain non-terminal tasks with next."),
      is_starred: z.boolean().optional(),
    },
    async ({ name, description, trigger_event_type, sampling_rate, tasks, is_starred }) => {
      if (tasks.some((task) => task.id === "auto-sampling")) {
        throw new Error('Do not include task ID "auto-sampling"; create_automation_workflow adds it automatically.');
      }
      const workflowTasks = [
        {
          id: "auto-sampling",
          type: "sampling",
          label: "Automation sampling gate",
          next: tasks[0].id,
          config: { rate: sampling_rate ?? 1 },
        },
        ...tasks,
      ];
      const c = requireClient(client);
      const data = await rawFetch(c, "/api/workflows/", {
        method: "POST",
        body: {
          name,
          type: "automations",
          trigger_event_type,
          tasks: workflowTasks,
          ...(description !== undefined ? { description } : {}),
          ...(is_starred !== undefined ? { is_starred } : {}),
        },
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_monitor_workflow",
    `Create an event-driven Monitor workflow.

Monitor tasks are intentionally limited to aggregation, condition, notification, and webhook.
The workflow must contain at least one notification or webhook delivery task. Use aggregation
for time windows and condition for the alert threshold.`,
    {
      name: z.string().min(1).describe("Monitor name."),
      description: z.string().optional().describe("Human-readable monitoring objective."),
      trigger_event_type: eventDrivenTriggerSchema.describe("Event stream observed by the monitor."),
      tasks: z.array(monitorTaskSchema).min(2).describe("Monitor pipeline; must include a notification or webhook delivery task."),
      is_starred: z.boolean().optional(),
    },
    async ({ name, description, trigger_event_type, tasks, is_starred }) => {
      const hasDelivery = tasks.some((task) => task.type === "notification" || task.type === "webhook");
      if (!hasDelivery) {
        throw new Error("A monitor requires at least one notification or webhook delivery task.");
      }
      const c = requireClient(client);
      const data = await rawFetch(c, "/api/workflows/", {
        method: "POST",
        body: {
          name,
          type: "monitors",
          trigger_event_type,
          tasks,
          ...(description !== undefined ? { description } : {}),
          ...(is_starred !== undefined ? { is_starred } : {}),
        },
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_export_workflow",
    `Create a scheduled request-log Export workflow.

This tool fixes type to "exports" and trigger_event_type to "scheduled", then builds the
export task from export-specific fields. schedule_cron is a five-field UTC cron expression
with a minimum interval of five minutes.`,
    {
      name: z.string().min(1).describe("Export workflow name."),
      description: z.string().optional().describe("Human-readable export purpose."),
      schedule_cron: z.string().regex(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/).describe("UTC five-field cron expression, for example 0 * * * *."),
      filters: z.record(conditionRuleSchema).optional().describe("Optional request-log filters."),
      include_fields: z.array(z.string().min(1)).optional().describe("Optional request-log field allowlist."),
      is_inline_results: z.boolean().optional().describe("Expose queried rows to downstream workflow state; defaults to true."),
      sample_percentage: z.number().gt(0).max(100).optional().describe("Percentage of matching rows to export."),
      is_starred: z.boolean().optional(),
    },
    async ({ name, description, schedule_cron, filters, include_fields, is_inline_results, sample_percentage, is_starred }) => {
      const exportConfig = {
        ...(filters !== undefined ? { filters } : {}),
        ...(include_fields !== undefined ? { include_fields } : {}),
        ...(is_inline_results !== undefined ? { is_inline_results } : {}),
        ...(sample_percentage !== undefined ? { sample_percentage } : {}),
      };
      const c = requireClient(client);
      const data = await rawFetch(c, "/api/workflows/", {
        method: "POST",
        body: {
          name,
          type: "exports",
          trigger_event_type: "scheduled",
          schedule_cron,
          tasks: [{ id: "export-logs", type: "export", label: "Export request logs", config: exportConfig }],
          ...(description !== undefined ? { description } : {}),
          ...(is_starred !== undefined ? { is_starred } : {}),
        },
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_workflow",
    `Advanced low-level workflow creation. Prefer create_automation_workflow, create_monitor_workflow, or create_export_workflow for the three product workflows because those tools enforce product-specific inputs.

TYPES:
- "monitors": Aggregation + threshold monitoring with notifications (Monitors page)
- "automations": Triggered actions on log/trace events (Automations page)
- "exports": Scheduled, continuous request-log exports. Requires trigger_event_type="scheduled", schedule_cron, and an export task.
- "evaluators": Evaluator pipelines. Prefer create_evaluation_pipeline when wrapping graders.

TRIGGER EVENT TYPES:
- "request_log": Fires on every logged LLM request
- "trace_completed": Fires when a trace finishes
- "customer_budget_limit_reached": Fires on budget breach
- "on_eval_result_ingested": Fires when eval score is recorded
- "scheduled": Runs on a UTC cron schedule. Required for export workflows.
- "eval_only": No trigger, for evaluator pipelines used in experiments

TASK TYPES:
- condition: Filter/gate. Config: { condition_policy: { "event.<field>": { operator, value } }, on_true: "continue", on_false: "stop" }
  Field paths use namespace: event.cost, event.model, event.status, state.<task_id>.<field>
  Operators: "in" (categorical), "gte"/"lte"/"gt"/"lt" (numeric), "icontains"/"startswith" (text)
- aggregation: Time-window metrics. Config: { time_step_minutes: 5, metrics: [{ field_name: "event.cost", aggregation_function: "sum", output_field_name: "cost_sum" }] }
- notification: Alert. Config: { severity: "high", message_template: "Cost: $\{{state.agg.cost_sum}}" }
  Use {{variable}} for template variables.
- webhook: HTTP callback. Config: { webhook_url: "https://...", source: "event" }
- eval: Run evaluator. Config: { evaluator_id: "<uuid>" }
- ingest: Save to dataset. Config: { target_type: "dataset", target: { dataset_id: "<uuid>" } }
- sampling: Random filter. Config: { rate: 0.1 } (10% of events)
- compute: Arithmetic on upstream outputs. Config: { function: "ratio", inputs: [{ source: "state.<id>", field: "<field>" }] }
- export: Append scheduled request logs to the export workflow output. Config: { filters?, include_fields?, is_inline_results?: boolean, sample_percentage?: number }.
- switch: Multi-branch routing. Config: { cases: [{ condition_policy: {...}, target: "<task_id>" }], default: "<task_id>" }

TASK CHAINING: Each task needs "next" pointing to the next task's id. Without "next", the workflow stops.
Task ordering: gates (condition, sampling) → aggregation → actions (notification, webhook, eval, ingest).

EXAMPLE - Cost spike monitor:
{
  "name": "Cost spike monitor",
  "type": "monitors",
  "trigger_event_type": "request_log",
  "tasks": [
    { "id": "agg", "type": "aggregation", "label": "Cost sum (5m)", "next": "check",
      "config": { "time_step_minutes": 5, "metrics": [{ "field_name": "event.cost", "aggregation_function": "sum", "output_field_name": "cost_sum" }] } },
    { "id": "check", "type": "condition", "label": "Cost >= $1", "next": "notify",
      "config": { "on_true": "continue", "on_false": "stop", "condition_policy": { "state.agg.cost_sum": { "operator": "gte", "value": 1 } } } },
    { "id": "notify", "type": "webhook", "label": "Cost alert",
      "config": { "webhook_url": "https://example.com/respan-monitor-alerts", "source": "event" } }
  ]
}

EXAMPLE - Hourly export workflow:
{
  "name": "Hourly request-log export",
  "type": "exports",
  "trigger_event_type": "scheduled",
  "schedule_cron": "0 * * * *",
  "tasks": [
    { "id": "export_logs", "type": "export", "label": "Export request logs",
      "config": { "include_fields": ["timestamp", "model", "input", "output", "cost"], "is_inline_results": false, "sample_percentage": 100 } }
  ]
}`,
    {
      name: z.string().optional().describe("Workflow name."),
      description: z.string().optional().describe("Workflow description."),
      type: z
        .enum(["automations", "monitors", "exports", "evaluators"])
        .describe("Workflow type: automations, monitors, exports, or evaluators."),
      trigger_event_type: z
        .enum([
          "request_log",
          "trace_completed",
          "customer_budget_limit_reached",
          "credit_low_balance_threshold_reached",
          "on_eval_result_ingested",
          "custom_event",
          "scheduled",
          "eval_only",
        ])
        .optional()
        .describe("Event that triggers the workflow."),
      schedule_cron: z
        .string()
        .optional()
        .describe("UTC five-field cron expression. Required for scheduled workflows; minimum interval is five minutes."),
      tasks: z
        .array(
          z.object({
            id: z.string().describe("Unique task ID (used as target for 'next' pointers and state references)."),
            type: z.enum(["condition", "sampling", "eval", "ingest", "webhook", "notification", "aggregation", "switch", "compute", "export"]).describe("Task type."),
            label: z.string().optional().describe("Human-readable task label. Required by the backend for condition tasks; recommended for every task."),
            next: z.string().optional().describe("ID of the next task. Without 'next', workflow STOPS after this task."),
            config: z.record(z.any()).describe("Task-specific configuration (see create_workflow description for details per type)."),
          }).passthrough()
        )
        .optional()
        .describe("Array of task definitions. Gates first (condition, sampling) → aggregation → actions (notification, webhook, eval, ingest, export)."),
      is_starred: z.boolean().optional().describe("Star/bookmark this workflow."),
    },
    async ({ name, description, type, trigger_event_type, schedule_cron, tasks, is_starred }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, "/api/workflows/", {
        method: "POST",
        body: {
          type,
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(trigger_event_type !== undefined ? { trigger_event_type } : {}),
          ...(schedule_cron !== undefined ? { schedule_cron } : {}),
          ...(tasks !== undefined ? { tasks } : {}),
          ...(is_starred !== undefined ? { is_starred } : {}),
        },
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "update_workflow",
    "Update a workflow's configuration, tasks, or metadata.",
    {
      workflow_id: z.string().describe("Workflow ID."),
      name: z.string().optional().describe("Updated name."),
      description: z.string().optional().describe("Updated description."),
      type: z.enum(["automations", "monitors", "exports", "evaluators"]).optional().describe("Updated type."),
      trigger_event_type: z
        .enum([
          "request_log",
          "trace_completed",
          "customer_budget_limit_reached",
          "credit_low_balance_threshold_reached",
          "on_eval_result_ingested",
          "custom_event",
          "scheduled",
          "eval_only",
        ])
        .optional()
        .describe("Updated trigger event type."),
      schedule_cron: z
        .string()
        .nullable()
        .optional()
        .describe("Updated UTC five-field cron expression. Use null when changing away from a scheduled trigger."),
      tasks: z.array(z.record(z.any())).optional().describe("Updated task definitions."),
      is_starred: z.boolean().optional().describe("Star/unstar the workflow."),
    },
    async ({ workflow_id, name, description, type, trigger_event_type, schedule_cron, tasks, is_starred }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, `/api/workflows/${workflow_id}/`, {
        method: "PATCH",
        body: {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(trigger_event_type !== undefined ? { trigger_event_type } : {}),
          ...(schedule_cron !== undefined ? { schedule_cron } : {}),
          ...(tasks !== undefined ? { tasks } : {}),
          ...(is_starred !== undefined ? { is_starred } : {}),
        },
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_workflow",
    "Delete a workflow family and every version it contains. Applies to automations, monitors, exports, and evaluator pipelines.",
    {
      workflow_id: z.string().describe("Workflow family ID."),
    },
    async ({ workflow_id }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, `/api/workflows/${workflow_id}/`, {
        method: "DELETE",
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "list_workflow_versions",
    "List all versions of a workflow.",
    {
      workflow_id: z.string().describe("Workflow ID."),
      page: z.number().optional().describe("Page number."),
      page_size: z.number().optional().describe("Results per page."),
    },
    async ({ workflow_id, page, page_size }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.listWorkflowVersions({
        Authorization: c.auth,
        workflow_id,
        ...(page ? { page } : {}),
        ...(page_size ? { page_size } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "get_workflow_version",
    "Retrieve a specific version of a workflow.",
    {
      workflow_id: z.string().describe("Workflow ID."),
      version: z.number().describe("Version number."),
    },
    async ({ workflow_id, version }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.getWorkflowVersion({
        Authorization: c.auth,
        workflow_id,
        version,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "commit_workflow",
    `Commit the current draft of a workflow/pipeline, locking it as a read-only version that can be deployed.

REQUIRED before deploy_workflow. The deploy endpoint rejects calls if no committed version exists.
Calls POST /api/workflows/{id}/commits/ (the correct platform endpoint — different from the SDK's createWorkflowVersion which doesn't actually commit).

Flow:
1. create_workflow (or create_evaluation_pipeline) — creates a draft
2. commit_workflow — locks current draft as read-only
3. deploy_workflow — makes the committed version live

Applies to automations, monitors, export workflows, and evaluator pipelines.`,
    {
      workflow_id: z.string().describe("Workflow/pipeline family workflow_id."),
      description: z.string().optional().describe("Commit message / version description."),
    },
    async ({ workflow_id, description }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, `/api/workflows/${workflow_id}/commits/`, {
        method: "POST",
        body: description ? { description } : {},
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "deploy_workflow",
    `Deploy a committed workflow/pipeline version as the active (live) version.

Calls POST /api/workflows/{id}/deployments/ (the correct platform endpoint — different from the SDK's deployWorkflow).
If version is omitted, deploys the latest committed version.

REQUIREMENT: must call commit_workflow first. If no committed version exists, deploy returns 404 "Committed version not found".`,
    {
      workflow_id: z.string().describe("Workflow/pipeline family workflow_id."),
      version: z.number().optional().describe("Specific version number to deploy. Omit for latest committed."),
    },
    async ({ workflow_id, version }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, `/api/workflows/${workflow_id}/deployments/`, {
        method: "POST",
        body: version !== undefined ? { version } : {},
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "undeploy_workflow",
    "Undeploy a workflow, stopping it from processing events.",
    {
      workflow_id: z.string().describe("Workflow ID."),
    },
    async ({ workflow_id }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.undeployWorkflow({
        Authorization: c.auth,
        workflow_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "validate_workflow",
    "Validate a workflow by running it against a sample log. Returns validation results and any errors.",
    {
      workflow_id: z.string().describe("Workflow ID."),
      log_id: z.string().optional().describe("Specific log ID to validate against. If omitted, uses the most recent log."),
    },
    async ({ workflow_id, log_id }) => {
      const c = requireClient(client);
      const data = await c.client.workflows.validateWorkflow({
        Authorization: c.auth,
        workflow_id,
        ...(log_id ? { log_id } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
