'use strict';

/**
 * Escapes user text for safe HTML output rendering at output boundaries (#459).
 *
 * Stored data is never mutated or HTML-escaped so that signatures, passwords,
 * Stellar public keys, and names with apostrophes (e.g. O'Connor) survive
 * intact into databases and downstream services without corruption.
 *
 * @param {string} str - Raw string to escape
 * @returns {string} HTML-escaped string
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  escapeHtml,
};
