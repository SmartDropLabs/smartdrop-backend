const { z } = require('zod');

const paginationSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  total_pages: z.number(),
  has_next: z.boolean(),
  has_prev: z.boolean(),
});

const paginatedResponseSchema = z.object({
  data: z.array(z.any()),
  pagination: paginationSchema,
});

module.exports = {
  paginationSchema,
  paginatedResponseSchema,
};