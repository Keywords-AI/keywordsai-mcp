import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient, rawFetch } from "../shared/client.js";

const EVENT_DRIVEN_TRIGGERS = [
  "request_log",
  "trace_completed",
  "customer_budget_limit_reached",
  "credit_low_balance_threshold_reached",
  "spend_cap_warning_threshold_reached",
  "limit_policy_soft_triggered",
  "limit_policy_hard_triggered",
  "on_eval_result_ingested",
  "custom_event",
] as const;

const WORKFLOW_TRIGGERS = [
  ...EVENT_DRIVEN_TRIGGERS,
  "eval_only",
  "scheduled",
] as const;

const WORKFLOW_TYPES = [
  "automations",
  "monitors",
  "evaluators",
  "reports",
  "exports",
  "ingests",
] as const;

const FILTER_OPERATORS = [
  "",
  "=",
  "==",
  "eq",
  "equals",
  "in",
  "not",
  "contains",
  "icontains",
  "startswith",
  "endswith",
  "gt",
  "gte",
  "lt",
  "lte",
  "isnull",
  "regex",
  "ilike",
  "trigram_word_similar",
  "full_text_search",
  "empty",
  "notEmpty",
  "not_empty",
] as const;

const eventDrivenTriggerSchema = z.enum(EVENT_DRIVEN_TRIGGERS);
const workflowTriggerSchema = z.enum(WORKFLOW_TRIGGERS);
const workflowTypeSchema = z.enum(WORKFLOW_TYPES);
const filterScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const filterValueSchema = z.union([filterScalarSchema, z.array(filterScalarSchema)]);

const conditionRuleSchema = z.object({
  operator: z.enum(FILTER_OPERATORS),
  connector: z.enum(["AND", "OR"]).optional(),
  value: filterValueSchema,
  operator_function: z.literal("mapContainsKey").nullable().optional(),
  operator_args: z.array(z.string()).nullable().optional(),
});

type ConditionRule = z.infer<typeof conditionRuleSchema>;
type WorkflowFilter = Record<string, ConditionRule | ConditionRule[] | FilterBundle>;
type FilterBundle = {
  connector?: "AND" | "OR";
  filter_params: WorkflowFilter;
};

const workflowFilterSchema: z.ZodType<WorkflowFilter> = z.lazy(() =>
  z.record(
    z.union([
      conditionRuleSchema,
      z.array(conditionRuleSchema),
      z.object({
        connector: z.enum(["AND", "OR"]).optional(),
        filter_params: workflowFilterSchema,
      }),
    ])
  )
);

const workflowSourceSchema = z.union([
  z.enum(["event", "input"]),
  z.string().regex(/^state\.[A-Za-z0-9_-]+$/),
]);

const ingestSourceSchema = z.union([
  z.enum(["original_event", "previous_task"]),
  z.string().regex(/^task:.+$/),
]);

const taskEnvelope = {
  id: z.string().min(1).describe("Unique task ID used by next pointers and state references."),
  label: z.string().min(1).describe("Human-readable task label."),
  next: z.string().min(1).optional().describe("Explicit next task ID. When omitted, the backend links to the following array item; omit on the last task to terminate."),
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
  output_field_name: z.string().min(1).optional(),
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
    source: workflowSourceSchema.optional().describe('"event", "input", or "state.<task_id>".'),
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
  config: z.object({
    cooldown_seconds: z.number().int().min(1).max(86400).optional().default(60),
  }),
});

const evalTaskSchema = z.object({
  ...taskEnvelope,
  type: z.literal("eval"),
  config: z.object({
    evaluator_id: z.string().min(1),
    human_config: z.object({
      instruction: z.string().optional(),
      assignee_id: z.string().optional(),
    }).optional(),
    is_auto_persist_enabled: z.boolean().optional(),
  }),
});

const ingestTaskSchema = z.object({
  ...taskEnvelope,
  type: z.literal("ingest"),
  config: z.discriminatedUnion("target_type", [
    z.object({
      target_type: z.literal("dataset"),
      target: z.object({ dataset_id: z.string().min(1) }).passthrough(),
      source: ingestSourceSchema.optional(),
    }),
    z.object({
      target_type: z.literal("experiment"),
      target: z.object({ experiment_id: z.string().min(1) }).passthrough(),
      source: ingestSourceSchema.optional(),
    }),
    z.object({
      target_type: z.literal("log"),
      target: z.record(z.any()).optional().default({}),
      source: ingestSourceSchema.optional(),
    }),
  ]),
});

const computeTaskSchema = z.object({
  ...taskEnvelope,
  type: z.literal("compute"),
  config: z.object({
    function: z.enum(["ratio", "percentage", "difference", "weighted_average"]),
    inputs: z.array(z.object({
      source: z.string().min(1),
      field: z.string().min(1).optional().default("result"),
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

type ProductTask = z.infer<typeof automationTaskSchema> | z.infer<typeof monitorTaskSchema>;
type EvaluatorRecord = {
  id: string;
  name?: string;
  type?: string;
  score_value_type?: string;
  score_config?: Record<string, unknown> | null;
  llm_config?: Record<string, unknown> | null;
  code_config?: Record<string, unknown> | null;
  configurations?: Record<string, unknown> | null;
  categorical_choices?: unknown[] | null;
};

function workflowFamilyPath(workflowId: string, suffix = ""): string {
  return `/api/workflows/${encodeURIComponent(workflowId)}/${suffix}`;
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} returned an unexpected response.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length > 0 ? record : null;
}

function legacyEvaluatorValues(configurations: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!configurations) return {};
  const specialFields = configurations.special_fields;
  if (!Array.isArray(specialFields)) return configurations;

  const values: Record<string, unknown> = {};
  for (const field of specialFields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) continue;
    const entry = field as Record<string, unknown>;
    if (typeof entry.name === "string" && entry.name) values[entry.name] = entry.value;
  }
  return values;
}

function legacyLlmConfig(configurations: Record<string, unknown>): Record<string, unknown> | null {
  const modelOptions = nonEmptyRecord(configurations.model_options) ?? {};
  const config: Record<string, unknown> = {
    ...(configurations.model || configurations.llm_engine
      ? { model: configurations.model ?? configurations.llm_engine }
      : {}),
    ...(configurations.evaluator_definition
      ? { evaluator_definition: configurations.evaluator_definition }
      : {}),
    ...(configurations.scoring_rubric
      ? { scoring_rubric: configurations.scoring_rubric }
      : {}),
  };
  for (const key of [
    "temperature",
    "max_tokens",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
  ]) {
    if (modelOptions[key] !== undefined && modelOptions[key] !== null) config[key] = modelOptions[key];
  }
  return Object.keys(config).length > 0 ? config : null;
}

function evaluatorScoreConfig(evaluator: EvaluatorRecord, legacy: Record<string, unknown>): Record<string, unknown> {
  const current = nonEmptyRecord(evaluator.score_config);
  if (current) return current;

  const scoreConfig: Record<string, unknown> = {};
  if (legacy.min_score !== undefined && legacy.min_score !== null) scoreConfig.min_score = legacy.min_score;
  if (legacy.max_score !== undefined && legacy.max_score !== null) scoreConfig.max_score = legacy.max_score;
  if (evaluator.categorical_choices?.length) scoreConfig.choices = evaluator.categorical_choices;
  return scoreConfig;
}

function validateProductTasks(tasks: ProductTask[]): void {
  for (const task of tasks) {
    if (task.type === "condition" && Object.keys(task.config.condition_policy).length === 0) {
      throw new Error(`Condition task "${task.id}" requires at least one condition_policy rule.`);
    }

    if (task.type === "switch") {
      task.config.cases.forEach((switchCase, index) => {
        if (Object.keys(switchCase.condition_policy).length === 0) {
          throw new Error(`Switch task "${task.id}" case ${index + 1} requires at least one condition_policy rule.`);
        }
      });
    }

    if (task.type === "compute") {
      const binaryFunctions = new Set(["ratio", "percentage", "difference"]);
      if (binaryFunctions.has(task.config.function) && task.config.inputs.length !== 2) {
        throw new Error(`Compute function "${task.config.function}" requires exactly two inputs.`);
      }
    }

    if (task.type === "aggregation") {
      if (
        task.config.is_comparing_to_previous === true &&
        task.config.metrics.some((metric) =>
          metric.aggregation_function === "max" || metric.aggregation_function === "min"
        )
      ) {
        throw new Error(
          `Aggregation task "${task.id}" cannot compare max/min metrics to the previous rolling window.`
        );
      }
      for (const metric of task.config.metrics) {
        if (metric.aggregation_function !== "count" && !metric.field_name?.trim()) {
          throw new Error(`Aggregation task "${task.id}" requires field_name for ${metric.aggregation_function}.`);
        }
        if (metric.aggregation_function === "count" && !metric.output_field_name?.trim()) {
          throw new Error(`Count metric in aggregation task "${task.id}" requires output_field_name.`);
        }
      }
    }

    if (task.type === "webhook") {
      const protocol = new URL(task.config.webhook_url).protocol;
      if (protocol !== "http:" && protocol !== "https:") {
        throw new Error(`Webhook task "${task.id}" requires an HTTP or HTTPS URL.`);
      }
    }
  }
}

async function hydrateAutomationEvalTasks(
  client: AuthenticatedClient,
  tasks: z.infer<typeof automationTaskSchema>[]
): Promise<Record<string, unknown>[]> {
  const evaluatorCache = new Map<string, Promise<EvaluatorRecord>>();

  const fetchEvaluator = (evaluatorId: string): Promise<EvaluatorRecord> => {
    const cached = evaluatorCache.get(evaluatorId);
    if (cached) return cached;

    const request = rawFetch(
      client,
      `/api/evaluators/${encodeURIComponent(evaluatorId)}/`,
      { method: "GET" }
    ).then((value) => {
      const evaluator = requireRecord(value, "Evaluator lookup") as EvaluatorRecord;
      if (!evaluator.id) throw new Error(`Evaluator "${evaluatorId}" did not return an id.`);
      return evaluator;
    });
    evaluatorCache.set(evaluatorId, request);
    return request;
  };

  return Promise.all(tasks.map(async (task) => {
    if (task.type !== "eval") return task;

    const evaluator = await fetchEvaluator(task.config.evaluator_id);
    const rawMethod = evaluator.type;
    const generationMethod = rawMethod === "function"
      ? "code"
      : rawMethod?.startsWith("human_")
        ? "human"
        : rawMethod;
    if (generationMethod !== "llm" && generationMethod !== "code" && generationMethod !== "human") {
      throw new Error(
        `Evaluator "${task.config.evaluator_id}" has unsupported workflow generation method "${rawMethod ?? "unknown"}".`
      );
    }

    const legacy = legacyEvaluatorValues(evaluator.configurations);
    const config: Record<string, unknown> = {
      evaluator_id: evaluator.id,
      data_source: "original_event",
      score_value_type: evaluator.score_value_type ?? "numerical",
      score_config: evaluatorScoreConfig(evaluator, legacy),
      ...(evaluator.name ? { name: evaluator.name } : {}),
      ...(task.config.is_auto_persist_enabled !== undefined
        ? { is_auto_persist_enabled: task.config.is_auto_persist_enabled }
        : {}),
    };

    if (generationMethod === "llm") {
      const llmConfig = nonEmptyRecord(evaluator.llm_config) ?? legacyLlmConfig(legacy);
      if (!llmConfig) {
        throw new Error(`LLM evaluator "${task.config.evaluator_id}" has no llm_config.`);
      }
      config.llm_config = llmConfig;
    } else if (generationMethod === "code") {
      const codeConfig = nonEmptyRecord(evaluator.code_config) ?? (
        typeof legacy.eval_code_snippet === "string" && legacy.eval_code_snippet
          ? { eval_code_snippet: legacy.eval_code_snippet }
          : null
      );
      if (!codeConfig) {
        throw new Error(`Code evaluator "${task.config.evaluator_id}" has no code_config.`);
      }
      config.code_config = codeConfig;
    } else {
      config.human_config = task.config.human_config ?? {
        instruction: "",
        assignee_id: "",
      };
    }

    return {
      ...task,
      generation_method: generationMethod,
      config,
    };
  }));
}

export function registerWorkflowTools(
  server: McpServer,
  client: AuthenticatedClient | null
) {
  server.tool(
    "list_workflows",
    "List workflow families in your organization. Each family appears once: the editable draft when present, otherwise its latest committed version.",
    {
      page: z.number().int().min(1).optional().describe("Page number (default 1)."),
      page_size: z.number().int().min(1).max(1000).optional().describe("Results per page (maximum 1000)."),
    },
    async ({ page, page_size }) => {
      const c = requireClient(client);
      const data = await rawFetch(
        c,
        withQuery("/api/workflows/", { page, page_size }),
        { method: "GET" }
      );
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
      filters: workflowFilterSchema.describe('Filter object. Example: { "type": { "value": ["monitors"], "operator": "eq" } }'),
      page: z.number().int().min(1).optional().describe("Page number."),
      page_size: z.number().int().min(1).max(1000).optional().describe("Results per page (maximum 1000)."),
      sort_by: z.string().optional().describe("Sort field. Prefix with - for descending."),
    },
    async ({ filters, page, page_size, sort_by }) => {
      const c = requireClient(client);
      const data = await rawFetch(
        c,
        withQuery("/api/workflows/list/", { page, page_size, sort_by }),
        { method: "POST", body: { filters } }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "get_workflow",
    "Retrieve a workflow family with its task definitions. Returns the editable draft when present, otherwise the latest committed version.",
    {
      workflow_id: z.string().min(1).describe("Family workflow_id (not a version-row id)."),
    },
    async ({ workflow_id }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, workflowFamilyPath(workflow_id), { method: "GET" });
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
Use condition/throttle gates, aggregation/compute/switch logic, and webhook/notification/eval/ingest actions.
For eval tasks, provide evaluator_id; the tool reads that evaluator and supplies the backend-required
generation_method and method-specific configuration automatically.`,
    {
      name: z.string().min(1).describe("Automation name."),
      description: z.string().optional().describe("Human-readable purpose."),
      trigger_event_type: eventDrivenTriggerSchema.describe("Event that starts the automation."),
      sampling_rate: z.number().min(0).max(1).optional().describe("Fraction of events allowed through; defaults to 1 (100%)."),
      tasks: z.array(automationTaskSchema).min(1).describe("Business tasks after the automatic sampling gate. The backend auto-chains array order when next is omitted; set next for explicit routing."),
      is_starred: z.boolean().optional(),
    },
    async ({ name, description, trigger_event_type, sampling_rate, tasks, is_starred }) => {
      if (tasks.some((task) => task.id === "auto-sampling")) {
        throw new Error('Do not include task ID "auto-sampling"; create_automation_workflow adds it automatically.');
      }
      validateProductTasks(tasks);
      const c = requireClient(client);
      const hydratedTasks = await hydrateAutomationEvalTasks(c, tasks);
      const workflowTasks = [
        {
          id: "auto-sampling",
          type: "sampling",
          label: "Automation sampling gate",
          next: tasks[0].id,
          config: { rate: sampling_rate ?? 1 },
        },
        ...hydratedTasks,
      ];
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
      tasks: z.array(monitorTaskSchema).min(1).describe("Monitor pipeline; must include a notification or webhook delivery task."),
      is_starred: z.boolean().optional(),
    },
    async ({ name, description, trigger_event_type, tasks, is_starred }) => {
      const hasDelivery = tasks.some((task) => task.type === "notification" || task.type === "webhook");
      if (!hasDelivery) {
        throw new Error("A monitor requires at least one notification or webhook delivery task.");
      }
      validateProductTasks(tasks);
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
      filters: workflowFilterSchema.optional().describe("Optional request-log filters. Each field may contain one rule, a list of rules, or a nested filter bundle."),
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
- "reports" and "ingests": Backend-supported advanced workflow families.

TRIGGER EVENT TYPES:
- "request_log": Fires on every logged LLM request
- "trace_completed": Fires when a trace finishes
- "customer_budget_limit_reached": Fires on budget breach
- "credit_low_balance_threshold_reached": Fires on low credit balance
- "spend_cap_warning_threshold_reached": Fires at the spend-cap warning threshold
- "limit_policy_soft_triggered" / "limit_policy_hard_triggered": Fires for limit-policy events
- "on_eval_result_ingested": Fires when eval score is recorded
- "custom_event": Fires for a custom event
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
- eval: Advanced callers must put generation_method at task root and supply evaluator_id plus the method-specific llm_config/code_config/human_config in config. Prefer create_automation_workflow for automatic evaluator hydration.
- ingest: Save to dataset. Config: { target_type: "dataset", target: { dataset_id: "<uuid>" } }
- sampling: Random filter. Config: { rate: 0.1 } (10% of events)
- compute: Arithmetic on upstream outputs. Config: { function: "ratio", inputs: [{ source: "state.<id>", field: "<field>" }] }
- export: Append scheduled request logs to the export workflow output. Config: { filters?, include_fields?, is_inline_results?: boolean, sample_percentage?: number }.
- switch: Multi-branch routing. Config: { cases: [{ condition_policy: {...}, target: "<task_id>" }], default: "<task_id>" }

TASK CHAINING: The backend auto-chains sequential tasks when next is omitted. Set next explicitly for non-linear routing or an intentional target.
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
      type: workflowTypeSchema
        .describe("Backend workflow family type."),
      trigger_event_type: workflowTriggerSchema
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
            type: z.enum(["sampling", "throttle", "webhook", "aggregation", "condition", "notification", "ingest", "switch", "compute", "transform", "eval", "workflow", "prompt", "completion", "duplicate", "wait", "for_each", "retry", "export", "get_logs", "limit_breaches", "get_pulse", "pulse_summarize"]).describe("Backend task discriminator."),
            label: z.string().optional().describe("Human-readable task label. Required for eval tasks; recommended for every task."),
            next: z.string().optional().describe("Explicit next task ID. When omitted, the backend auto-chains sequential tasks."),
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
    "create_workflow_draft",
    `Create an editable draft for a committed workflow family.

Structural update_workflow calls require a draft. This tool reads the latest committed
version (including stored webhook secrets), copies its editable fields, and POSTs that
content to /api/workflows/{workflow_id}/versions/. It refuses to create a second draft.`,
    {
      workflow_id: z.string().min(1).describe("Family workflow_id (not a version-row id)."),
    },
    async ({ workflow_id }) => {
      const c = requireClient(client);
      const current = requireRecord(
        await rawFetch(
          c,
          withQuery(workflowFamilyPath(workflow_id), { is_including_secrets: "true" }),
          { method: "GET" }
        ),
        "Workflow lookup"
      );
      if (current.is_read_only === false) {
        throw new Error(`Workflow "${workflow_id}" already has an editable draft.`);
      }

      const body: Record<string, unknown> = {};
      for (const field of [
        "name",
        "description",
        "type",
        "trigger_event_type",
        "schedule_cron",
        "tasks",
        "is_starred",
      ]) {
        if (Object.prototype.hasOwnProperty.call(current, field)) body[field] = current[field];
      }

      const data = await rawFetch(c, workflowFamilyPath(workflow_id, "versions/"), {
        method: "POST",
        body,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "update_workflow",
    "Update a workflow draft. Structural edits return 409 when the family is committed-only; call create_workflow_draft first. Metadata-only edits may update a committed family directly.",
    {
      workflow_id: z.string().min(1).describe("Family workflow_id (not a version-row id)."),
      name: z.string().optional().describe("Updated name."),
      description: z.string().optional().describe("Updated description."),
      type: workflowTypeSchema.optional().describe("Updated workflow family type."),
      trigger_event_type: workflowTriggerSchema
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
      const data = await rawFetch(c, workflowFamilyPath(workflow_id), {
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
    "Permanently delete a workflow family and every version it contains. Requires the current workflow name as confirmation.",
    {
      workflow_id: z.string().min(1).describe("Family workflow_id (not a version-row id)."),
      confirmation_name: z.string().min(1).describe("Exact current workflow name."),
    },
    async ({ workflow_id, confirmation_name }) => {
      const c = requireClient(client);
      const workflow = requireRecord(
        await rawFetch(c, workflowFamilyPath(workflow_id), { method: "GET" }),
        "Workflow lookup"
      );
      if (workflow.name !== confirmation_name) {
        throw new Error("confirmation_name does not exactly match the current workflow name; nothing was deleted.");
      }
      await rawFetch(c, workflowFamilyPath(workflow_id), {
        method: "DELETE",
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ deleted: true, workflow_id, name: confirmation_name }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "list_workflow_versions",
    "List every draft and committed version row in a workflow family.",
    {
      workflow_id: z.string().min(1).describe("Family workflow_id (not a version-row id)."),
      page: z.number().int().min(1).optional().describe("Page number."),
      page_size: z.number().int().min(1).max(1000).optional().describe("Results per page (maximum 1000)."),
    },
    async ({ workflow_id, page, page_size }) => {
      const c = requireClient(client);
      const data = await rawFetch(
        c,
        withQuery(workflowFamilyPath(workflow_id, "versions/"), { page, page_size }),
        { method: "GET" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "get_workflow_version",
    "Retrieve a specific version of a workflow.",
    {
      workflow_id: z.string().min(1).describe("Family workflow_id (not a version-row id)."),
      version: z.number().int().min(1).describe("Version number."),
    },
    async ({ workflow_id, version }) => {
      const c = requireClient(client);
      const data = await rawFetch(
        c,
        workflowFamilyPath(workflow_id, `versions/${version}/`),
        { method: "GET" }
      );
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
      workflow_id: z.string().min(1).describe("Family workflow_id (not a version-row id)."),
      description: z.string().max(1000).optional().describe("Commit message / version description."),
    },
    async ({ workflow_id, description }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, workflowFamilyPath(workflow_id, "commits/"), {
        method: "POST",
        body: description !== undefined ? { description } : {},
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
      workflow_id: z.string().min(1).describe("Family workflow_id (not a version-row id)."),
      version: z.number().int().min(1).optional().describe("Specific version number to deploy. Omit for latest committed."),
    },
    async ({ workflow_id, version }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, workflowFamilyPath(workflow_id, "deployments/"), {
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
      workflow_id: z.string().min(1).describe("Family workflow_id (not a version-row id)."),
    },
    async ({ workflow_id }) => {
      const c = requireClient(client);
      await rawFetch(c, workflowFamilyPath(workflow_id, "deployments/"), {
        method: "DELETE",
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ undeployed: true, workflow_id }, null, 2) }],
      };
    }
  );

  server.tool(
    "validate_workflow",
    `Validate the latest editable draft's structure and task configuration.

WARNING: this sends real preview notifications and webhooks for delivery tasks. It does not
fetch or run against request logs, and it cannot validate a committed-only family; call
create_workflow_draft first when needed.`,
    {
      workflow_id: z.string().min(1).describe("Family workflow_id (not a version-row id)."),
      confirm_preview_deliveries: z.literal(true).describe("Must be true to acknowledge that validation sends real preview notifications and webhooks."),
    },
    async ({ workflow_id }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, workflowFamilyPath(workflow_id, "validations/"), {
        method: "POST",
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
