import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient, rawFetch } from "../shared/client.js";
import { clampPagination, paginationShape } from "../shared/pagination.js";

/**
 * Typed-noun tools over the shared /api/workflows/ resource.
 *
 * Every workflow row carries a `type` discriminator (monitors, automations,
 * reports, evaluators). It is NOT exposed as a parameter anywhere in this file:
 * a model asked to "create a monitor" reliably picks the noun tool but does not
 * reliably guess the discriminator, so each tool pins its own value. That is the
 * whole reason the generic workflow tools were retired. Do not add a generic
 * fallback and do not let a caller supply `type`.
 */

type WorkflowOp =
  | "list"
  | "get"
  | "create"
  | "update"
  | "version_list"
  | "commit"
  | "deploy"
  | "undeploy"
  | "validate";

interface NounSpec {
  /** Tool-name prefix and id-parameter prefix, e.g. "monitor" -> monitor_get, monitor_id. */
  noun: string;
  /** Pinned `type` discriminator. Never reaches the exposed parameter schema. */
  type: string;
  /** Singular human label used in adapted descriptions. */
  label: string;
  ops: WorkflowOp[];
}

const FULL_OPS: WorkflowOp[] = [
  "list",
  "get",
  "create",
  "update",
  "version_list",
  "commit",
  "deploy",
  "undeploy",
  "validate",
];

const NOUNS: NounSpec[] = [
  { noun: "monitor", type: "monitors", label: "monitor", ops: FULL_OPS },
  { noun: "automation", type: "automations", label: "automation", ops: FULL_OPS },
  { noun: "report", type: "reports", label: "report", ops: FULL_OPS },
  // evaluator_create / _list / _get / _update are registered by
  // lib/evaluate/pipelines.ts. The SDK overwrites a same-named tool without
  // erroring, so emitting them here would silently replace those.
  {
    noun: "evaluator",
    type: "evaluators",
    label: "evaluator",
    ops: ["version_list", "commit", "deploy", "undeploy", "validate"],
  },
];

/**
 * Descriptions copied verbatim from lib/generated/manifest.json, which mirrors
 * the backend's own tool text. Ops with no manifest entry fall back to
 * ADAPTED_DESCRIPTIONS below.
 */
const DESCRIPTIONS: Record<string, string> = {
  monitor_list:
    "A monitor watches incoming telemetry and alerts when a condition trips. This is the data on the Monitors page. Lists ONLY monitors — the type is fixed by this tool and cannot be widened or omitted. RETURNS per entry: id (version PK), monitor_id (family ID — pass it as monitor_id), version, name, description, type (automations/monitors/evaluators/reports/exports/ingests), version_description, trigger_event_type, schedule_cron, is_enabled, is_starred, is_read_only, is_public, deployed_version, tags, editor, has_async_steps, created_at, updated_at. NOTE: Each row is a monitor VERSION. 'monitor_id' groups versions of the same logical monitor.",
  monitor_get:
    "A monitor watches incoming telemetry and alerts when a condition trips. This is the data on the Monitors page. Get full monitor details including task definitions. A family monitor_id (from monitor_list) returns the latest draft (editable) version, else the latest committed one. A version PK (id from monitor_list) or 'family_id:version' (e.g. 'abc123:2') returns THAT exact version — use this to read a deployed version's tasks instead of the draft's. RETURNS: id, workflow_id, version, name, description, tasks (array of {id, type, label, config}), trigger_event_type, is_enabled, is_read_only, has_async_steps, has_write_access. The tasks array contains the full monitor definition — each task's type and config show exactly what the monitor does.",
  monitor_create:
    "A monitor watches incoming telemetry and alerts when a condition trips. This is the data on the Monitors page. RETURNS: id (version PK), workflow_id (family ID — pass it as monitor_id to monitor_get / monitor_update), version, name, tasks. Task types: condition (filter/gate), sampling (random %), eval (run a grader), ingest (save to dataset), webhook (HTTP callback), notification (email/Slack/PagerDuty), aggregation (time-window metrics), switch (multi-branch routing), compute (arithmetic on upstream outputs). Task ordering: gates first (condition, sampling) then aggregation then actions (notification, webhook, eval, ingest). TRIGGER MAPPING: 'spans'/'logs'/'requests' to request_log; 'completed traces'/'traces' to trace_completed. Monitors alert; they do not grade. To attach a grader, build an automation instead (automation_create).",
  monitor_update:
    "A monitor watches incoming telemetry and alerts when a condition trips. This is the data on the Monitors page. Update a monitor's latest draft version. Only non-read-only versions can be edited. RETURNS: updated monitor details (same fields as monitor_get). When updating tasks, the entire task list is REPLACED — provide the full task list, not just the changed tasks. Omitted fields stay unchanged.",
  monitor_version_list:
    "A monitor watches incoming telemetry and alerts when a condition trips. This is the data on the Monitors page. List all versions for a monitor family. Returns versions ordered by version number (descending). RETURNS per entry: id, monitor_id, version (int), name, description, is_read_only, is_enabled, created_at. The latest non-read-only version is the editable draft (returned by monitor_get).",
  monitor_commit:
    "A monitor watches incoming telemetry and alerts when a condition trips. This is the data on the Monitors page. Commit a monitor family's current draft version. Flips the draft's is_read_only to True IN PLACE (same version number — unlike prompt_commit there is no auto-bump). Takes the FAMILY monitor_id (the monitor_id field from monitor_list/monitor_get), NOT a version PK (id). Committing does NOT make the version live — call monitor_deploy next. Errors with 409 when the family has no draft to commit. RETURNS: the committed version's full details (same fields as monitor_get).",
  monitor_deploy:
    "A monitor watches incoming telemetry and alerts when a condition trips. This is the data on the Monitors page. Deploy a committed monitor version as the live version: sets is_enabled=True on exactly one committed (is_read_only=True) version and False on every other version in the family. This per-version is_enabled is the ONLY deployment truth — the is_enabled flag on monitor_list/monitor_get rows is a family-level serializer artifact; trust deployed_version instead. Takes the FAMILY monitor_id (from monitor_list/monitor_get), NOT a version PK. 'version' is the integer version NUMBER (from monitor_version_list), NOT a PK; omit it to deploy the latest committed version. Drafts are NOT auto-committed (unlike prompt_deploy) — call monitor_commit first, and 404 means no committed version exists yet. Scheduled monitors (reports) only start firing once deployed. RETURNS: id (version PK), workflow_id, version, is_enabled, is_read_only.",
  monitor_undeploy:
    "A monitor watches incoming telemetry and alerts when a condition trips. This is the data on the Monitors page. Undeploy a monitor: sets is_enabled=False on EVERY version in the family, so the monitor stops firing. Exact inverse of monitor_deploy — re-enable by calling monitor_deploy again. This is the ONLY way to disable a monitor short of deleting it. Per-version is_enabled is the ONLY deployment truth, and the is_enabled field on monitor_update is IGNORED by the server (read-only there), so no update call can stop a firing monitor. The is_enabled on monitor_list/monitor_get rows is a family-level serializer artifact; confirm the result with deployed_version instead. Takes the FAMILY monitor_id (from monitor_list/monitor_get), NOT a version PK. There is no version argument — undeploy is family-wide by definition. Already-undeployed families succeed unchanged; 404 means no such family. Nothing is deleted: versions, tasks and run history all survive. RETURNS: workflow_id and is_enabled=false (the endpoint itself replies 204 No Content).",

  automation_list:
    "An automation runs a task sequence against incoming telemetry — this is the online-eval surface. This is the data on the Automations page. Lists ONLY automations — the type is fixed by this tool and cannot be widened or omitted. RETURNS per entry: id (version PK), automation_id (family ID — pass it as automation_id), version, name, description, type (automations/monitors/evaluators/reports/exports/ingests), version_description, trigger_event_type, schedule_cron, is_enabled, is_starred, is_read_only, is_public, deployed_version, tags, editor, has_async_steps, created_at, updated_at. NOTE: Each row is an automation VERSION. 'automation_id' groups versions of the same logical automation.",
  automation_get:
    "An automation runs a task sequence against incoming telemetry — this is the online-eval surface. This is the data on the Automations page. Get full automation details including task definitions. A family automation_id (from automation_list) returns the latest draft (editable) version, else the latest committed one. A version PK (id from automation_list) or 'family_id:version' (e.g. 'abc123:2') returns THAT exact version — use this to read a deployed version's tasks instead of the draft's. RETURNS: id, workflow_id, version, name, description, tasks (array of {id, type, label, config}), trigger_event_type, is_enabled, is_read_only, has_async_steps, has_write_access. The tasks array contains the full automation definition — each task's type and config show exactly what the automation does.",
  automation_create:
    "An automation runs a task sequence against incoming telemetry — this is the online-eval surface. This is the data on the Automations page. RETURNS: id (version PK), workflow_id (family ID — pass it as automation_id to automation_get / automation_update), version, name, tasks. Task types: condition (filter/gate), sampling (random %), eval (run a grader), ingest (save to dataset), webhook (HTTP callback), notification (email/Slack/PagerDuty), aggregation (time-window metrics), switch (multi-branch routing), compute (arithmetic on upstream outputs). Task ordering: gates first (condition, sampling) then aggregation then actions (notification, webhook, eval, ingest). TRIGGER MAPPING: 'spans'/'logs'/'requests' to request_log; 'completed traces'/'traces' to trace_completed. UI CONVENTION: tasks MUST start with a sampling task whose id is LITERALLY 'auto-sampling' (type='sampling', config.rate 0.0-1.0, default 1). The top-level 'Run workflow on X% of incoming' control is backed by that exact task id. '+ Add task' palette (what the user sees): condition (Filtering), aggregation, compute (Computation), switch, webhook, ingest (Dataset), eval (Evaluator). HIDDEN from that menu but still valid and executable: notification, prompt, completion, throttle. If you include a hidden-type task, your final message MUST state which inlined tasks are not in the '+ Add task' menu.",
  automation_update:
    "An automation runs a task sequence against incoming telemetry — this is the online-eval surface. This is the data on the Automations page. Update a automation's latest draft version. Only non-read-only versions can be edited. RETURNS: updated automation details (same fields as automation_get). When updating tasks, the entire task list is REPLACED — provide the full task list, not just the changed tasks. Omitted fields stay unchanged.",
  automation_version_list:
    "An automation runs a task sequence against incoming telemetry — this is the online-eval surface. This is the data on the Automations page. List all versions for a automation family. Returns versions ordered by version number (descending). RETURNS per entry: id, automation_id, version (int), name, description, is_read_only, is_enabled, created_at. The latest non-read-only version is the editable draft (returned by automation_get).",
  automation_commit:
    "An automation runs a task sequence against incoming telemetry — this is the online-eval surface. This is the data on the Automations page. Commit a automation family's current draft version. Flips the draft's is_read_only to True IN PLACE (same version number — unlike prompt_commit there is no auto-bump). Takes the FAMILY automation_id (the automation_id field from automation_list/automation_get), NOT a version PK (id). Committing does NOT make the version live — call automation_deploy next. Errors with 409 when the family has no draft to commit. RETURNS: the committed version's full details (same fields as automation_get).",
  automation_deploy:
    "An automation runs a task sequence against incoming telemetry — this is the online-eval surface. This is the data on the Automations page. Deploy a committed automation version as the live version: sets is_enabled=True on exactly one committed (is_read_only=True) version and False on every other version in the family. This per-version is_enabled is the ONLY deployment truth — the is_enabled flag on automation_list/automation_get rows is a family-level serializer artifact; trust deployed_version instead. Takes the FAMILY automation_id (from automation_list/automation_get), NOT a version PK. 'version' is the integer version NUMBER (from automation_version_list), NOT a PK; omit it to deploy the latest committed version. Drafts are NOT auto-committed (unlike prompt_deploy) — call automation_commit first, and 404 means no committed version exists yet. Scheduled automations (reports) only start firing once deployed. RETURNS: id (version PK), workflow_id, version, is_enabled, is_read_only.",
  automation_undeploy:
    "An automation runs a task sequence against incoming telemetry — this is the online-eval surface. This is the data on the Automations page. Undeploy a automation: sets is_enabled=False on EVERY version in the family, so the automation stops firing. Exact inverse of automation_deploy — re-enable by calling automation_deploy again. This is the ONLY way to disable a automation short of deleting it. Per-version is_enabled is the ONLY deployment truth, and the is_enabled field on automation_update is IGNORED by the server (read-only there), so no update call can stop a firing automation. The is_enabled on automation_list/automation_get rows is a family-level serializer artifact; confirm the result with deployed_version instead. Takes the FAMILY automation_id (from automation_list/automation_get), NOT a version PK. There is no version argument — undeploy is family-wide by definition. Already-undeployed families succeed unchanged; 404 means no such family. Nothing is deleted: versions, tasks and run history all survive. RETURNS: workflow_id and is_enabled=false (the endpoint itself replies 204 No Content).",

  report_list:
    "A report is a scheduled digest assembled from logs, traces, limit breaches and pulses. This is the data on the Reports page. Lists ONLY reports — the type is fixed by this tool and cannot be widened or omitted. RETURNS per entry: id (version PK), report_id (family ID — pass it as report_id), version, name, description, type (automations/monitors/evaluators/reports/exports/ingests), version_description, trigger_event_type, schedule_cron, is_enabled, is_starred, is_read_only, is_public, deployed_version, tags, editor, has_async_steps, created_at, updated_at. NOTE: Each row is a report VERSION. 'report_id' groups versions of the same logical report.",
  report_get:
    "A report is a scheduled digest assembled from logs, traces, limit breaches and pulses. This is the data on the Reports page. Get full report details including task definitions. A family report_id (from report_list) returns the latest draft (editable) version, else the latest committed one. A version PK (id from report_list) or 'family_id:version' (e.g. 'abc123:2') returns THAT exact version — use this to read a deployed version's tasks instead of the draft's. RETURNS: id, workflow_id, version, name, description, tasks (array of {id, type, label, config}), trigger_event_type, is_enabled, is_read_only, has_async_steps, has_write_access. The tasks array contains the full report definition — each task's type and config show exactly what the report does.",
  report_create:
    "A report is a scheduled digest assembled from logs, traces, limit breaches and pulses. This is the data on the Reports page. RETURNS: id (version PK), workflow_id (family ID — pass it as report_id to report_get / report_update), version, name, tasks. Task types: condition (filter/gate), sampling (random %), eval (run a grader), ingest (save to dataset), webhook (HTTP callback), notification (email/Slack/PagerDuty), aggregation (time-window metrics), switch (multi-branch routing), compute (arithmetic on upstream outputs). Task ordering: gates first (condition, sampling) then aggregation then actions (notification, webhook, eval, ingest). TRIGGER MAPPING: 'spans'/'logs'/'requests' to request_log; 'completed traces'/'traces' to trace_completed. Report-only task types: get_logs, get_traces, limit_breaches, get_pulse, pulse_summarize.",
  report_update:
    "A report is a scheduled digest assembled from logs, traces, limit breaches and pulses. This is the data on the Reports page. Update a report's latest draft version. Only non-read-only versions can be edited. RETURNS: updated report details (same fields as report_get). When updating tasks, the entire task list is REPLACED — provide the full task list, not just the changed tasks. Omitted fields stay unchanged.",
  report_version_list:
    "A report is a scheduled digest assembled from logs, traces, limit breaches and pulses. This is the data on the Reports page. List all versions for a report family. Returns versions ordered by version number (descending). RETURNS per entry: id, report_id, version (int), name, description, is_read_only, is_enabled, created_at. The latest non-read-only version is the editable draft (returned by report_get).",
  report_commit:
    "A report is a scheduled digest assembled from logs, traces, limit breaches and pulses. This is the data on the Reports page. Commit a report family's current draft version. Flips the draft's is_read_only to True IN PLACE (same version number — unlike prompt_commit there is no auto-bump). Takes the FAMILY report_id (the report_id field from report_list/report_get), NOT a version PK (id). Committing does NOT make the version live — call report_deploy next. Errors with 409 when the family has no draft to commit. RETURNS: the committed version's full details (same fields as report_get).",
  report_deploy:
    "A report is a scheduled digest assembled from logs, traces, limit breaches and pulses. This is the data on the Reports page. Deploy a committed report version as the live version: sets is_enabled=True on exactly one committed (is_read_only=True) version and False on every other version in the family. This per-version is_enabled is the ONLY deployment truth — the is_enabled flag on report_list/report_get rows is a family-level serializer artifact; trust deployed_version instead. Takes the FAMILY report_id (from report_list/report_get), NOT a version PK. 'version' is the integer version NUMBER (from report_version_list), NOT a PK; omit it to deploy the latest committed version. Drafts are NOT auto-committed (unlike prompt_deploy) — call report_commit first, and 404 means no committed version exists yet. Scheduled reports (reports) only start firing once deployed. RETURNS: id (version PK), workflow_id, version, is_enabled, is_read_only.",
  report_undeploy:
    "A report is a scheduled digest assembled from logs, traces, limit breaches and pulses. This is the data on the Reports page. Undeploy a report: sets is_enabled=False on EVERY version in the family, so the report stops firing. Exact inverse of report_deploy — re-enable by calling report_deploy again. This is the ONLY way to disable a report short of deleting it. Per-version is_enabled is the ONLY deployment truth, and the is_enabled field on report_update is IGNORED by the server (read-only there), so no update call can stop a firing report. The is_enabled on report_list/report_get rows is a family-level serializer artifact; confirm the result with deployed_version instead. Takes the FAMILY report_id (from report_list/report_get), NOT a version PK. There is no version argument — undeploy is family-wide by definition. Already-undeployed families succeed unchanged; 404 means no such family. Nothing is deleted: versions, tasks and run history all survive. RETURNS: workflow_id and is_enabled=false (the endpoint itself replies 204 No Content).",

  evaluator_version_list:
    "An evaluator is the user-visible grading resource, composed of one or more graders (see the grader_* tools for the building blocks). This is the data on the Evaluators page. List all versions for a evaluator family. Returns versions ordered by version number (descending). RETURNS per entry: id, evaluator_id, version (int), name, description, is_read_only, is_enabled, created_at. The latest non-read-only version is the editable draft (returned by evaluator_get).",
  evaluator_commit:
    "An evaluator is the user-visible grading resource, composed of one or more graders (see the grader_* tools for the building blocks). This is the data on the Evaluators page. Commit a evaluator family's current draft version. Flips the draft's is_read_only to True IN PLACE (same version number — unlike prompt_commit there is no auto-bump). Takes the FAMILY evaluator_id (the evaluator_id field from evaluator_list/evaluator_get), NOT a version PK (id). Committing does NOT make the version live — call evaluator_deploy next. Errors with 409 when the family has no draft to commit. RETURNS: the committed version's full details (same fields as evaluator_get).",
  evaluator_deploy:
    "An evaluator is the user-visible grading resource, composed of one or more graders (see the grader_* tools for the building blocks). This is the data on the Evaluators page. Deploy a committed evaluator version as the live version: sets is_enabled=True on exactly one committed (is_read_only=True) version and False on every other version in the family. This per-version is_enabled is the ONLY deployment truth — the is_enabled flag on evaluator_list/evaluator_get rows is a family-level serializer artifact; trust deployed_version instead. Takes the FAMILY evaluator_id (from evaluator_list/evaluator_get), NOT a version PK. 'version' is the integer version NUMBER (from evaluator_version_list), NOT a PK; omit it to deploy the latest committed version. Drafts are NOT auto-committed (unlike prompt_deploy) — call evaluator_commit first, and 404 means no committed version exists yet. Scheduled evaluators (reports) only start firing once deployed. RETURNS: id (version PK), workflow_id, version, is_enabled, is_read_only.",
  evaluator_undeploy:
    "An evaluator is the user-visible grading resource, composed of one or more graders (see the grader_* tools for the building blocks). This is the data on the Evaluators page. Undeploy a evaluator: sets is_enabled=False on EVERY version in the family, so the evaluator stops firing. Exact inverse of evaluator_deploy — re-enable by calling evaluator_deploy again. This is the ONLY way to disable a evaluator short of deleting it. Per-version is_enabled is the ONLY deployment truth, and the is_enabled field on evaluator_update is IGNORED by the server (read-only there), so no update call can stop a firing evaluator. The is_enabled on evaluator_list/evaluator_get rows is a family-level serializer artifact; confirm the result with deployed_version instead. Takes the FAMILY evaluator_id (from evaluator_list/evaluator_get), NOT a version PK. There is no version argument — undeploy is family-wide by definition. Already-undeployed families succeed unchanged; 404 means no such family. Nothing is deleted: versions, tasks and run history all survive. RETURNS: workflow_id and is_enabled=false (the endpoint itself replies 204 No Content).",
};

/** Ops with no backend twin: the generic description with the noun substituted. */
const ADAPTED_DESCRIPTIONS: Partial<Record<WorkflowOp, (spec: NounSpec) => string>> = {
  validate: (spec) =>
    `Validate a ${spec.label} by running it against a sample log without deploying it. Returns the per-task results and any errors, so this is the safe preview path: run it before ${spec.noun}_commit and ${spec.noun}_deploy. Takes the FAMILY ${spec.noun}_id and validates that family's latest version.`,
};

function descriptionFor(name: string, spec: NounSpec, op: WorkflowOp): string {
  const adapt = ADAPTED_DESCRIPTIONS[op];
  return DESCRIPTIONS[name] ?? (adapt ? adapt(spec) : "");
}

const TRIGGER_EVENT_TYPES = [
  "request_log",
  "trace_completed",
  "customer_budget_limit_reached",
  "credit_low_balance_threshold_reached",
  "spend_cap_warning_threshold_reached",
  "limit_policy_soft_triggered",
  "limit_policy_hard_triggered",
  "on_eval_result_ingested",
  "custom_event",
  "eval_only",
  "scheduled",
] as const;

const TASK_TYPES = [
  "condition",
  "sampling",
  "eval",
  "ingest",
  "webhook",
  "notification",
  "aggregation",
  "switch",
  "compute",
  "prompt",
  "completion",
  "throttle",
  "get_logs",
  "get_traces",
  "limit_breaches",
  "get_pulse",
  "pulse_summarize",
] as const;

const TASK_CONFIG_HELP = `Task-specific configuration.
- condition: { condition_policy: { "event.<field>": { operator, value } }, on_true: "continue", on_false: "stop" }
  Field paths use a namespace: event.cost, event.model, event.status, state.<task_id>.<field>
  Operators: "in" (categorical), "gte"/"lte"/"gt"/"lt" (numeric), "icontains"/"startswith" (text)
- aggregation: { time_step_minutes: 5, metrics: [{ field_name: "event.cost", aggregation_function: "sum", output_field_name: "cost_sum" }] }
- notification: { severity: "high", message_template: "Cost: {{state.agg.cost_sum}}" } ({{variable}} interpolates)
- webhook: { webhook_url: "https://...", source: "event" }
- eval: { evaluator_id: "<uuid>" }
- ingest: { target_type: "dataset", target: { dataset_id: "<uuid>" } }
- sampling: { rate: 0.1 } (10% of events)
- compute: { function: "ratio", inputs: [{ source: "state.<id>", field: "<field>" }] }
- switch: { cases: [{ condition_policy: {...}, target: "<task_id>" }], default: "<task_id>" }`;

const TASK_SCHEMA = z
  .object({
    id: z
      .string()
      .describe("Unique task id, a short slug like 'agg' or 'notify'. Used by 'next' pointers, switch targets and state.<task_id>.* dotpaths."),
    type: z.enum(TASK_TYPES).describe("Task type. get_logs, get_traces, limit_breaches, get_pulse and pulse_summarize are report building blocks."),
    label: z.string().optional().describe("Human-readable task label."),
    next: z.string().optional().describe("Id of the next task. Without 'next' the run STOPS after this task."),
    config: z.record(z.any()).describe(TASK_CONFIG_HELP),
  })
  .passthrough();

/**
 * The id parameter is named per noun (monitor_id, report_id, ...), so its key is
 * not statically known. `readIdArg` reads it back inside the handler.
 */
function idField(spec: NounSpec): { [key: string]: z.ZodString } {
  return {
    [`${spec.noun}_id`]: z
      .string()
      .describe(`Family ${spec.noun}_id (UUID) from ${spec.noun}_list or ${spec.noun}_get. NOT a version PK.`),
  };
}

function readIdArg(args: Record<string, unknown>, spec: NounSpec): string {
  const value = args[`${spec.noun}_id`];
  return typeof value === "string" ? value : String(value);
}

type Registrar = (
  server: McpServer,
  client: AuthenticatedClient | null,
  spec: NounSpec,
  name: string,
  description: string
) => void;

const REGISTRARS: Record<WorkflowOp, Registrar> = {
  list: (server, client, spec, name, description) => {
    server.tool(
      name,
      description,
      {
        filters: z
          .record(z.any())
          .optional()
          .describe(
            `Additional filters keyed by field name, e.g. { "name": { "value": ["cost"], "operator": "icontains" } }. The type filter is pinned to ${spec.type} and cannot be overridden or widened.`
          ),
        ...paginationShape(`${spec.noun}_list`),
        sort_by: z.string().optional().describe("Sort field. Prefix with - for descending (default -created_at)."),
      },
      async (args) => {
        const c = requireClient(client);
        const data = await c.client.workflows.filterWorkflows({
          Authorization: c.auth,
          // Pinned last so a caller-supplied type filter cannot widen the scope.
          filters: { ...(args.filters ?? {}), type: { value: [spec.type], operator: "eq" } },
          ...clampPagination(`${spec.noun}_list`, { page: args.page, page_size: args.page_size }),
          ...(args.sort_by ? { sort_by: args.sort_by } : {}),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },

  get: (server, client, spec, name, description) => {
    server.tool(
      name,
      description,
      {
        ...idField(spec),
      },
      async (args) => {
        const c = requireClient(client);
        const data = await c.client.workflows.getWorkflow({
          Authorization: c.auth,
          workflow_id: readIdArg(args, spec),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },

  create: (server, client, spec, name, description) => {
    server.tool(
      name,
      description,
      {
        name: z.string().optional().describe(`${spec.label} name, a clean descriptive title, never the user's raw request sentence.`),
        description: z.string().optional().describe(`What this ${spec.label} does.`),
        trigger_event_type: z
          .enum(TRIGGER_EVENT_TYPES)
          .optional()
          .describe(
            "Event that triggers a run. 'spans'/'logs'/'requests' map to request_log, 'traces' to trace_completed, 'eval result' to on_eval_result_ingested. 'scheduled' fires on schedule_cron instead of an event and REQUIRES schedule_cron."
          ),
        schedule_cron: z
          .string()
          .optional()
          .describe(
            "UTC cron schedule, standard 5-field syntax (e.g. '0 9 * * 1' = Mondays 09:00 UTC). Required with trigger_event_type='scheduled', rejected otherwise. No seconds field, no TZ= prefix, minimum 5 minutes between fires."
          ),
        tasks: z
          .array(TASK_SCHEMA)
          .optional()
          .describe("Ordered task definitions chained by 'next'. Gates first (condition, sampling), then aggregation/compute, then actions (notification, webhook, eval, ingest)."),
        is_starred: z.boolean().optional().describe(`Star this ${spec.label}.`),
      },
      async (args) => {
        const c = requireClient(client);
        // rawFetch, not the SDK: the SDK's create request type pins `type` to a
        // three-value enum that predates `reports`. Same URL, method and body.
        const data = await rawFetch(c, "/api/workflows/", {
          method: "POST",
          body: {
            type: spec.type,
            ...(args.name ? { name: args.name } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.trigger_event_type ? { trigger_event_type: args.trigger_event_type } : {}),
            ...(args.schedule_cron ? { schedule_cron: args.schedule_cron } : {}),
            ...(args.tasks ? { tasks: args.tasks } : {}),
            ...(args.is_starred !== undefined ? { is_starred: args.is_starred } : {}),
          },
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },

  update: (server, client, spec, name, description) => {
    server.tool(
      name,
      description,
      {
        ...idField(spec),
        name: z.string().optional().describe("Updated name."),
        description: z.string().optional().describe("Updated description."),
        trigger_event_type: z
          .enum(TRIGGER_EVENT_TYPES)
          .optional()
          .describe("Updated trigger event type. 'scheduled' requires schedule_cron; switching away from it requires clearing schedule_cron."),
        schedule_cron: z.string().optional().describe("Updated UTC cron schedule, standard 5-field syntax."),
        tasks: z.array(TASK_SCHEMA).optional().describe("Replacement task list. The whole list is REPLACED, so send every task, not just the changed one."),
        is_starred: z.boolean().optional().describe(`Star or unstar the ${spec.label}.`),
      },
      async (args) => {
        const c = requireClient(client);
        // `type` is deliberately not sent: the row already has it, and writing it
        // here would let a wrong-noun call convert the resource into another kind.
        const data = await rawFetch(c, `/api/workflows/${readIdArg(args, spec)}/`, {
          method: "PATCH",
          body: {
            ...(args.name ? { name: args.name } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.trigger_event_type ? { trigger_event_type: args.trigger_event_type } : {}),
            ...(args.schedule_cron ? { schedule_cron: args.schedule_cron } : {}),
            ...(args.tasks ? { tasks: args.tasks } : {}),
            ...(args.is_starred !== undefined ? { is_starred: args.is_starred } : {}),
          },
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },

  version_list: (server, client, spec, name, description) => {
    server.tool(
      name,
      description,
      {
        ...idField(spec),
        ...paginationShape(`${spec.noun}_version_list`),
      },
      async (args) => {
        const c = requireClient(client);
        const data = await c.client.workflows.listWorkflowVersions({
          Authorization: c.auth,
          workflow_id: readIdArg(args, spec),
          ...clampPagination(`${spec.noun}_version_list`, { page: args.page, page_size: args.page_size }),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },

  commit: (server, client, spec, name, description) => {
    server.tool(
      name,
      description,
      {
        ...idField(spec),
        description: z.string().optional().describe("Commit message stamped on the committed version."),
      },
      async (args) => {
        const c = requireClient(client);
        // POST /commits/ is the platform endpoint. The SDK's createWorkflowVersion
        // does not actually commit.
        const data = await rawFetch(c, `/api/workflows/${readIdArg(args, spec)}/commits/`, {
          method: "POST",
          body: args.description ? { description: args.description } : {},
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },

  deploy: (server, client, spec, name, description) => {
    server.tool(
      name,
      description,
      {
        ...idField(spec),
        version: z
          .number()
          .optional()
          .describe(`Integer version NUMBER to deploy (from ${spec.noun}_version_list), not a version PK. Omit for the latest committed version.`),
      },
      async (args) => {
        const c = requireClient(client);
        // POST /deployments/ is the platform endpoint, not the SDK's deployWorkflow.
        const data = await rawFetch(c, `/api/workflows/${readIdArg(args, spec)}/deployments/`, {
          method: "POST",
          body: args.version !== undefined ? { version: args.version } : {},
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },

  undeploy: (server, client, spec, name, description) => {
    server.tool(
      name,
      description,
      {
        ...idField(spec),
      },
      async (args) => {
        const c = requireClient(client);
        const data = await c.client.workflows.undeployWorkflow({
          Authorization: c.auth,
          workflow_id: readIdArg(args, spec),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },

  validate: (server, client, spec, name, description) => {
    server.tool(
      name,
      description,
      {
        ...idField(spec),
        log_id: z.string().optional().describe("Log id to validate against. If omitted, the backend uses the most recent log."),
      },
      async (args) => {
        const c = requireClient(client);
        const data = await c.client.workflows.validateWorkflow({
          Authorization: c.auth,
          workflow_id: readIdArg(args, spec),
          ...(args.log_id ? { log_id: args.log_id } : {}),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }
    );
  },
};

export function registerWorkflowTools(
  server: McpServer,
  client: AuthenticatedClient | null
) {
  for (const spec of NOUNS) {
    for (const op of spec.ops) {
      const name = `${spec.noun}_${op}`;
      REGISTRARS[op](server, client, spec, name, descriptionFor(name, spec, op));
    }
  }
}
