'use strict';

/**
 * API version negotiation middleware (issue #562).
 *
 * Negotiates the API version from the `Accept` header using the
 * `application/vnd.smartdrop.v<N>+json` media type pattern, falling back
 * to the URL path version. Sets `req.apiVersion` so route handlers can
 * branch on the negotiated version.
 *
 * Supported versions are declared in SUPPORTED_VERSIONS; the default is
 * the highest available version when the client sends no signal.
 */

const SUPPORTED_VERSIONS = ['1'];
const DEFAULT_VERSION = SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1];
const VENDOR_PREFIX = 'application/vnd.smartdrop.v';

/**
 * Extract the version number from an Accept header value.
 * Matches: application/vnd.smartdrop.v1+json
 * @param {string} acceptHeader
 * @returns {string|null} Version string or null
 */
function parseAcceptVersion(acceptHeader) {
  if (!acceptHeader) return null;
  const match = acceptHeader.match(/application\/vnd\.smartdrop\.v(\d+)\+json/i);
  return match ? match[1] : null;
}

/**
 * Extract the version number from the URL path.
 * Matches: /v1/... or /api/v1/...
 * @param {string} path
 * @returns {string|null} Version string or null
 */
function parsePathVersion(path) {
  const match = path.match(/^\/(?:api\/)?v(\d+)(?:\/|$)/i);
  return match ? match[1] : null;
}

/**
 * Express middleware that negotiates the API version.
 *
 * Priority: Accept header > URL path > default.
 * Rejects requests for unsupported versions with 406 Not Acceptable.
 */
function negotiateVersion(req, res, next) {
  const acceptVersion = parseAcceptVersion(req.headers.accept);
  const pathVersion = parsePathVersion(req.path);
  const requested = acceptVersion || pathVersion;

  if (requested && !SUPPORTED_VERSIONS.includes(requested)) {
    return res.status(406).json({
      error: {
        code: 'NOT_ACCEPTABLE',
        message: `API version '${requested}' is not supported. Supported versions: ${SUPPORTED_VERSIONS.map((v) => 'v' + v).join(', ')}`,
        supported_versions: SUPPORTED_VERSIONS.map((v) => 'v' + v),
      },
    });
  }

  req.apiVersion = requested || DEFAULT_VERSION;
  res.setHeader('X-API-Version', `v${req.apiVersion}`);
  next();
}

module.exports = {
  negotiateVersion,
  parseAcceptVersion,
  parsePathVersion,
  SUPPORTED_VERSIONS,
  DEFAULT_VERSION,
};
