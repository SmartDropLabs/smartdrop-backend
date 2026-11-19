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
const MIN_SUPPORTED_VERSION = '1'; // Issue #657: Minimum supported version for deprecation warnings

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

function normalizeVersionValue(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim().replace(/^v/i, '');
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * Express middleware that negotiates the API version.
 *
 * Priority: Accept vendor media type > Accept-Version header > query ?version= > URL path > default.
 * Rejects requests for unsupported versions with 406 Not Acceptable.
 */
function negotiateVersion(req, res, next) {
  const acceptVersion = parseAcceptVersion(req.headers?.accept);
  const acceptVersionHeader = normalizeVersionValue(req.headers?.['accept-version']);
  const queryVersion = normalizeVersionValue(req.query?.version);
  const pathVersion = parsePathVersion(req.path || '/');
  const requested = acceptVersion || acceptVersionHeader || queryVersion || pathVersion;

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
  
  // Issue #657: Add deprecation warnings for old API versions
  const versionNum = parseInt(req.apiVersion, 10);
  const minVersionNum = parseInt(MIN_SUPPORTED_VERSION, 10);
  
  if (versionNum < minVersionNum) {
    res.setHeader('X-API-Deprecation', `Version ${req.apiVersion} is deprecated`);
    // Sunset date: 90 days from now
    const sunsetDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toUTCString();
    res.setHeader('Sunset', sunsetDate);
    res.setHeader('Link', '</api/v' + DEFAULT_VERSION + '>; rel="successor-version"');
  }
  
  next();
}

module.exports = {
  negotiateVersion,
  parseAcceptVersion,
  parsePathVersion,
  SUPPORTED_VERSIONS,
  DEFAULT_VERSION,
};
