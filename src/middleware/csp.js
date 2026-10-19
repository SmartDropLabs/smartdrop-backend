'use strict';

/**
 * Content-Security-Policy for API responses.
 *
 * The API returns JSON, never HTML, so it needs no script, style, image, or
 * network permissions at all. Denying everything by default removes the
 * browser-side attack surface entirely instead of relying on the permissive
 * defaults that make sense for an HTML application.
 */
const API_CSP_DIRECTIVES = {
  'default-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
  'object-src': ["'none'"],
};

/**
 * Content-Security-Policy override for the Swagger UI docs route (/api-docs).
 *
 * helmet() applies the strict API policy to every response, but
 * swagger-ui-express renders by injecting inline <script>/<style> tags and
 * data:-URL assets that the API policy blocks, leaving a broken docs page.
 * This middleware relaxes the policy *only* for the docs route (mounted
 * immediately before the apiDocs router) by overwriting the header helmet
 * set. It is scoped to /api-docs so the strict policy still protects the
 * real API surface.
 */
const DOCS_CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function docsCspMiddleware(_req, res, next) {
  res.setHeader('Content-Security-Policy', DOCS_CSP_DIRECTIVES);
  next();
}

module.exports = {
  API_CSP_DIRECTIVES,
  DOCS_CSP_DIRECTIVES,
  docsCspMiddleware,
};
