import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedClient } from '../lib/shared/client.js';
import { registerLogTools } from '../lib/observe/logs.js';
import {
  isSupportedLogFilterField,
  logFilterGuardError,
  supportedLogFilterFields,
} from '../lib/observe/log-filters.js';

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
type ToolHandler = (args: any) => Promise<ToolResult>;

const NOW = new Date('2026-09-06T12:00:00.000Z');

function registerTools(spans: { listSpans?: any; getSpansSummary?: any } = {}) {
  const handlers = new Map<string, ToolHandler>();
  const descriptions = new Map<string, string>();
  const schemas = new Map<string, any>();
  const server = {
    tool: (name: string, description: string, schema: any, handler: ToolHandler) => {
      handlers.set(name, handler);
      descriptions.set(name, description);
      schemas.set(name, schema);
    },
  };
  const listSpans = spans.listSpans ?? vi.fn(async () => ({ results: [], count: 0 }));
  const getSpansSummary = spans.getSpansSummary ?? vi.fn(async () => ({ number_of_requests: 0 }));
  const client = {
    baseUrl: 'https://api.example',
    auth: 'Bearer jwt',
    client: { spans: { listSpans, getSpansSummary } },
  } as unknown as AuthenticatedClient;
  registerLogTools(server as never, client);
  return { handlers, descriptions, schemas, listSpans, getSpansSummary };
}

function parse(result: ToolResult) {
  return JSON.parse(result.content[0].text);
}

describe('log filter guard', () => {
  it('accepts the backend closed set, map prefixes and full-text keys', () => {
    for (const field of [
      'status', 'status_code', 'error_class', 'error_fingerprint', 'organization_key_id',
      'model', 'cost', 'latency', 'customer_identifier', 'metadata__agent_name',
      'scores__evaluator-1', 'system_text_vector', 'full_text', 'is_root_span',
    ]) {
      expect(isSupportedLogFilterField(field, 'list_logs'), field).toBe(true);
    }
  });

  it('rejects keys the backend silently drops', () => {
    for (const field of [
      'error_message', 'failed', 'organization_key_name', 'customer_email',
      'customer_name', 'organization_id', 'stream', 'temperature', 'max_tokens',
    ]) {
      expect(isSupportedLogFilterField(field, 'list_logs'), field).toBe(false);
    }
  });

  it('excludes score and annotation dimensions from the summary tool only', () => {
    expect(isSupportedLogFilterField('scores__eval', 'list_logs')).toBe(true);
    expect(isSupportedLogFilterField('positive_feedback', 'list_logs')).toBe(true);
    expect(isSupportedLogFilterField('scores__eval', 'get_spans_summary')).toBe(false);
    expect(isSupportedLogFilterField('positive_feedback', 'get_spans_summary')).toBe(false);
    expect(supportedLogFilterFields('get_spans_summary')).not.toContain('note');
    expect(supportedLogFilterFields('list_logs')).toContain('note');
  });

  it('returns null when every key is supported', () => {
    expect(logFilterGuardError(['model', 'metadata__x'], 'list_logs')).toBeNull();
  });

  it('names the offending keys, the supported set and a metadata hint', () => {
    const error = logFilterGuardError(['failed', 'error_message', 'failed'], 'list_logs');
    expect(error?.error.code).toBe('validation_error');
    expect(error?.error.unsupported_fields).toEqual(['error_message', 'failed']);
    expect(error?.error.message).toContain('error_message, failed');
    expect(error?.error.message).toContain("'metadata__error_message'");
    expect(error?.error.message).toContain('Supported filter fields:');
    expect(error?.error.supported_fields).toContain('status');
  });
});

describe('list_logs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('advertises only the backend closed set', () => {
    const { descriptions, schemas } = registerTools();
    const description = descriptions.get('list_logs')!;
    const fieldDescription: string = schemas.get('list_logs').filters._def.innerType.element.shape.field._def.description;
    // The closed set is the line after the "supported fields" heading.
    const advertised = description.split('FILTERS - supported fields')[1].split('\n')[1];
    const advertisedFields = advertised.split(',').map((f) => f.trim());
    const schemaFields = fieldDescription.split('rejected): ')[1].split('. ')[0].split(',').map((f) => f.trim());
    expect(advertisedFields).toEqual(supportedLogFilterFields('list_logs'));
    expect(schemaFields).toEqual(supportedLogFilterFields('list_logs'));
    for (const stale of [
      'error_message', 'failed', 'organization_key_name', 'customer_email',
      'customer_name', 'organization_id', 'stream', 'temperature', 'max_tokens',
    ]) {
      expect(advertisedFields, stale).not.toContain(stale);
    }
    for (const real of ['status_code', 'error_class', 'error_fingerprint', 'organization_key_id']) {
      expect(advertisedFields).toContain(real);
    }
    // Stale names survive only as "use X instead" guidance, never as a filter option.
    expect(description).toMatch(/no error_message \/ failed field/);
    expect(description).toMatch(/no organization_key_name field/);
    expect(description).toContain('-timestamp');
    expect(description).toMatch(/hex/i);
  });

  it('rejects unsupported root filter keys without calling the backend', async () => {
    const { handlers, listSpans } = registerTools();
    const result = await handlers.get('list_logs')!({
      filters: [
        { field: 'error_message', operator: 'icontains', value: ['timeout'] },
        { field: 'failed', operator: '', value: [true] },
        { field: 'model', operator: '', value: ['gpt-4'] },
      ],
    });
    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(payload.status).toBe('error');
    expect(payload.error.code).toBe('validation_error');
    expect(payload.error.unsupported_fields).toEqual(['error_message', 'failed']);
    expect(payload.error.message).toContain('list_logs has no filter dimension for: error_message, failed');
    expect(listSpans).not.toHaveBeenCalled();
  });

  it('forwards supported filters and defaults to -timestamp ordering', async () => {
    const { handlers, listSpans } = registerTools();
    const result = await handlers.get('list_logs')!({
      filters: [{ field: 'status', operator: '', value: ['failed'] }],
    });
    expect(result.isError).toBeUndefined();
    expect(listSpans).toHaveBeenCalledTimes(1);
    const request = listSpans.mock.calls[0][0];
    expect(request.sort_by).toBe('-timestamp');
    expect(request.filters).toEqual({ status: { operator: '', value: ['failed'] } });
    expect(request.start_time).toBe('2026-09-06T11:00:00.000Z');
    expect(parse(result)).not.toHaveProperty('start_time_clamped');
  });

  it('honours an explicit sort_by', async () => {
    const { handlers, listSpans } = registerTools();
    await handlers.get('list_logs')!({ sort_by: '-cost' });
    expect(listSpans.mock.calls[0][0].sort_by).toBe('-cost');
  });

  it('reports when start_time was clamped to the 7-day window', async () => {
    const { handlers, listSpans } = registerTools();
    const result = await handlers.get('list_logs')!({
      start_time: '2026-08-01T00:00:00.000Z',
    });
    const effective = '2026-08-30T12:00:00.000Z';
    expect(listSpans.mock.calls[0][0].start_time).toBe(effective);
    const payload = parse(result);
    expect(payload.start_time_clamped).toEqual({
      requested_start_time: '2026-08-01T00:00:00.000Z',
      effective_start_time: effective,
      message: expect.stringContaining('7 days'),
    });
    expect(payload.results).toEqual([]);
  });

  it('leaves a start_time inside the window untouched', async () => {
    const { handlers, listSpans } = registerTools();
    const result = await handlers.get('list_logs')!({
      start_time: '2026-09-05T00:00:00.000Z',
    });
    expect(listSpans.mock.calls[0][0].start_time).toBe('2026-09-05T00:00:00.000Z');
    expect(parse(result)).not.toHaveProperty('start_time_clamped');
  });
});

describe('get_spans_summary', () => {
  it('rejects unsupported root filter keys without calling the backend', async () => {
    const { handlers, getSpansSummary } = registerTools();
    const result = await handlers.get('get_spans_summary')!({
      start_time: '2026-09-01T00:00:00Z',
      end_time: '2026-09-06T00:00:00Z',
      filters: { failed: { operator: '', value: [true] } },
    });
    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(payload.error.code).toBe('validation_error');
    expect(payload.error.unsupported_fields).toEqual(['failed']);
    expect(getSpansSummary).not.toHaveBeenCalled();
  });

  it('rejects score filters with a redirect to list_logs', async () => {
    const { handlers, getSpansSummary } = registerTools();
    const result = await handlers.get('get_spans_summary')!({
      start_time: '2026-09-01T00:00:00Z',
      end_time: '2026-09-06T00:00:00Z',
      filters: { 'scores__eval-1': { operator: 'gte', value: [0.5] } },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.message).toContain('Use list_logs');
    expect(getSpansSummary).not.toHaveBeenCalled();
  });

  it('forwards supported filters', async () => {
    const { handlers, getSpansSummary } = registerTools();
    const result = await handlers.get('get_spans_summary')!({
      start_time: '2026-09-01T00:00:00Z',
      end_time: '2026-09-06T00:00:00Z',
      filters: { model: { operator: '', value: ['gpt-4o'] } },
    });
    expect(result.isError).toBeUndefined();
    expect(getSpansSummary).toHaveBeenCalledTimes(1);
    expect(getSpansSummary.mock.calls[0][0].filters).toEqual({ model: { operator: '', value: ['gpt-4o'] } });
  });
});
