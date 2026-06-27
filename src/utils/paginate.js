function parsePagination(query, { maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function paginateResponse(data, total, { page, limit }) {
  const total_pages = Math.ceil(total / limit);
  return {
    data,
    pagination: {
      page, limit, total, total_pages,
      has_next: page < total_pages,
      has_prev: page > 1,
    },
  };
}

module.exports = {
  parsePagination,
  paginateResponse
};