'use strict';

const { z } = require('zod');
const {
  parsePagination,
  paginateResponse,
  paginationEnvelopeSchema,
} = require('../src/utils/pagination');

describe('pagination utilities', () => {
  test('uses defaults when query params are absent', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  test('clamps page=0 and limit=0 to valid values', () => {
    expect(parsePagination({ page: '0', limit: '0' })).toEqual({ page: 1, limit: 1, offset: 0 });
  });

  test('clamps overly large limits to maxLimit', () => {
    expect(parsePagination({ page: '2', limit: '9999' })).toEqual({ page: 2, limit: 100, offset: 100 });
  });

  test('floors non-integer values without throwing', () => {
    expect(parsePagination({ page: '3.7', limit: '7.9' })).toEqual({ page: 3, limit: 7, offset: 14 });
  });

  test('falls back for non-numeric values without throwing', () => {
    expect(parsePagination({ page: 'nope', limit: 'NaN' })).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  test('builds the standard list response envelope', () => {
    expect(paginateResponse(['a', 'b'], 45, { page: 2, limit: 20 })).toEqual({
      data: ['a', 'b'],
      pagination: {
        page: 2,
        limit: 20,
        total: 45,
        total_pages: 3,
        has_next: true,
        has_prev: true,
      },
    });
  });

  test('provides a Zod schema for list response envelopes', () => {
    const schema = paginationEnvelopeSchema(z.object({ id: z.string() }));
    expect(() => schema.parse(paginateResponse([{ id: 'alrt_1' }], 1, { page: 1, limit: 20 }))).not.toThrow();
  });
});
