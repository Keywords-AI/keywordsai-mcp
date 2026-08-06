/**
 * Evaluator tools (V2 — Blockly visual editor compatible).
 *
 * An evaluator wraps one or more graders (the single-step building blocks) in a
 * workflow of type "evaluators". This is what renders on the Evaluators page.
 *
 * High-level shapes supported:
 *   - Single grader:        steps=[{grader_id}]
 *   - Average:              steps=[{grader_id}, {grader_id}], combine="average"
 *   - Weighted average:     steps=[...], combine="weighted_average", weights=[0.6, 0.4]
 *   - Condition gate:       steps=[...], condition={check_grader_id, operator, value, [else_value]}
 *
 * The Blockly task graph is built automatically.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthenticatedClient } from '../shared/client.js';
import { requireClient, rawFetch } from '../shared/client.js';
import { clampPagination, paginationShape } from '../shared/pagination.js';

const BLOCKLY_EVAL_TASK_ID_PREFIX = 'blockly_hidden_eval_';
const BLOCKLY_EVAL_LABEL_PREFIX = 'blockly_hidden_eval_';
const BLOCKLY_COMPUTE_TASK_ID_PREFIX = 'blockly_compute_';
const BLOCKLY_COMPUTE_LABEL_PREFIX = 'blockly_compute_';

type Grader = {
  id: string;
  type?: string;
  score_value_type?: string;
  score_config?: Record<string, unknown>;
  llm_config?: Record<string, unknown>;
  code_config?: Record<string, unknown>;
  evaluator_slug?: string;
};

function safeNodeId(raw: string): string {
  const sanitized = raw.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 30);
  return sanitized || 'node';
}

async function fetchGrader(c: AuthenticatedClient, graderId: string): Promise<Grader | null> {
  try {
    const result = await rawFetch(c, `/api/evaluators/${graderId}/`, { method: 'GET' });
    if (result && typeof result === 'object' && (result as Grader).id) {
      return result as Grader;
    }
    return null;
  } catch {
    return null;
  }
}

function buildEvalTask(opts: {
  nodeId: string;
  grader: Grader;
  isResult?: boolean;
  enclosingConditionIds?: string[];
  nextTaskId?: string;
}): Record<string, unknown> {
  const { nodeId, grader, isResult, enclosingConditionIds, nextTaskId } = opts;
  const kind = grader.type || 'llm';
  const scoreValueType = grader.score_value_type || 'numerical';

  const config: Record<string, unknown> = {
    evaluator_id: grader.id,
    data_source: 'original_event',
    score_value_type: scoreValueType,
    score_config: grader.score_config || {},
    _blockly_hidden_eval: true,
    _blockly_node_id: nodeId,
    _blockly_output_field: 'primary_score',
    _blockly_evaluator_kind: kind,
  };

  if (kind === 'llm' && grader.llm_config) config.llm_config = grader.llm_config;
  else if (kind === 'code' && grader.code_config) config.code_config = grader.code_config;

  if (isResult) config._blockly_is_result = true;
  if (enclosingConditionIds?.length) config._blockly_enclosing_then_condition_ids = enclosingConditionIds;

  const task: Record<string, unknown> = {
    id: `${BLOCKLY_EVAL_TASK_ID_PREFIX}${nodeId}`,
    type: 'eval',
    generation_method: kind,
    label: `${BLOCKLY_EVAL_LABEL_PREFIX}${nodeId}`,
    config,
  };
  if (nextTaskId) task.next = nextTaskId;
  return task;
}

function buildGraderChain(opts: {
  graderIds: string[];
  graders: Record<string, Grader>;
  combine: string;
  weights?: number[];
  enclosingConditionIds?: string[];
}): { tasks: Record<string, unknown>[]; firstTaskId: string } {
  const { graderIds, graders, combine, weights, enclosingConditionIds } = opts;
  const tasks: Record<string, unknown>[] = [];

  if (graderIds.length === 1 || combine === 'single') {
    const gid = graderIds[0];
    const nodeId = safeNodeId(graders[gid].evaluator_slug || gid.slice(0, 8));
    const task = buildEvalTask({
      nodeId,
      grader: graders[gid],
      isResult: true,
      enclosingConditionIds,
    });
    tasks.push(task);
    return { tasks, firstTaskId: task.id as string };
  }

  const evalTaskIds: string[] = [];
  graderIds.forEach((gid, i) => {
    const nodeId = safeNodeId(graders[gid].evaluator_slug || `grader_${i}`);
    const task = buildEvalTask({ nodeId, grader: graders[gid], enclosingConditionIds });
    tasks.push(task);
    evalTaskIds.push(task.id as string);
  });

  const inputWeights = (weights && weights.length === graderIds.length)
    ? weights
    : graderIds.map(() => 1.0);

  const computeInputs = evalTaskIds.map((tid, i) => ({
    source: `task:${tid}`,
    field: 'primary_score',
    weight: inputWeights[i],
  }));

  const computeTask: Record<string, unknown> = {
    id: `${BLOCKLY_COMPUTE_TASK_ID_PREFIX}combine`,
    type: 'compute',
    label: `${BLOCKLY_COMPUTE_LABEL_PREFIX}combine`,
    config: {
      function: 'weighted_average',
      inputs: computeInputs,
      _blockly_node_id: 'combine',
      _blockly_is_result: true,
      ...(enclosingConditionIds?.length ? { _blockly_enclosing_then_condition_ids: enclosingConditionIds } : {}),
    },
  };
  tasks.push(computeTask);
  return { tasks, firstTaskId: evalTaskIds[0] };
}

async function buildPipelineTasks(
  c: AuthenticatedClient,
  args: {
    steps: { grader_id: string }[];
    combine?: string;
    weights?: number[];
    condition?: {
      check_grader_id?: string;
      metric?: string;
      operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
      value?: unknown;
      else_value?: unknown;
    };
  },
): Promise<{ tasks: Record<string, unknown>[]; error?: string }> {
  const { steps, weights, condition } = args;
  if (!steps?.length) return { tasks: [], error: 'At least one step (grader) is required.' };

  const combine = args.combine || (steps.length === 1 ? 'single' : 'average');

  const graders: Record<string, Grader> = {};
  for (const step of steps) {
    if (!step.grader_id) return { tasks: [], error: 'Each step must have a grader_id.' };
    const g = await fetchGrader(c, step.grader_id);
    if (!g) return { tasks: [], error: `Grader ${step.grader_id} not found. Create and commit it first with grader_create + grader_commit.` };
    graders[step.grader_id] = g;
  }
  if (condition?.check_grader_id && !graders[condition.check_grader_id]) {
    const g = await fetchGrader(c, condition.check_grader_id);
    if (!g) return { tasks: [], error: `Condition check grader ${condition.check_grader_id} not found.` };
    graders[condition.check_grader_id] = g;
  }
  if (condition && !condition.check_grader_id && !condition.metric) {
    return { tasks: [], error: 'condition must include either check_grader_id (grader-based) or metric (event-based, e.g. "event.cost").' };
  }
  if (condition?.check_grader_id && condition?.metric) {
    return { tasks: [], error: 'condition can use either check_grader_id OR metric, not both.' };
  }

  const tasks: Record<string, unknown>[] = [];

  if (condition) {
    const operator = condition.operator || 'gt';
    const value = condition.value ?? 0;
    const hasElse = 'else_value' in condition;

    const mainGraderIds = steps.map(s => s.grader_id);
    const { tasks: thenTasks, firstTaskId: thenResultId } = buildGraderChain({
      graderIds: mainGraderIds,
      graders,
      combine,
      weights,
      enclosingConditionIds: ['gate'],
    });

    let switchTask: Record<string, unknown>;

    if (condition.metric) {
      // Metric-based switch: reads event field directly, no preceding eval task, no data_source
      switchTask = {
        id: 'gate',
        type: 'switch',
        label: 'gate',
        config: {
          cases: [{
            condition_policy: { [condition.metric]: { operator, value } },
            target: thenResultId,
          }],
        },
      };
    } else {
      // Grader-based switch: preceded by an eval task scoring the check grader
      const checkGid = condition.check_grader_id!;
      tasks.push(buildEvalTask({
        nodeId: 'check',
        grader: graders[checkGid],
        nextTaskId: 'gate',
      }));
      switchTask = {
        id: 'gate',
        type: 'switch',
        label: 'gate',
        config: {
          data_source: 'previous_task',
          cases: [{
            condition_policy: { 'input.primary_score': { operator, value } },
            target: thenResultId,
          }],
        },
      };
    }

    if (hasElse) {
      const elseTask = {
        id: 'blockly_else_constant',
        type: 'transform',
        label: 'blockly_else_constant',
        config: {
          transform_type: 'constant',
          params: { value: condition.else_value },
          _blockly_is_result: true,
          _blockly_branch_path: ['else:gate'],
        },
      };
      (switchTask.config as Record<string, unknown>).default = 'blockly_else_constant';
      tasks.push(switchTask, ...thenTasks, elseTask);
    } else {
      switchTask.next = thenResultId;
      tasks.push(switchTask, ...thenTasks);
    }
  } else {
    const { tasks: mainTasks } = buildGraderChain({
      graderIds: steps.map(s => s.grader_id),
      graders,
      combine,
      weights,
    });
    tasks.push(...mainTasks);
  }

  return { tasks };
}

export function registerEvaluationPipelineTools(
  server: McpServer,
  client: AuthenticatedClient | null,
) {
  server.tool(
    'evaluator_create',
    "Create a V2 evaluator (renders in the Blockly visual editor). Takes grader IDs (from grader_create) and an optional combine method. Handles all Blockly metadata automatically — you only provide the semantic structure. ALWAYS use this (not grader_create) when creating an evaluator the user will see on the Evaluators page. Patterns: - Single grader: steps=[{grader_id: 'abc'}] - Average: steps=[{grader_id: 'abc'}, {grader_id: 'def'}], combine='average' - Weighted avg: steps=[...], combine='weighted_average', weights=[0.6, 0.4] - Condition gate: steps=[{grader_id: 'abc'}], condition={check_grader_id: 'xyz', operator: 'gt', value: 50, else_value: 0} steps[].grader_id wants a GRADER id — never an evaluator id. RETURNS: `id` (version PK — the id experiment_create.evaluator_workflow_ids and scores__<id> sort keys want) and `workflow_id` (family id).",
    {
      name: z.string().describe('Evaluator name (displayed on the Evaluators page)'),
      description: z.string().optional().describe('Evaluator description'),
      steps: z
        .array(z.object({
          grader_id: z.string().describe('ID of a grader created via grader_create + grader_commit — NOT an evaluator id'),
        }))
        .describe('Graders in the evaluator. Each item: {grader_id: string}'),
      combine: z
        .enum(['single', 'average', 'weighted_average'])
        .optional()
        .describe("How to combine multiple graders. Default: 'single' (1 grader) or 'average' (2+ graders)"),
      weights: z
        .array(z.number())
        .optional()
        .describe('Weights for weighted_average. Must match steps count. E.g. [0.6, 0.4]'),
      condition: z
        .object({
          check_grader_id: z.string().optional().describe('Grader ID to evaluate first (the condition input). Use this OR metric, not both.'),
          metric: z.string().optional().describe('Event metric path to gate on. Examples: "event.cost", "event.latency", "event.prompt_tokens", "event.completion_tokens", "event.total_tokens", "event.model". Use this OR check_grader_id, not both.'),
          operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']).describe('Comparison operator'),
          value: z.any().describe('Threshold value to compare against'),
          else_value: z.any().optional().describe('Constant value to output when condition is false (e.g. 0 or false). Omit for If/Then mode (no output on failure).'),
        })
        .optional()
        .describe('Optional condition gate. Evaluates check_grader before running the main graders. Two modes: - If/Then/Else: provide else_value — outputs that constant when condition fails. - If/Then (no else): omit else_value — skips the main graders entirely when condition fails (no output).'),
    },
    async ({ name, description, steps, combine, weights, condition }) => {
      const c = requireClient(client);
      const { tasks, error } = await buildPipelineTasks(c, { steps, combine, weights, condition });
      if (error) throw new Error(error);

      const body: Record<string, unknown> = {
        name,
        type: 'evaluators',
        trigger_event_type: 'eval_only',
        tasks,
        ...(description ? { description } : {}),
      };
      const data = await rawFetch(c, '/api/workflows/', { method: 'POST', body });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'evaluator_list',
    "List the user-visible evaluators (V2). Returns all evaluators for the organization. This is the data shown on the Evaluators page. RETURNS per row: `id` (version PK — the id experiment_create.evaluator_workflow_ids and scores__<id> sort keys want) and `workflow_id` (family id). Graders (the building blocks) are listed by grader_list, not here. No row for a name the user called an evaluator does NOT mean it is absent: users say 'evaluator' for a bare grader too. Check grader_list for that name before reporting it missing, and test a grader with grader_run.",
    {
      name: z.string().optional().describe('Filter by evaluator name (contains)'),
      ...paginationShape('evaluator_list'),
      sort_by: z.string().optional().describe('Sort field. Default: -created_at'),
    },
    async ({ name, page, page_size, sort_by }) => {
      const c = requireClient(client);
      const paging = clampPagination('evaluator_list', { page, page_size });
      const q = new URLSearchParams();
      q.set('page', String(paging.page));
      q.set('page_size', String(paging.page_size));
      if (sort_by) q.set('sort_by', sort_by);

      // `name` must ride in the body. An unrecognized query param is parsed as a
      // metadata filter and blows away the whole filter set, `type` included, so
      // a name= call sent that way returns every workflow kind, not evaluators.
      const filters: Record<string, { value: unknown; operator: string }> = {
        type: { value: ['evaluators'], operator: 'eq' },
      };
      if (name) filters.name = { value: name, operator: 'icontains' };

      const data = await rawFetch(c, `/api/workflows/list/?${q.toString()}`, {
        method: 'POST',
        body: { filters },
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'evaluator_get',
    "Get an evaluator (V2) by ID. Returns a human-readable summary: which graders are used, how they're combined, and any conditions. Use grader_get for the single-step graders inside the evaluator.",
    {
      evaluator_id: z.string().describe('The evaluator to fetch: family workflow_id OR the version PK `id` (either is accepted; both are returned by evaluator_list/create).'),
    },
    async ({ evaluator_id }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, `/api/workflows/${evaluator_id}/`, { method: 'GET' });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'evaluator_update',
    "Update an existing evaluator. Replaces the evaluator's graders, combine method, weights, and/or conditions. Also supports updating name and description. Use THIS (never evaluator_create, never grader_update, never grader_create) to RENAME an evaluator or to ADD, REMOVE, RE-COMPOSE or SWAP the graders inside one. Pure rename: pass name only; graders/combine are kept. steps, when provided, REPLACES the full grader list — to add a grader, include the existing ones too. The evaluator's Blockly tasks are regenerated automatically.",
    {
      evaluator_id: z.string().describe('The evaluator to update: family workflow_id OR the version PK `id` (either is accepted; both are returned by evaluator_list/create).'),
      name: z.string().optional().describe('New evaluator name (optional — omit to keep current)'),
      description: z.string().optional().describe('New evaluator description (optional)'),
      steps: z
        .array(z.object({ grader_id: z.string().describe('ID of a committed grader') }))
        .optional()
        .describe('Updated graders. Each item: {grader_id: string}. If provided, replaces ALL existing graders.'),
      combine: z.enum(['single', 'average', 'weighted_average']).optional().describe('How to combine multiple graders'),
      weights: z.array(z.number()).optional().describe('Weights for weighted_average. Must match steps count.'),
      condition: z
        .object({
          check_grader_id: z.string().optional(),
          metric: z.string().optional(),
          operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
          value: z.any(),
          else_value: z.any().optional().describe('Omit for If/Then mode (no output on failure).'),
        })
        .optional()
        .describe('Optional condition gate. Provide else_value for If/Then/Else; omit else_value for If/Then (no output on failure).'),
    },
    async ({ evaluator_id, name, description, steps, combine, weights, condition }) => {
      const c = requireClient(client);
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (steps) {
        const { tasks, error } = await buildPipelineTasks(c, { steps, combine, weights, condition });
        if (error) throw new Error(error);
        body.tasks = tasks;
      }
      if (Object.keys(body).length === 0) {
        throw new Error('No fields to update. Provide at least one of: name, description, steps.');
      }
      const data = await rawFetch(c, `/api/workflows/${evaluator_id}/`, { method: 'PATCH', body });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}
