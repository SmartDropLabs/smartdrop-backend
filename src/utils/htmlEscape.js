'use strict';

/**
 * Output encoding for HTML context (Issue #499).
 *
 * Encodes special HTML characters to prevent XSS whenever untrusted data
 * is rendered in an HTML document, error page, or template.
 *
 * @param {string|*} str - Value to escape
 * @returns {string} HTML-escaped string
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Helper to render a safe HTML error page without echoing raw user input.
 *
 * @param {Object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {number} [options.statusCode=500]
 * @returns {string} Safe HTML string
 */
function renderSafeErrorHtml({ title = 'Error', message = 'An error occurred', statusCode = 500 }) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeCode = escapeHtml(statusCode);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${safeTitle}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; color: #333; max-width: 600px; margin: 0 auto; }
    h1 { color: #d32f2f; }
    p { font-size: 1.1rem; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>${safeCode} — ${safeTitle}</h1>
  <p>${safeMessage}</p>
</body>
</html>`;
}

module.exports = {
  escapeHtml,
  renderSafeErrorHtml,
};
