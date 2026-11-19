'use strict';

/**
 * Response streaming utilities (#490).
 *
 * Provides helpers for streaming large responses to avoid building
 * entire result sets in memory, preventing OOM and timeout issues.
 */

const logger = require('../logger');

/**
 * Stream query results as NDJSON (newline-delimited JSON).
 * Each row is written as it's fetched from the database cursor.
 *
 * @param {Object} options
 * @param {import('express').Response} options.res - Express response
 * @param {import('knex').Knex} options.db - Database instance
 * @param {string} options.table - Table name
 * @param {Object} [options.where] - Filter conditions
 * @param {number} [options.batchSize=100] - Rows per batch
 * @param {Function} [options.transform] - Optional row transform
 * @param {string} [options.filename] - Content-Disposition filename
 */
async function streamNdjson({ res, db, table, where, batchSize = 100, transform, filename }) {
  res.setHeader('Content-Type', 'application/x-ndjson');
  if (filename) {
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }

  let cursor;
  let count = 0;

  try {
    do {
      const query = db(table).select('*').limit(batchSize).orderBy('id');
      if (where) query.where(where);
      if (cursor) query.where('id', '>', cursor);

      const rows = await query;
      for (const row of rows) {
        const data = transform ? transform(row) : row;
        res.write(JSON.stringify(data) + '\n');
        count++;
      }

      cursor = rows.length === batchSize ? rows[rows.length - 1].id : undefined;
    } while (cursor);

    res.end();
    logger.info(`Streamed ${count} rows from ${table}`);
  } catch (err) {
    logger.error(`Streaming error for ${table}: ${err}`);
    if (!res.headersSent) {
      res.status(500).json({ statusCode: 500, message: 'Streaming failed' });
    } else {
      res.end();
    }
  }
}

/**
 * Stream query results as CSV.
 *
 * @param {Object} options
 * @param {import('express').Response} options.res - Express response
 * @param {import('knex').Knex} options.db - Database instance
 * @param {string} options.table - Table name
 * @param {string[]} options.columns - CSV columns
 * @param {Object} [options.where] - Filter conditions
 * @param {number} [options.batchSize=100] - Rows per batch
 * @param {string} [options.filename] - Content-Disposition filename
 */
async function streamCsv({ res, db, table, columns, where, batchSize = 100, filename }) {
  res.setHeader('Content-Type', 'text/csv');
  if (filename) {
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }

  // Write header
  res.write(columns.join(',') + '\n');

  let cursor;
  let count = 0;

  try {
    do {
      const query = db(table).select(columns).limit(batchSize).orderBy('id');
      if (where) query.where(where);
      if (cursor) query.where('id', '>', cursor);

      const rows = await query;
      for (const row of rows) {
        const values = columns.map((col) => {
          const val = row[col];
          if (val == null) return '';
          const str = String(val);
          return str.includes(',') || str.includes('"') || str.includes('\n')
            ? `"${str.replace(/"/g, '""')}"`
            : str;
        });
        res.write(values.join(',') + '\n');
        count++;
      }

      cursor = rows.length === batchSize ? rows[rows.length - 1].id : undefined;
    } while (cursor);

    res.end();
    logger.info(`Streamed ${count} rows as CSV from ${table}`);
  } catch (err) {
    logger.error(`CSV streaming error for ${table}: ${err}`);
    if (!res.headersSent) {
      res.status(500).json({ statusCode: 500, message: 'Streaming failed' });
    } else {
      res.end();
    }
  }
}

module.exports = {
  streamNdjson,
  streamCsv,
};
