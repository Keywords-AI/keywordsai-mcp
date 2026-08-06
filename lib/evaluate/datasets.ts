import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthenticatedClient } from '../shared/client.js';
import { requireClient } from '../shared/client.js';

export function registerDatasetTools(server: McpServer, client: AuthenticatedClient | null) {
  server.tool(
    'dataset_list',
    'List datasets for an organization.',
    {
      page: z.number().optional().describe('Page number (default: 1)'),
      page_size: z.number().optional().describe('Page size (default: 50, max: 100)'),
      sort_by: z.string().optional().describe('Sort field (default: -created_at). Prefix with - for descending.'),
    },
    async ({ page_size = 50, page = 1, sort_by }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.listDatasets({
        Authorization: c.auth,
        page_size,
        page,
        ...(sort_by ? { sort_by } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'dataset_get',
    'Get a dataset by ID.',
    {
      dataset_id: z.string().describe('Dataset ID'),
    },
    async ({ dataset_id }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.retrieveDataset({ Authorization: c.auth, dataset_id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'dataset_create',
    `Create a new dataset from logs. Provide start_time and end_time to sample from a log time range. You MUST provide sampling if the user requested a percentage. Use initial_log_filters to narrow which logs are included. For an empty dataset (no logs), set is_empty=true instead. To duplicate an existing dataset, pass source_dataset_id.`,
    {
      name: z.string().optional().describe('Dataset name. Required unless source_dataset_id is provided.'),
      description: z.string().optional().describe('Dataset description'),
      is_empty: z.boolean().optional().describe('Create empty dataset without importing logs.'),
      sampling: z
        .number()
        .optional()
        .describe("Percentage of matching logs to include (1-100). You MUST pass this when the user says a percentage like '5%', '10%', '20%'."),
      start_time: z.string().optional().describe('Start time (ISO 8601). Required when sampling logs.'),
      end_time: z.string().optional().describe('End time (ISO 8601). Required when sampling logs.'),
      initial_log_filters: z
        .record(z.object({
          operator: z.string().optional(),
          value: z.any().optional(),
        }))
        .optional()
        .describe('Filters keyed by field name. Format: { "field": { "operator": "<op>", "value": <val> } }. Operators: \'\' (exact), \'in\', \'not\', \'icontains\', \'startswith\', \'gt\', \'gte\', \'lt\', \'lte\', \'empty\', \'not_empty\'.'),
      source_dataset_id: z.string().optional().describe('Existing dataset ID to duplicate. Copies logs asynchronously.'),
    },
    async ({ name, description, is_empty, sampling, start_time, end_time, initial_log_filters, source_dataset_id }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.createDataset({
        Authorization: c.auth,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(is_empty !== undefined ? { is_empty } : {}),
        ...(sampling !== undefined ? { sampling } : {}),
        ...(start_time !== undefined ? { start_time } : {}),
        ...(end_time !== undefined ? { end_time } : {}),
        ...(initial_log_filters !== undefined ? { initial_log_filters } : {}),
        ...(source_dataset_id !== undefined ? { source_dataset_id } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'dataset_update',
    'Update a dataset.',
    {
      dataset_id: z.string().describe('Dataset ID'),
      name: z.string().optional().describe('New dataset name'),
      description: z.string().optional().describe('New description'),
    },
    async ({ dataset_id, name, description }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.updateDataset({
        Authorization: c.auth,
        dataset_id,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'dataset_logs_list',
    `List logs in a dataset with pagination and optional filtering. Filter Format: {"field": {"operator": "<op>", "value": <val>}}. Operators: '' (exact), 'in', 'not', 'icontains', 'startswith', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'. String fields: model, status, customer_identifier, provider_id, prompt_name. Numeric fields (support gte/lte/gt/lt): latency, cost, tokens_per_second, prompt_tokens, completion_tokens.`,
    {
      dataset_id: z.string().describe('Dataset ID'),
      page: z.number().optional().describe('Page number (default: 1)'),
      page_size: z.number().optional().describe('Page size (default: 10, max: 100)'),
      sort_by: z.string().optional().describe('Sort field (default: unique_id). Prefix with - for descending.'),
      include_fields: z.string().optional().describe('Comma-separated list of response fields to include.'),
      filters: z
        .record(z.object({
          operator: z.string().optional().describe('Filter operator (e.g. "eq", "icontains", "gt")'),
          value: z.any().optional().describe('Filter value'),
        }))
        .optional()
        .describe('Each key is a field name, value is {"operator": "<op>", "value": <val>}. Example: {"status_code": {"operator": "gte", "value": 400}}'),
    },
    async ({ dataset_id, page, page_size, sort_by, include_fields, filters }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.listDatasetLogs({
        Authorization: c.auth,
        dataset_id,
        ...(page ? { page } : {}),
        ...(page_size ? { page_size } : {}),
        ...(sort_by ? { sort_by } : {}),
        ...(include_fields ? { include_fields } : {}),
        ...(filters ? { filters } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'dataset_log_get',
    'Retrieve a specific log from a dataset by its unique ID.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      unique_id: z.string().describe('The unique identifier of the log to retrieve.'),
    },
    async ({ dataset_id, unique_id }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.retrieveDatasetLog({ Authorization: c.auth, dataset_id, unique_id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'dataset_logs_import',
    'Import existing logs into a dataset by time range and filters. Runs in the background.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      start_time: z.string().describe('Start time in ISO 8601 format.'),
      end_time: z.string().describe('End time in ISO 8601 format.'),
      filters: z
        .record(z.object({
          operator: z.string().optional(),
          value: z.any().optional(),
        }))
        .optional()
        .describe('Filters to select which logs to import. Example: { "model": { "operator": "", "value": "gpt-4o" } }'),
      sampling_percentage: z.number().optional().describe('Percent of matching logs to import (1-100).'),
    },
    async ({ dataset_id, start_time, end_time, filters, sampling_percentage }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.importDatasetLogs({
        Authorization: c.auth,
        dataset_id,
        start_time,
        end_time,
        ...(filters ? { filters } : {}),
        ...(sampling_percentage ? { sampling_percentage } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'dataset_delete',
    'Delete a dataset. DANGEROUS: You MUST ask the user to type out the exact dataset name they want to delete.',
    {
      dataset_id: z.string().describe('Dataset ID'),
      user_confirmation: z.string().describe('REQUIRED: The exact dataset name as typed by the user in chat.'),
    },
    async ({ dataset_id }) => {
      const c = requireClient(client);
      await c.client.datasets.deleteDataset({ Authorization: c.auth, dataset_id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, dataset_id }, null, 2) }],
      };
    },
  );

  server.tool(
    'dataset_log_update',
    'Replace (full overwrite) a log in a dataset. Updates input, output, expected_output, and/or metadata fields.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      unique_id: z.string().describe('The unique identifier of the log to replace.'),
      input: z.any().optional().describe('Input data for the log.'),
      output: z.any().optional().describe('Output data for the log.'),
      expected_output: z.any().optional().describe('Expected output for evaluation.'),
      prompt: z.string().optional().describe('Prompt text.'),
      completion: z.string().optional().describe('Completion text.'),
      metadata: z.record(z.any()).optional().describe('Metadata key-value pairs.'),
    },
    async ({ dataset_id, unique_id, input, output, expected_output, prompt, completion, metadata }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.replaceDatasetLog({
        Authorization: c.auth,
        dataset_id,
        unique_id,
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(expected_output !== undefined ? { expected_output } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(completion !== undefined ? { completion } : {}),
        ...(metadata ? { metadata } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'dataset_logs_delete',
    'Remove one or more logs from a dataset by filter. To delete a single log, pass filter { unique_id: { operator: "eq", value: "<log_id>" } }. Pass is_deleting_all_logs=true to wipe the dataset contents.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      is_deleting_all_logs: z.boolean().optional().describe('Set to true to remove every log in the dataset.'),
      filters: z
        .record(z.object({
          operator: z.string().optional().describe('Filter operator (e.g. "eq", "icontains", "gt")'),
          value: z.any().optional().describe('Filter value'),
        }))
        .optional()
        .describe('Filters keyed by field name. Example: { "status_code": { "operator": "eq", "value": 500 } }'),
    },
    async ({ dataset_id, is_deleting_all_logs, filters }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.removeDatasetLogs({
        Authorization: c.auth,
        dataset_id,
        ...(is_deleting_all_logs !== undefined ? { is_deleting_all_logs } : {}),
        ...(filters ? { filters } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'dataset_logs_summary',
    `Get summary statistics for dataset logs (count, cost, tokens, latency, scores). AUTHORITATIVE COUNT: 'number_of_requests' is a real COUNT over the whole dataset. Read it for 'how many logs are in this dataset' — never count the rows of a dataset_logs_list page, which is one page, not the dataset. Takes the same filters as dataset_logs_list, so it also answers narrowed counts such as how many logs failed.`,
    {
      dataset_id: z.string().describe('Dataset ID'),
      filters: z
        .record(z.object({
          operator: z.string().optional(),
          value: z.any().optional(),
        }))
        .optional()
        .describe(`Optional filters. Same format as dataset_logs_list: Format: {"field": {"operator": "<op>", "value": <val>}}. Operators: '' (exact), 'in', 'not', 'icontains', 'startswith', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'. Example: {"status": {"operator": "", "value": "failed"}}`),
    },
    async ({ dataset_id, filters }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.summarizeDatasetLogsFiltered({
        Authorization: c.auth,
        dataset_id,
        ...(filters ? { filters } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'dataset_logs_bulk_create',
    'Bulk create dataset logs from array of unified format data. Pass a single-item array to insert one log.',
    {
      dataset_id: z.string().describe('Dataset ID. Use "_saved_logs" for the virtual saved-logs collection.'),
      logs: z
        .array(
          z.object({
            input: z.any().optional().describe('Input data.'),
            output: z.any().optional().describe('Output data.'),
            expected_output: z.any().optional().describe('Expected output for evaluation.'),
            metadata: z.record(z.any()).optional().describe('Metadata key-value pairs.'),
            metrics: z.record(z.any()).optional().describe('Metrics (e.g. tokens, cost, latency).'),
          })
        )
        .describe('Array of log objects with input, output, metadata, metrics'),
    },
    async ({ dataset_id, logs }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.bulkCreateDatasetLogs({
        Authorization: c.auth,
        dataset_id,
        logs,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'dataset_eval_runs_list',
    'List evaluation run results for a dataset. Shows past eval runs with status and results.',
    {
      dataset_id: z.string().describe('The unique identifier of the dataset.'),
      page: z.number().optional().describe('Page number.'),
      page_size: z.number().optional().describe('Results per page (max 100).'),
    },
    async ({ dataset_id, page, page_size }) => {
      const c = requireClient(client);
      const data = await c.client.datasets.listDatasetEvalRuns({
        Authorization: c.auth,
        dataset_id,
        ...(page ? { page } : {}),
        ...(page_size ? { page_size } : {}),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}
