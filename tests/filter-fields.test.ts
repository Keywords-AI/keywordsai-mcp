import { describe, expect, it } from 'vitest';
import {
  UnsupportedFilterFieldError,
  assertSupportedFilterFields,
  isSupportedFilterField,
  toBackendFilters,
  unsupportedFilterFields,
  type FilterFieldSpec,
} from '../lib/shared/filter-fields.js';

const SPEC: FilterFieldSpec = {
  tool: 'list_widgets',
  fields: ['cost', 'model', 'status_code'],
};

const SPEC_WITH_MAP: FilterFieldSpec = {
  ...SPEC,
  dynamicPrefixes: ['metadata__', 'scores__'],
};

describe('isSupportedFilterField', () => {
  it('accepts exact members of the closed set', () => {
    expect(isSupportedFilterField('cost', SPEC)).toBe(true);
    expect(isSupportedFilterField('COST', SPEC)).toBe(false);
    expect(isSupportedFilterField('total_tokens', SPEC)).toBe(false);
  });

  it('rejects dynamic map fields unless a prefix is declared', () => {
    expect(isSupportedFilterField('metadata__tenant', SPEC)).toBe(false);
    expect(isSupportedFilterField('metadata__tenant', SPEC_WITH_MAP)).toBe(true);
    expect(isSupportedFilterField('scores__abc-123', SPEC_WITH_MAP)).toBe(true);
  });

  it('requires a non-empty key after a dynamic prefix', () => {
    expect(isSupportedFilterField('metadata__', SPEC_WITH_MAP)).toBe(false);
  });
});

describe('unsupportedFilterFields', () => {
  it('returns distinct offenders in first-seen order', () => {
    expect(
      unsupportedFilterFields(['model', 'foo', 'cost', 'bar', 'foo'], SPEC),
    ).toEqual(['foo', 'bar']);
  });

  it('returns an empty list when everything is supported', () => {
    expect(unsupportedFilterFields(['model', 'cost'], SPEC)).toEqual([]);
    expect(unsupportedFilterFields([], SPEC)).toEqual([]);
  });
});

describe('assertSupportedFilterFields', () => {
  it('throws a typed error listing the supported fields', () => {
    let caught: unknown;
    try {
      assertSupportedFilterFields(['metadata__x', 'cost'], SPEC);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedFilterFieldError);
    const error = caught as UnsupportedFilterFieldError;
    expect(error.code).toBe('unsupported_filter_field');
    expect(error.tool).toBe('list_widgets');
    expect(error.unsupportedFields).toEqual(['metadata__x']);
    expect(error.supportedFields).toEqual(['cost', 'model', 'status_code']);
    expect(error.message).toContain('list_widgets: unsupported filter field(s): metadata__x.');
    expect(error.message).toContain('Supported fields: cost, model, status_code.');
    expect(error.message).not.toContain('Dynamic fields');
  });

  it('mentions dynamic prefixes when the spec declares them', () => {
    expect(() => assertSupportedFilterFields(['nope'], SPEC_WITH_MAP)).toThrow(
      /Dynamic fields: metadata__<key>, scores__<key>\./,
    );
  });

  it('does not throw for supported fields', () => {
    expect(() => assertSupportedFilterFields(['cost', 'metadata__k'], SPEC_WITH_MAP)).not.toThrow();
  });
});

describe('toBackendFilters', () => {
  it('returns undefined for no filters', () => {
    expect(toBackendFilters(undefined, SPEC)).toBeUndefined();
    expect(toBackendFilters([], SPEC)).toBeUndefined();
  });

  it('converts to the backend body shape and defaults the operator to exact match', () => {
    expect(
      toBackendFilters(
        [
          { field: 'cost', operator: 'gt', value: [0.01] },
          { field: 'model', value: ['gpt-4o'] },
        ],
        SPEC,
      ),
    ).toEqual({
      cost: { operator: 'gt', value: [0.01] },
      model: { operator: '', value: ['gpt-4o'] },
    });
  });

  it('rejects the whole payload when any field is unsupported', () => {
    expect(() =>
      toBackendFilters(
        [
          { field: 'cost', operator: 'gt', value: [0] },
          { field: 'total_tokens', operator: 'gt', value: [0] },
        ],
        SPEC,
      ),
    ).toThrow(UnsupportedFilterFieldError);
  });
});
