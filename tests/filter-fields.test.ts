import { describe, expect, it } from 'vitest';
import {
  VALIDATION_ERROR_CODE,
  filterGuardError,
  guardErrorResult,
  isSupportedFilterField,
  toBackendFilters,
  unsupportedFilterFields,
  type FilterFieldSpec,
} from '../lib/shared/filter-fields.js';

const SPEC: FilterFieldSpec = {
  tool: 'list_widgets',
  fields: ['model', 'cost', 'status_code'],
};

const SPEC_WITH_MAP: FilterFieldSpec = {
  ...SPEC,
  dynamicPrefixes: ['metadata__', 'scores__'],
};

describe('isSupportedFilterField', () => {
  it('accepts exact members of the closed set only', () => {
    expect(isSupportedFilterField('cost', SPEC)).toBe(true);
    expect(isSupportedFilterField('COST', SPEC)).toBe(false);
    expect(isSupportedFilterField('total_tokens', SPEC)).toBe(false);
  });

  it('rejects dynamic map keys unless a prefix is declared', () => {
    expect(isSupportedFilterField('metadata__tenant', SPEC)).toBe(false);
    expect(isSupportedFilterField('metadata__tenant', SPEC_WITH_MAP)).toBe(true);
    expect(isSupportedFilterField('scores__abc-123', SPEC_WITH_MAP)).toBe(true);
  });

  it('requires a non-empty key after a dynamic prefix', () => {
    expect(isSupportedFilterField('metadata__', SPEC_WITH_MAP)).toBe(false);
  });
});

describe('unsupportedFilterFields', () => {
  it('returns distinct offenders, sorted', () => {
    expect(unsupportedFilterFields(['model', 'foo', 'cost', 'bar', 'foo'], SPEC)).toEqual(['bar', 'foo']);
  });

  it('returns an empty list when everything is supported', () => {
    expect(unsupportedFilterFields(['model', 'cost'], SPEC)).toEqual([]);
    expect(unsupportedFilterFields([], SPEC)).toEqual([]);
  });
});

describe('filterGuardError', () => {
  it('returns null when every field is supported', () => {
    expect(filterGuardError(['cost', 'metadata__k'], SPEC_WITH_MAP)).toBeNull();
    expect(filterGuardError([], SPEC)).toBeNull();
  });

  it('returns a typed validation_error naming offenders and the supported set', () => {
    const error = filterGuardError(['metadata__x', 'cost'], SPEC);
    expect(error).not.toBeNull();
    expect(error!.status).toBe('error');
    expect(error!.error.code).toBe(VALIDATION_ERROR_CODE);
    expect(error!.error.unsupported_fields).toEqual(['metadata__x']);
    expect(error!.error.supported_fields).toEqual(['cost', 'model', 'status_code']);
    expect(error!.error.message).toContain('list_widgets has no filter dimension for: metadata__x.');
    expect(error!.error.message).toContain('silently ignore');
    expect(error!.error.message).toContain('Supported filter fields: cost, model, status_code.');
    expect(error!.error.message).not.toContain('Also ');
  });

  it('mentions dynamic prefixes and the spec hint when present', () => {
    const spec: FilterFieldSpec = {
      ...SPEC_WITH_MAP,
      hint: (unsupported) => `Did you mean metadata__${unsupported[0]}?`,
    };
    const error = filterGuardError(['tenant'], spec);
    expect(error!.error.message).toContain('Did you mean metadata__tenant?');
    expect(error!.error.message).toContain('Also metadata__<key>, scores__<key>.');
  });
});

describe('guardErrorResult', () => {
  it('renders the error as an isError tool result carrying the JSON body', () => {
    const error = filterGuardError(['nope'], SPEC)!;
    const result = guardErrorResult(error);
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0].text)).toEqual(error);
  });
});

describe('toBackendFilters', () => {
  it('returns undefined for no filters', () => {
    expect(toBackendFilters(undefined)).toBeUndefined();
    expect(toBackendFilters([])).toBeUndefined();
  });

  it('converts to the backend body shape and defaults the operator to exact match', () => {
    expect(
      toBackendFilters([
        { field: 'cost', operator: 'gt', value: [0.01] },
        { field: 'model', value: ['gpt-4o'] },
      ]),
    ).toEqual({
      cost: { operator: 'gt', value: [0.01] },
      model: { operator: '', value: ['gpt-4o'] },
    });
  });
});
