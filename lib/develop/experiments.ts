import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient, rawFetch } from "../shared/client.js";

export function registerExperimentTools(
  server: McpServer,
  client: AuthenticatedClient | null
) {
  server.tool(
    "experiment_list",
    "List experiments. Returns name, dataset, status, progress, workflow_count, tags.",
    {
      page: z.number().optional().describe("Page number (default: 1)"),
      page_size: z.number().optional().describe("Page size (default: 10, max: 25)"),
    },
    async ({ page_size, page }) => {
      const c = requireClient(client);
      const data = await c.client.experiments.listExperiments({
        Authorization: c.auth,
        ...(page_size ? { page_size } : {}),
        ...(page ? { page } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "experiment_get",
    "Get full experiment details by ID, including workflow configuration, evaluator version IDs, dataset, status, progress, and timestamps.",
    {
      experiment_id: z.string().describe("Experiment ID"),
    },
    async ({ experiment_id }) => {
      const c = requireClient(client);
      const data = await c.client.experiments.retrieveExperiment({
        Authorization: c.auth,
        experiment_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "experiment_create",
    "Create and run an experiment. Processes a dataset through workflow tasks (prompt → completion) and scores results with evaluators. Returns experiment object with status. Workflow types: 'prompt' (test a saved prompt on data — needs prompt_id), 'completion' (run a raw model on data — needs model), 'duplicate' (passthrough for scoring existing data as-is), 'condition' (needs condition_policy). evaluator_workflow_ids wants each evaluator's version PK `id` (from evaluator_list/create) — NOT the evaluator's `workflow_id` (family) and NOT a grader id. Wrong id type is the top cause of 404s here; on rejection, list evaluators and check which field the UUID matches.",
    {
      dataset_id: z.string().describe("Dataset ID to process"),
      workflow: z
        .array(
          z.object({
            type: z.enum(["prompt", "completion", "duplicate", "condition"]),
            config: z
              .record(z.any())
              .describe("Type-specific config. prompt: {prompt_id}, completion: {model, temperature, ...}, duplicate: {name}"),
          })
        )
        .describe("Workflow tasks in execution order. Each item: {type, config}. Types: prompt, completion, duplicate, condition."),
      evaluator_workflow_ids: z
        .array(z.string())
        .describe("Evaluator version IDs (version PK) (the 'id' field from evaluator_list or evaluator_create, NOT 'workflow_id'). These evaluators score each log after the workflow completes."),
      name: z.string().optional().describe("Experiment name"),
      description: z.string().optional().describe("Experiment description"),
      batch_size: z.number().optional().describe("Batch size for processing (default: 100)"),
      concurrency: z.number().optional().describe("Concurrent workers (default: 15)"),
      enable_tracing: z.boolean().optional().describe("Create trace logs (default: true)"),
    },
    async ({ dataset_id, workflow, evaluator_workflow_ids, name, description, batch_size, concurrency, enable_tracing }) => {
      if (!evaluator_workflow_ids?.length) {
        throw new Error("evaluator_workflow_ids is required. At least one evaluator version ID is needed. Use evaluator_list or evaluator_create first.");
      }
      const c = requireClient(client);
      const normalizedWorkflow = workflow.map(w => ({ ...w, config: w.config || {} }));
      const body: Record<string, unknown> = {
        dataset_id,
        workflow: normalizedWorkflow,
        evaluator_workflow_ids,
      };
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (batch_size !== undefined) body.batch_size = batch_size;
      if (concurrency !== undefined) body.concurrency = concurrency;
      if (enable_tracing !== undefined) body.enable_tracing = enable_tracing;
      const data = await rawFetch(c, "/api/v2/experiments/", { method: "POST", body });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "experiment_logs_list",
    "List logs/traces for an experiment. Returns traces with scores, cost, tokens, latency (input/output content is stripped — use experiment_log_get for full details). Rows without a populated scores field mean the experiment is still running or had no evaluator attached — report that honestly, never treat it as a zero score.",
    {
      experiment_id: z.string().describe("Experiment ID"),
    },
    async ({ experiment_id }) => {
      const c = requireClient(client);
      const data = await c.client.experiments.listExperimentSpans({
        Authorization: c.auth,
        experiment_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "experiment_log_get",
    "Get full details of a single experiment log/trace by ID. Returns complete input, output, expected_output, scores with evaluator reasoning, span tree, and all metrics. Use this after experiment_logs_list to drill into specific logs for analysis.",
    {
      experiment_id: z.string().describe("Experiment ID"),
      log_id: z
        .string()
        .describe("Log/trace ID (the 'id' field from experiment_logs_list results)"),
    },
    async ({ experiment_id, log_id }) => {
      const c = requireClient(client);
      const data = await c.client.experiments.retrieveExperimentSpan({
        Authorization: c.auth,
        experiment_id,
        log_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "experiment_delete",
    "Delete an experiment. DANGEROUS: You MUST ask the user to confirm the experiment name before deleting.",
    {
      experiment_id: z.string().describe("Experiment ID"),
      user_confirmation: z
        .string()
        .describe("REQUIRED: The exact experiment name as typed by the user."),
    },
    async ({ experiment_id }) => {
      const c = requireClient(client);
      await c.client.experiments.deleteExperiment({
        Authorization: c.auth,
        experiment_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ deleted: true, experiment_id }, null, 2) }],
      };
    }
  );

  server.tool(
    "experiment_logs_summary",
    `Get aggregate score statistics for an experiment's logs, summarized by evaluator. Computed client-side by walking the experiment's logs, so it also works when the backend summary and histogram endpoints return empty score aggregates (a known issue on some experiments). Returns avg, min, max and count per evaluator. Walks up to max_spans logs (default 500).`,
    {
      experiment_id: z.string().describe("Experiment ID"),
      max_spans: z.number().optional().describe("Maximum logs to walk (default: 500). Increase for large experiments."),
    },
    async ({ experiment_id, max_spans = 500 }) => {
      const c = requireClient(client);
      const buckets: Record<string, {
        count: number;
        sum: number;
        min: number;
        max: number;
        name: string;
        score_type: string;
      }> = {};
      let scanned = 0;
      let page = 1;
      const pageSize = 50;
      while (scanned < max_spans) {
        const resp = await c.client.experiments.listExperimentSpans({
          Authorization: c.auth,
          experiment_id,
        });
        const results = (resp as { results?: unknown[] }).results || [];
        if (!results.length) break;
        const addScore = (key: string, name: string, scoreType: string, val: number) => {
          if (Number.isNaN(val)) return;
          if (!buckets[key]) {
            buckets[key] = { count: 0, sum: 0, min: val, max: val, name, score_type: scoreType };
          }
          buckets[key].count++;
          buckets[key].sum += val;
          if (val < buckets[key].min) buckets[key].min = val;
          if (val > buckets[key].max) buckets[key].max = val;
        };
        const extractPipelineScore = (raw: unknown, taskKey: string): boolean => {
          let parsed: unknown = raw;
          if (typeof raw === "string") { try { parsed = JSON.parse(raw); } catch { return false; } }
          const p = parsed as { workflow_type?: string; output?: { primary_score?: unknown; evaluator_id?: string; evaluator_name?: string; score_value_type?: string } };
          if (p?.workflow_type !== "eval" || !p.output) return false;
          const evalOut = p.output;
          const raw_score = evalOut.primary_score;
          if (raw_score === null || raw_score === undefined) return false;
          const val = typeof raw_score === "boolean" ? (raw_score ? 1 : 0) : Number(raw_score);
          if (Number.isNaN(val)) return false;
          addScore(evalOut.evaluator_id || taskKey, evalOut.evaluator_name || taskKey, evalOut.score_value_type || "numerical", val);
          return true;
        };
        const walkTreeForEvals = (node: { name?: string; span_name?: string; output?: unknown; children?: unknown[] }) => {
          const taskKey = node.span_name || node.name || "";
          if (taskKey.includes("eval.task") || taskKey.includes("llm_eval")) {
            extractPipelineScore(node.output, taskKey);
          }
          for (const c of (node.children || []) as { name?: string; span_name?: string; output?: unknown; children?: unknown[] }[]) walkTreeForEvals(c);
        };

        for (const span of results) {
          const s = span as {
            id?: string;
            scores?: Record<string, Record<string, unknown>>;
            task_metrics?: Record<string, { output?: unknown }>;
          };
          // Legacy path: span.scores populated by direct evaluator runs
          for (const [key, score] of Object.entries(s.scores || {})) {
            if (!score || typeof score !== "object") continue;
            const name = (score.evaluator_name as string) || key.split(":")[0];
            const val = score.numerical_value !== null && score.numerical_value !== undefined
              ? Number(score.numerical_value)
              : score.boolean_value !== null && score.boolean_value !== undefined
                ? (score.boolean_value ? 1 : 0)
                : null;
            if (val === null) continue;
            addScore(key, name, (score.score_value_type as string) || "numerical", val);
          }
          // Pipeline path: scores live inside task_metrics[<eval_task>].output (JSON string).
          // List endpoint truncates output to ~50 chars — detect truncation and fall back to detail fetch.
          let foundFromList = false;
          let needsDetail = false;
          for (const [taskKey, task] of Object.entries(s.task_metrics || {})) {
            if (!task || typeof task !== "object" || !("output" in task)) continue;
            if (!taskKey.includes("eval")) continue;
            const raw = task.output;
            if (typeof raw === "string" && (raw.length < 200 || !raw.trim().endsWith("}"))) {
              needsDetail = true;
              continue;
            }
            if (extractPipelineScore(raw, taskKey)) foundFromList = true;
          }
          if (needsDetail && !foundFromList && s.id) {
            try {
              const detail = await c.client.experiments.retrieveExperimentSpan({
                Authorization: c.auth,
                experiment_id,
                log_id: s.id,
              }) as { span_tree?: unknown[] };
              for (const root of (detail.span_tree || []) as { name?: string; span_name?: string; output?: unknown; children?: unknown[] }[]) walkTreeForEvals(root);
            } catch { /* skip on error */ }
          }
        }
        scanned += results.length;
        // Most list endpoints aren't paginated here; break after first call unless backend supports paging.
        break;
        // Note: listExperimentSpans currently returns all spans in one call.
      }
      const result = Object.entries(buckets).map(([key, b]) => ({
        evaluator_key: key,
        evaluator_name: b.name,
        score_type: b.score_type,
        count: b.count,
        avg: b.count ? b.sum / b.count : 0,
        min: b.min,
        max: b.max,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ experiment_id, spans_scanned: scanned, evaluators: result }, null, 2) }],
      };
    }
  );

}
