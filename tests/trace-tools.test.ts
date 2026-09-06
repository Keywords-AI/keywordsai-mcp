import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  LIST_TRACES_DESCRIPTION,
  SPAN_LEVEL_FILTER_FIELDS,
  TRACE_CONTENT_FILTER_FIELDS,
  TRACE_FILTER_FIELDS,
  TRACE_FILTER_OPERATORS,
  TRACE_LEVEL_FILTER_FIELDS,
  TRACE_SORT_FIELDS,
  TRACE_SORT_OPTIONS,
  registerTraceTools,
  traceFilterSchema,
} from '../lib/observe/traces.js';
import { UnsupportedFilterFieldError } from '../lib/shared/filter-fields.js';
import type { AuthenticatedClient } from '../lib/shared/client.js';

type ToolHandler = (args: any) => Promise<any>;
interface RegisteredTool {
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: ToolHandler;
}

function captureTools(client: AuthenticatedClient | null): Record<string, RegisteredTool> {
  const tools: Record<string, RegisteredTool> = {};
  const server = {
    tool(name: string, description: string, schema: Record<string, z.ZodTypeAny>, handler: ToolHandler) {
      tools[name] = { description, schema, handler };
    },
  } as unknown as McpServer;
  registerTraceTools(server, client);
  return tools;
}

function fakeClient() {
  const listTraces = vi.fn(async () => ({ results: [], count: 0 }));
  const retrieveTrace = vi.fn(async () => ({ trace_unique_id: 't1', span_tree: [] }));
  const client = {
    client: { traces: { listTraces, retrieveTrace } },
    auth: 'Bearer test',
    baseUrl: 'https://example.invalid',
  } as unknown as AuthenticatedClient;
  return { client, listTraces, retrieveTrace };
}

/** Field names a description or schema text mentions, as `\bname\b` matches. */
function mentions(text: string, field: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${field}([^A-Za-z0-9_]|$)`).test(text);
}

describe('list_traces field constants', () => {
  it('is the union of the three groups with no duplicates', () => {
    expect(TRACE_FILTER_FIELDS).toEqual([
      ...TRACE_LEVEL_FILTER_FIELDS,
      ...SPAN_LEVEL_FILTER_FIELDS,
      ...TRACE_CONTENT_FILTER_FIELDS,
    ]);
    expect(new Set(TRACE_FILTER_FIELDS).size).toBe(TRACE_FILTER_FIELDS.length);
  });

  it('does not advertise fields the backend traces spec cannot resolve', () => {
    // allow_map_fields=False on TRACE_FIELD_SPEC; total_tokens is a sort alias only.
    for (const bad of ['total_tokens', 'metadata', 'metadata__foo', 'scores__foo', 'unique_organization_id']) {
      expect(TRACE_FILTER_FIELDS).not.toContain(bad);
    }
  });

  it('does not advertise operators outside the backend vocabulary', () => {
    expect(TRACE_FILTER_OPERATORS).not.toContain('iexact');
    expect(TRACE_FILTER_OPERATORS).toContain('');
  });

  it('derives sort options from the sort field list with - variants', () => {
    expect(TRACE_SORT_OPTIONS).toHaveLength(TRACE_SORT_FIELDS.length * 2);
    for (const field of TRACE_SORT_FIELDS) {
      expect(TRACE_SORT_OPTIONS).toContain(field);
      expect(TRACE_SORT_OPTIONS).toContain(`-${field}`);
    }
  });
});

describe('list_traces description and schema', () => {
  const tools = captureTools(null);
  const tool = tools.list_traces;

  it('registers list_traces with the exported description', () => {
    expect(tool).toBeDefined();
    expect(tool.description).toBe(LIST_TRACES_DESCRIPTION);
  });

  it('lists every supported field and no metadata__ claim in the description', () => {
    for (const field of TRACE_FILTER_FIELDS) {
      expect(mentions(tool.description, field), field).toBe(true);
    }
    expect(tool.description).not.toMatch(/use metadata__<key>/i);
    expect(tool.description).toMatch(/metadata__<key>\) is NOT filterable/);
    for (const op of TRACE_FILTER_OPERATORS) {
      expect(tool.description).toContain(JSON.stringify(op));
    }
    expect(tool.description).not.toContain('iexact');
  });

  it('describes the same field set on the zod field schema', () => {
    const fieldDescription = traceFilterSchema.shape.field.description ?? '';
    for (const field of TRACE_FILTER_FIELDS) {
      expect(mentions(fieldDescription, field), field).toBe(true);
    }
    expect(fieldDescription).not.toMatch(/use metadata__<key>/i);
  });

  it('constrains operator and sort_by to the exported constants', () => {
    const operatorEnum = traceFilterSchema.shape.operator as z.ZodEnum<[string, ...string[]]>;
    expect(operatorEnum.options).toEqual([...TRACE_FILTER_OPERATORS]);
    const sortEnum = tool.schema.sort_by.unwrap() as z.ZodEnum<[string, ...string[]]>;
    expect(sortEnum.options).toEqual(TRACE_SORT_OPTIONS);
  });
});

describe('list_traces handler guard', () => {
  it('rejects an unsupported field before calling the backend', async () => {
    const { client, listTraces } = fakeClient();
    const { list_traces } = captureTools(client);
    await expect(
      list_traces.handler({
        filters: [{ field: 'metadata__tenant', operator: '', value: ['acme'] }],
      }),
    ).rejects.toBeInstanceOf(UnsupportedFilterFieldError);
    await expect(
      list_traces.handler({
        filters: [{ field: 'total_tokens', operator: 'gt', value: [100] }],
      }),
    ).rejects.toThrow(/Supported fields: .*total_request_tokens/);
    expect(listTraces).not.toHaveBeenCalled();
  });

  it('forwards supported filters in the backend body shape', async () => {
    const { client, listTraces } = fakeClient();
    const { list_traces } = captureTools(client);
    await list_traces.handler({
      page_size: 50,
      filters: [
        { field: 'error_count', operator: 'gt', value: [0] },
        { field: 'span_workflow_name', value: ['checkout'] },
      ],
    });
    expect(listTraces).toHaveBeenCalledTimes(1);
    expect(listTraces.mock.calls[0][0]).toMatchObject({
      Authorization: 'Bearer test',
      page_size: 20,
      page: 1,
      sort_by: '-timestamp',
      filters: {
        error_count: { operator: 'gt', value: [0] },
        span_workflow_name: { operator: '', value: ['checkout'] },
      },
    });
  });

  it('omits the filters key when no filters are given', async () => {
    const { client, listTraces } = fakeClient();
    const { list_traces } = captureTools(client);
    await list_traces.handler({});
    expect(listTraces.mock.calls[0][0]).not.toHaveProperty('filters');
  });
});

describe('get_trace_tree', () => {
  it('only exposes trace_id and looks the trace up by id', async () => {
    const { client, retrieveTrace } = fakeClient();
    const { get_trace_tree } = captureTools(client);
    expect(Object.keys(get_trace_tree.schema)).toEqual(['trace_id']);
    await get_trace_tree.handler({ trace_id: 'abc' });
    expect(retrieveTrace).toHaveBeenCalledWith({ Authorization: 'Bearer test', trace_unique_id: 'abc' });
  });
});
