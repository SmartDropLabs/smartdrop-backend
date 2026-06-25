const { z } = require('zod');

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_LIMIT = 100;

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function parsePagination(query = {}, { maxLimit = DEFAULT_MAX_LIMIT, defaultLimit = DEFAULT_LIMIT } = {}) {
  const safeMaxLimit = toPositiveInteger(maxLimit, DEFAULT_MAX_LIMIT);
  const safeDefaultLimit = Math.min(toPositiveInteger(defaultLimit, DEFAULT_LIMIT), safeMaxLimit);
  const page = toPositiveInteger(query.page, 1);
  const requestedLimit = toPositiveInteger(query.limit, safeDefaultLimit);
  const limit = Math.min(requestedLimit, safeMaxLimit);
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

function paginateResponse(data, total, { page, limit }) {
  const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
  const totalPages = limit > 0 ? Math.ceil(safeTotal / limit) : 0;

  return {
    data,
    pagination: {
      page,
      limit,
      total: safeTotal,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    },
  };
}

function paginationEnvelopeSchema(itemSchema = z.unknown()) {
  return z.object({
    data: z.array(itemSchema),
    pagination: z.object({
      page: z.number().int().min(1),
      limit: z.number().int().min(1),
      total: z.number().int().min(0),
      total_pages: z.number().int().min(0),
      has_next: z.boolean(),
      has_prev: z.boolean(),
    }),
  });
}

module.exports = {
  parsePagination,
  paginateResponse,
  paginationEnvelopeSchema,
};
