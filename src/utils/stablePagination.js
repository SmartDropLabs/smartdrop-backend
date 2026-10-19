'use strict';

/**
 * Stable pagination cursor utilities (#513).
 *
 * Offset-based pagination becomes unstable when rows are inserted or deleted
 * between page requests — causing missing or duplicate results. These
 * keyset-based cursors encode the last-seen sort key, so pagination is
 * stable regardless of concurrent mutations.
 *
 * Cursor format: base64(JSON({ k: sortKeyValue, id: rowId }))
 */

function encodeCursor(sortValue, rowId) {
  const payload = JSON.stringify({ k: sortValue, id: rowId });
  return Buffer.from(payload).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const payload = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(payload);
    if (parsed.k === undefined || parsed.id === undefined) return null;
    return { sortValue: parsed.k, rowId: parsed.id };
  } catch {
    return null;
  }
}

/**
 * Builds a Knex query with keyset pagination applied.
 *
 * @param {Object} query - Knex query builder
 * @param {Object} params
 * @param {string} params.sortColumn - Column to sort/paginate on (e.g. 'created_at')
 * @param {string} params.idColumn - Unique tiebreaker column (e.g. 'id')
 * @param {string} params.direction - 'asc' or 'desc'
 * @param {string|null} params.cursor - Previous page's cursor (null for first page)
 * @param {number} params.limit - Page size
 * @returns {Object} Query with WHERE and ORDER BY applied
 */
function applyCursor(query, { sortColumn, idColumn, direction = 'desc', cursor, limit }) {
  const isDesc = direction === 'desc';
  const operator = isDesc ? '<' : '>';

  query.orderBy(sortColumn, direction).orderBy(idColumn, direction);

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      // Keyset condition: (sortCol, idCol) > (sortValue, rowId)
      query.where((builder) => {
        builder.where(sortColumn, operator, decoded.sortValue).orWhere((inner) => {
          inner.where(sortColumn, '=', decoded.sortValue).where(idColumn, operator, decoded.rowId);
        });
      });
    }
  }

  if (limit) {
    query.limit(limit + 1); // Fetch one extra to detect hasMore
  }

  return query;
}

/**
 * Processes query results into a page response with cursors.
 *
 * @param {Array} rows - Raw query results (may contain limit+1 rows)
 * @param {Object} params
 * @param {string} params.sortColumn
 * @param {string} params.idColumn
 * @param {number} params.limit
 * @returns {{ items: Array, nextCursor: string|null, hasMore: boolean }}
 */
function buildPage(rows, { sortColumn, idColumn, limit }) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor(last[sortColumn], last[idColumn]);
  }

  return { items, nextCursor, hasMore };
}

module.exports = {
  encodeCursor,
  decodeCursor,
  applyCursor,
  buildPage,
};
