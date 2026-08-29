'use strict';

/**
 * Content-Security-Policy override for the Swagger UI docs route (/api-docs).
 *
 * helmet() applies a strict default CSP to every response (good for the API),
 * but swagger-ui-express renders by injecting inline <script>/<style> tags and
 * data:-URL assets that the default CSP blocks, leaving a broken docs page in
 * development. This middleware relaxes the CSP *only* for the docs route
 * (mounted immediately before the apiDocs router) by overwriting the header
 * helmet set. It is scoped to /api-docs so the strict default still protects
 * the real API surface. See #129.
 */
const DOCS_CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

function docsCspMiddleware(_req, res, next) {
  res.setHeader('Content-Security-Policy', DOCS_CSP_DIRECTIVES);
  next();
}

module.exports = { docsCspMiddleware, DOCS_CSP_DIRECTIVES };
