import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthenticatedClient } from '../shared/client.js';
import { requireClient, rawFetch } from '../shared/client.js';
import { clampPagination, paginationShape } from '../shared/pagination.js';

const GRADER_ID_DESCRIPTION =
  "Grader ID. This is an id, NOT a name: if all you have is the name the user said, call grader_list(name=...) first and pass the `id` it returns.";

export function registerEvaluatorTools(server: McpServer, client: AuthenticatedClient | null) {
  server.tool(
    'grader_list',
    "List graders (single-step evaluators) for an organization. Returns latest version of each grader. By default only the org's own graders are listed — public (Respan-managed) graders are hidden unless is_including_public_evaluators=true. ID SEMANTICS: a grader's `id` is its FAMILY id (stable across versions); `version_id` is the per-version row PK. This is the INVERSE of evaluators, whose `id` is the version PK and `workflow_id` the family. To list the user-visible evaluators themselves, use evaluator_list — NOT this tool.",
    {
      name: z.string().optional().describe('Filter by grader name (contains)'),
      score_value_type: z
        .enum(['numerical', 'boolean', 'percentage', 'single_select', 'multi_select', 'json', 'text'])
        .optional()
        .describe('Filter by score type: numerical, boolean, percentage, single_select, multi_select, json, text.'),
      starred: z.boolean().optional().describe('Filter to favourited graders only.'),
      is_including_public_evaluators: z
        .boolean()
        .optional()
        .describe("Include public (Respan-managed, org-independent) graders alongside the org's own (default: false). Use for 'what evaluators do you offer'."),
      ...paginationShape('grader_list'),
      sort_by: z.string().optional().describe('Sort field (default: name)'),
    },
    async ({ name, score_value_type, starred, is_including_public_evaluators, page, page_size, sort_by }) => {
      const c = requireClient(client);
      // Every field below must exist on the backing model. A filter on a field
      // that does not is NOT a no-op: the server catches the FieldError and
      // resets the whole query, returning the FULL unfiltered list and dropping
      // the sibling filters in the same call. Narrow this set only against the
      // model. (`enabled` used to be advertised here and did exactly that.)
      const filters: Record<string, { operator: string; value: unknown }> = {};
      if (name !== undefined) filters.name = { operator: 'icontains', value: name };
      if (score_value_type !== undefined) filters.score_value_type = { operator: '', value: score_value_type };
      if (starred !== undefined) filters.starred = { operator: '', value: starred };

      // Filtering is POST-only on this endpoint. The SDK's GET list method
      // cannot carry `filters`, so a name= call through it returned everything.
      const q = new URLSearchParams();
      const paging = clampPagination('grader_list', { page, page_size });
      q.set('page', String(paging.page));
      q.set('page_size', String(paging.page_size));
      if (sort_by !== undefined) q.set('sort_by', sort_by);
      if (is_including_public_evaluators) q.set('is_including_public_evaluators', 'true');

      const data = await rawFetch(c, `/api/evaluators/list/?${q.toString()}`, {
        method: 'POST',
        body: Object.keys(filters).length > 0 ? { filters } : {},
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'grader_get',
    'Get a grader by ID. Returns the latest version with full config (llm_config, code_config, score_config). The grader `id` is the family id (same across versions); `version_id` is the row PK. Graders only — an evaluator id fails here (use evaluator_get for evaluators).',
    {
      grader_id: z.string().describe(GRADER_ID_DESCRIPTION),
    },
    async ({ grader_id }) => {
      const c = requireClient(client);
      const data = await c.client.evaluators.retrieveEvaluator({ Authorization: c.auth, evaluator_id: grader_id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'grader_create',
    `Create a new grader. Graders are the internal building blocks; the user-visible evaluator is composed of them. After creating and committing a grader, use evaluator_create to wrap it in an evaluator. NOT for changing an existing evaluator: adding/removing a grader in an evaluator or renaming one is evaluator_update(steps=[...]) — reaching for grader_create there builds an orphan the evaluator never sees. Required: name, score_value_type, type. For type='llm': MUST include llm_config with model + evaluator_definition. evaluator_definition is a Jinja2 template — MUST contain {{output}}. Use {{input}} for the user question and {{expected_output}} for ground truth. Example for a boolean LLM grader: {"name": "Hallucination Check", "type": "llm", "score_value_type": "boolean", "llm_config": {"model": "gpt-4o-mini", "evaluator_definition": "Score whether this output hallucinates.\\nInput: {{input}}\\nOutput: {{output}}\\nReturn true or false."}}`,
    {
      name: z.string().describe('Grader name'),
      score_value_type: z
        .enum(['numerical', 'boolean', 'percentage', 'single_select', 'multi_select', 'json', 'text'])
        .describe('Score type: numerical, boolean, percentage, single_select, multi_select, json, text'),
      type: z
        .enum(['llm', 'code', 'human'])
        .optional()
        .describe('Grader type: human (default), llm, code. Set llm for LLM-based eval (requires llm_config), code for code-based eval (requires code_config), or omit for human eval (no automation config needed).'),
      description: z.string().optional().describe('Grader description'),
      evaluator_slug: z.string().optional().describe('Unique slug identifier'),
      score_config: z
        .record(z.any())
        .optional()
        .describe('Score configuration: {min_score, max_score, choices: [{name, value}]}'),
      passing_conditions: z
        .record(z.any())
        .optional()
        .describe("Passing conditions: {primary_score: {operator: 'gte', value: 3}}"),
      llm_config: z
        .record(z.any())
        .optional()
        .describe('LLM automation config. Fields: REQUIRED: model (str), evaluator_definition (str — prompt template, MUST contain {{output}}). RECOMMENDED: scoring_rubric (str — scoring instructions appended after definition). OPTIONAL: temperature (float), top_p (float), max_tokens (int), max_completion_tokens (int), frequency_penalty (float), presence_penalty (float), stop (str|list), response_format (object), reasoning_effort (str: \'low\'|\'medium\'|\'high\'), verbosity (str). Example: {"model": "gpt-4o-mini", "evaluator_definition": "Evaluate: {{output}}", "scoring_rubric": "Score 1-5", "temperature": 0.0}'),
      code_config: z
        .record(z.any())
        .optional()
        .describe("Code automation: {eval_code_snippet: 'def main(eval_inputs): ...'}"),
      categorical_choices: z
        .array(z.record(z.any()))
        .optional()
        .describe('Choices for single_select/multi_select: [{name, value}]'),
      configurations: z
        .record(z.any())
        .optional()
        .describe('Legacy configurations object (prefer score_config + llm_config + code_config instead)'),
    },
    async (params) => {
      const c = requireClient(client);
      const { name, score_value_type, description, evaluator_slug, score_config, passing_conditions, llm_config, code_config, categorical_choices, configurations } = params;
      // Backend default when the caller omits it.
      const type = params.type ?? 'human';

      if (type === 'llm') {
        if (!llm_config) {
          throw new Error('LLM graders require llm_config. Include at minimum: { "model": "gpt-4o-mini", "evaluator_definition": "<prompt with {{output}}>" }');
        }
        const def = llm_config.evaluator_definition;
        if (!def) {
          throw new Error('LLM graders require evaluator_definition in llm_config — the prompt template the LLM uses to score. Must contain {{output}}.');
        }
        if (typeof def === 'string' && !def.includes('{{output}}')) {
          throw new Error('evaluator_definition MUST contain the {{output}} template variable. Without it, the grader cannot see the output it is supposed to score.');
        }
        if (!llm_config.model) {
          throw new Error('LLM graders require llm_config.model (e.g. "gpt-4o-mini").');
        }
      }
      if (type === 'code') {
        if (!code_config || !code_config.eval_code_snippet) {
          throw new Error('Code graders require code_config with eval_code_snippet. Include: { "eval_code_snippet": "def main(eval_inputs): ..." }');
        }
      }

      const data = await c.client.evaluators.createEvaluator({
        Authorization: c.auth,
        name,
        type,
        score_value_type,
        ...(evaluator_slug ? { evaluator_slug } : {}),
        ...(description ? { description } : {}),
        ...(score_config ? { score_config } : {}),
        ...(passing_conditions ? { passing_conditions } : {}),
        ...(llm_config ? { llm_config } : {}),
        ...(code_config ? { code_config } : {}),
        ...(categorical_choices ? { categorical_choices } : {}),
        ...(configurations ? { configurations } : {}),
      });
      const result = data as Record<string, unknown>;
      const id = result?.id ?? result?.evaluator_id;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...result,
            _next_steps: `Created as draft. To use in production: 1) grader_run with sample inputs to verify, 2) grader_commit to lock the version, 3) evaluator_create to make it show on the Evaluators page.`,
            _grader_id: id,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'grader_run',
    `Test-run a grader with sample inputs. Returns the grader's score and reasoning. Always run before committing to verify the grader works correctly. inputs must include at least "input" and "output" keys with realistic sample data. Example: {"grader_id": "abc123", "inputs": {"input": "What is 2+2?", "output": "The answer is 4."}}`,
    {
      grader_id: z
        .string()
        .describe("Grader `id` (family id — resolves to the latest version). NOT an evaluator id and NOT a grader `version_id`. Append ':version' only to pin a non-latest version. This is an id, NOT a name: if all you have is the name the user said, call grader_list(name=...) first and pass the `id` it returns."),
      inputs: z
        .record(z.any())
        .describe('Sample data for evaluation. Required keys: "input" (user question), "output" (LLM response to score). Optional: "expected_output" (ground truth), "metrics" (numerical data), "metadata" (extra context). Example: {"input": "What is the capital of France?", "output": "Paris is the capital."}'),
      generation_method: z
        .enum(['auto', 'llm', 'code'])
        .optional()
        .describe('Force evaluation method: auto (default), llm, code'),
    },
    async ({ grader_id, inputs, generation_method }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, `/api/evaluators/${grader_id}/run/`, {
        method: 'POST',
        body: {
          inputs,
          ...(generation_method ? { generation_method } : {}),
        },
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'grader_commit',
    'Commit the current draft of a grader, creating a new read-only version. IMPORTANT: Only commit AFTER a successful test run with grader_run. After committing, use evaluator_create to wrap the grader in a user-visible evaluator.',
    {
      grader_id: z.string().describe(GRADER_ID_DESCRIPTION),
      version_description: z.string().optional().describe('Description of what changed in this version (commit message)'),
    },
    async ({ grader_id, version_description }) => {
      const c = requireClient(client);
      const data = await rawFetch(c, `/api/evaluators/${grader_id}/versions/`, {
        method: 'POST',
        body: version_description ? { version_description } : {},
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'grader_versions_list',
    'List all versions of a grader.',
    {
      grader_id: z.string().describe(GRADER_ID_DESCRIPTION),
      ...paginationShape('grader_versions_list'),
    },
    async ({ grader_id, page, page_size }) => {
      const c = requireClient(client);
      const paging = clampPagination('grader_versions_list', { page, page_size });
      const q = new URLSearchParams();
      q.set('page', String(paging.page));
      q.set('page_size', String(paging.page_size));
      const path = `/api/evaluators/${grader_id}/versions/?${q.toString()}`;
      const data = await rawFetch(c, path, { method: 'GET' });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'grader_update',
    'Update a grader draft (only if not read-only). Use to fix config before committing.',
    {
      grader_id: z.string().describe(GRADER_ID_DESCRIPTION),
      name: z.string().optional().describe('New grader name'),
      description: z.string().optional().describe('New description'),
      enabled: z.boolean().optional().describe('Enable/disable grader'),
      score_config: z.record(z.any()).optional().describe('Score configuration: {min_score, max_score, choices}'),
      passing_conditions: z.record(z.any()).optional().describe('Passing conditions: {primary_score: {operator, value}}'),
      llm_config: z
        .record(z.any())
        .optional()
        .describe('LLM automation config. Fields: model (str), evaluator_definition (str — MUST contain {{output}}), scoring_rubric (str), temperature (float), top_p (float), max_tokens (int), max_completion_tokens (int), frequency_penalty (float), presence_penalty (float), stop (str|list), response_format (object), reasoning_effort (str), verbosity (str).'),
      code_config: z.record(z.any()).optional().describe('Code automation config: {eval_code_snippet}'),
      configurations: z
        .record(z.any())
        .optional()
        .describe('Legacy configurations object (prefer score_config + llm_config + code_config instead)'),
    },
    async ({ grader_id, name, description, enabled, score_config, passing_conditions, llm_config, code_config, configurations }) => {
      const c = requireClient(client);
      const data = await c.client.evaluators.updateEvaluator({
        Authorization: c.auth,
        evaluator_id: grader_id,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(score_config !== undefined ? { score_config } : {}),
        ...(passing_conditions !== undefined ? { passing_conditions } : {}),
        ...(llm_config !== undefined ? { llm_config } : {}),
        ...(code_config !== undefined ? { code_config } : {}),
        ...(configurations !== undefined ? { configurations } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'grader_delete',
    'Delete a grader (all versions). DANGEROUS: You MUST ask the user to type out the exact grader name they want to delete.',
    {
      grader_id: z.string().describe(GRADER_ID_DESCRIPTION),
      user_confirmation: z.string().describe('REQUIRED: The exact grader name as typed by the user in chat.'),
    },
    async ({ grader_id, user_confirmation }) => {
      const c = requireClient(client);
      // Declaring user_confirmation without checking it makes the gate
      // decorative: the model supplies any string and the delete proceeds.
      // Resolve the real name and refuse on mismatch, as the backend does.
      const existing = await c.client.evaluators.retrieveEvaluator({ Authorization: c.auth, evaluator_id: grader_id }) as { name?: string };
      const actualName = existing?.name ?? '';
      if (user_confirmation !== actualName) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'confirmation_failed',
              message: `You typed '${user_confirmation}' but the grader name is '${actualName}'. Ask the user to type the exact name. Nothing was deleted.`,
            }, null, 2),
          }],
        };
      }
      await c.client.evaluators.deleteEvaluator({ Authorization: c.auth, evaluator_id: grader_id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, grader_id }, null, 2) }],
      };
    },
  );
}
