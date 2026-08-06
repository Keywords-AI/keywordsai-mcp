import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient } from "../shared/client.js";
import { clampPagination, paginationShape } from "../shared/pagination.js";

export function registerPromptTools(server: McpServer, client: AuthenticatedClient | null) {
  // 1. List all Prompts
  server.tool(
    "prompt_list",
    "List prompts for an organization (PAGINATED, default 20/page). Use for: browsing prompts, finding a prompt by name, or getting prompt_id values for other prompt tools. RETURNS per entry: prompt_id (string like 'prm_abc123'), name, description, tags, version (current draft version number), prompt_live_version_number (deployed version number, null if never deployed), is_read_only, model, message_count, system_preview. SCOPE: these fields describe where the prompt stands RIGHT NOW. This tool cannot answer anything about version history — how many versions exist, what an earlier version contained, or what changed between two. Use prompt_versions_list for history and prompt_version_get for a specific version's content. IMPORTANT: Always use prompt_id (string like 'prm_abc123') for all subsequent calls — never use the integer id.",
    {
      name: z.string().optional().describe("Filter by prompt name (contains)"),
      ...paginationShape("prompt_list"),
      sort_by: z
        .enum(["-id", "current_version__updated_at"])
        .optional()
        .describe("Sort field. Default: -id (newest first)."),
    },
    async ({ name, page_size, page, sort_by }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.listPrompts({
        Authorization: c.auth,
        ...clampPagination("prompt_list", { page, page_size }),
        // Name is a server-side filter, not a top-level field. Declaring it
        // without this mapping would silently return unfiltered results.
        ...(name ? { filters: { name: { operator: "icontains", value: [name] } } } : {}),
        ...(sort_by ? { sort_by } : {}),
      });

      // Strip bloat from list response:
      // 1. current_version.messages can contain base64 image data (use prompt_get instead)
      // 2. filters_data is backend filter metadata (~80KB) not useful for agents
      const cleaned = JSON.parse(JSON.stringify(data));
      delete cleaned.filters_data;
      const results = cleaned?.results ?? [];
      for (const prompt of results) {
        if (prompt?.current_version?.messages) {
          delete prompt.current_version.messages;
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(cleaned, null, 2) }],
      };
    }
  );

  // 2. Get single Prompt details
  server.tool(
    "prompt_get",
    "Get full details of a prompt by its prompt_id (e.g., 'prm_abc123'). Use after prompt_list to see all versions and activity history. RETURNS: everything from prompt_list plus prompt_versions (array of all versions with their messages, model, settings, readonly status, created_at).",
    {
      prompt_id: z.string().describe("Prompt ID (e.g., 'prm_abc123')"),
    },
    async ({ prompt_id }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.retrievePrompt({ Authorization: c.auth, prompt_id });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 3. List versions of a specific Prompt
  server.tool(
    "prompt_versions_list",
    "List all versions of a prompt (PAGINATED, default 20/page). Use to see version history and find which version to deploy. RETURNS per entry: version (int), description, model, readonly (bool — true=committed/deployable, false=draft), created_at, edited_by. prompt_deploy accepts both draft and committed versions (drafts are auto-committed before deployment).",
    {
      prompt_id: z.string().describe("Prompt ID"),
      ...paginationShape("prompt_versions_list"),
    },
    async ({ prompt_id, page, page_size }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.listPromptVersions({
        Authorization: c.auth,
        prompt_id,
        ...clampPagination("prompt_versions_list", { page, page_size }),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 4. Get details of a specific Prompt version
  server.tool(
    "prompt_version_get",
    "Get full content of a specific prompt version by version number. Use to inspect the exact messages and settings of any version. RETURNS: version (int), messages (full conversation template), model, temperature, max_tokens, top_p, frequency_penalty, presence_penalty, stream, variables, tools, tool_choice, response_format, fallback_models, load_balance_models, readonly (bool — true=committed, false=draft), edited_by, activities (version edit history).",
    {
      prompt_id: z.string().describe("Prompt ID"),
      version: z.number().describe("Version number"),
    },
    async ({ prompt_id, version }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.retrievePromptVersion({
        Authorization: c.auth,
        prompt_id,
        version,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 5. Create a new Prompt
  server.tool(
    "prompt_create",
    "Create a new prompt (Step 1 of 2). Creates the prompt container with name/description only. To add content (messages, model settings), call prompt_commit as Step 2.",
    {
      name: z.string().describe("Prompt name"),
      description: z.string().optional().describe("Prompt description"),
    },
    async ({ name, description }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.createPrompt({
        Authorization: c.auth,
        name,
        ...(description !== undefined ? { description } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 6. Update Prompt metadata
  server.tool(
    "prompt_update",
    "Update a prompt's name or description. To update version content (messages, model, settings), use prompt_version_update instead.",
    {
      prompt_id: z.string().describe("Prompt ID"),
      name: z.string().optional().describe("New prompt name"),
      description: z.string().optional().describe("New description"),
    },
    async ({ prompt_id, name, description }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.updatePrompt({
        Authorization: c.auth,
        prompt_id,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 7. Commit a new Prompt version
  server.tool(
    "prompt_commit",
    "Commit a new version of a prompt. In Respan a new version is a commit, it snapshots the messages and model settings you supply as the next version number. The commit is never deployed automatically, it lands as a draft snapshot. Call prompt_deploy with the returned version number to make it live.",
    {
      prompt_id: z.string().describe("Prompt ID"),
      description: z.string().optional().describe("Optional commit message/description"),
      messages: z
        .array(
          z.object({
            role: z.string().describe("Message role (e.g. system, user, assistant)"),
            content: z
              .string()
              .describe(
                "Message content text, may include {{variable}} placeholders"
              ),
          })
        )
        .describe("Array of message objects defining the prompt template"),
      model: z
        .string()
        .describe("Model identifier to use for this version (e.g. gpt-4o) — required"),
      temperature: z
        .number()
        .optional()
        .describe("Sampling temperature (0.0-2.0)"),
      max_tokens: z
        .number()
        .optional()
        .describe("Maximum number of tokens for the completion"),
      top_p: z.number().optional().describe("Top-p (nucleus) sampling parameter"),
      frequency_penalty: z
        .number()
        .optional()
        .describe("Frequency penalty (0.0-2.0)"),
      presence_penalty: z
        .number()
        .optional()
        .describe("Presence penalty (0.0-2.0)"),
    },
    async ({
      prompt_id,
      description,
      messages,
      model,
      temperature,
      max_tokens,
      top_p,
      frequency_penalty,
      presence_penalty,
    }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.createPromptVersion({
        Authorization: c.auth,
        prompt_id,
        messages,
        model,
        ...(description !== undefined ? { description } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(max_tokens !== undefined ? { max_tokens } : {}),
        ...(top_p !== undefined ? { top_p } : {}),
        ...(frequency_penalty !== undefined ? { frequency_penalty } : {}),
        ...(presence_penalty !== undefined ? { presence_penalty } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 8. Update an existing Prompt version
  server.tool(
    "prompt_version_update",
    "Update the current draft version of a prompt. Use this to edit messages, model, temperature, or any generation settings on the draft before committing. Only draft versions (readonly=False) can be updated. To make it live: call prompt_deploy with the draft version number.",
    {
      prompt_id: z.string().describe("Prompt ID"),
      version: z.number().describe("Version number of the draft to update"),
      messages: z
        .array(z.record(z.any()))
        .optional()
        .describe(
          'Array of message objects. Each message: {"role": "system"|"user"|"assistant", "content": [{"type": "text", "text": "the message text"}]}. Example: [{"role": "system", "content": [{"type": "text", "text": "You are a helpful assistant."}]}, {"role": "user", "content": [{"type": "text", "text": "{{user_input}}"}]}]'
        ),
      description: z.string().optional().describe("Version description"),
      model: z.string().optional().describe("Model to use (e.g., 'gpt-4')"),
      temperature: z.number().optional().describe("Temperature (0-2, default: 0.7)"),
      max_tokens: z.number().optional().describe("Max tokens (default: 4096)"),
      top_p: z.number().optional().describe("Top P (0-1, default: 1.0)"),
      frequency_penalty: z
        .number()
        .optional()
        .describe("Frequency penalty (-2 to 2, default: 0)"),
      presence_penalty: z
        .number()
        .optional()
        .describe("Presence penalty (-2 to 2, default: 0)"),
      stream: z
        .boolean()
        .optional()
        .describe("Enable streaming responses (default: false)"),
      variables: z
        .record(z.any())
        .optional()
        .describe(
          "Template variables as key-value pairs. Keys match {{variable_name}} placeholders in messages."
        ),
      fallback_models: z
        .array(z.string())
        .optional()
        .describe(
          "Fallback model names if primary model fails (e.g., ['gpt-3.5-turbo'])."
        ),
      load_balance_models: z
        .array(z.record(z.any()))
        .optional()
        .describe(
          "Load balance config: [{model: 'gpt-4', weight: 0.8}, {model: 'gpt-3.5-turbo', weight: 0.2}]."
        ),
      tools: z
        .array(z.record(z.any()))
        .optional()
        .describe("Tools array for function calling."),
      tool_choice: z
        .record(z.any())
        .nullable()
        .optional()
        .describe("Tool choice configuration. Set to null to clear."),
      response_format: z
        .record(z.any())
        .nullable()
        .optional()
        .describe("Response format configuration. Set to null to clear."),
      reasoning_effort: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Reasoning effort for reasoning models (e.g., 'low', 'medium', 'high'). Set to null to clear."
        ),
      seed: z
        .number()
        .nullable()
        .optional()
        .describe("Seed for reproducible outputs. Set to null to clear."),
    },
    async ({
      prompt_id,
      version,
      messages,
      description,
      model,
      temperature,
      max_tokens,
      top_p,
      frequency_penalty,
      presence_penalty,
      stream,
      variables,
      fallback_models,
      load_balance_models,
      tools,
      tool_choice,
      response_format,
      reasoning_effort,
      seed,
    }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.updatePromptVersion({
        Authorization: c.auth,
        prompt_id,
        version,
        deploy: false,
        ...(messages !== undefined ? { messages } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(max_tokens !== undefined ? { max_tokens } : {}),
        ...(top_p !== undefined ? { top_p } : {}),
        ...(frequency_penalty !== undefined ? { frequency_penalty } : {}),
        ...(presence_penalty !== undefined ? { presence_penalty } : {}),
        ...(stream !== undefined ? { stream } : {}),
        ...(variables !== undefined ? { variables } : {}),
        ...(fallback_models !== undefined ? { fallback_models } : {}),
        ...(load_balance_models !== undefined ? { load_balance_models } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(tool_choice !== undefined ? { tool_choice } : {}),
        ...(response_format !== undefined ? { response_format } : {}),
        ...(reasoning_effort !== undefined ? { reasoning_effort } : {}),
        ...(seed !== undefined ? { seed } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 9. Deploy a Prompt version
  server.tool(
    "prompt_deploy",
    "Deploy a prompt version as the live version. If the version is still a draft, it will be auto-committed first. Just pass the version number you want to deploy — no need to call prompt_commit separately.",
    {
      prompt_id: z.string().describe("Prompt ID"),
      version: z
        .number()
        .describe("Version number to deploy (drafts will be auto-committed)"),
    },
    async ({ prompt_id, version }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.updatePromptVersion({
        Authorization: c.auth,
        prompt_id,
        version,
        deploy: true,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
