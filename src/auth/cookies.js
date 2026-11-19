'use strict';

// Issue #496 — Secure cookie helpers.
// No cookies are set anywhere in the codebase today. However, future
// authenticated UI/admin sessions must use these helpers so the flags are
// applied consistently:
//   - Secure: only over HTTPS (production). In dev/test HTTP is allowed but
//             still constrained by SameSite (and trust proxy affects req.secure).
//   - HttpOnly: prevents JS access to auth/session cookies.
//   - SameSite: 'Strict' by default to mitigate CSRF for same-site flows; use
//               'Lax' only when cross-site GET redirects are necessary.
//   - Path: scoped to '/'.
//   - Max-Age/Expires: set explicitly (no session cookies by default).
//
// The decision to *not* force Secure in non-prod is deliberate so local
// development over http://localhost works. Trust proxy must be configured
// (app.set('trust proxy', ...)) when running behind a reverse proxy/load
// balancer; without it, req.secure remains false even if the client connected
// via TLS to the proxy.

const config = require('../config');

const DEFAULT_SAME_SITE = 'Strict';
const DEFAULT_PATH = '/';

function isSecure(req) {
  // req.secure is true only if the request was made over HTTPS. If the app is
  // behind a proxy, trust proxy must be enabled for this to reflect the
  // original protocol.
  if (req && req.secure) return true;
  if (req && req.headers && req.headers['x-forwarded-proto']) {
    return String(req.headers['x-forwarded-proto']).toLowerCase() === 'https';
  }
  // Production default is to require Secure where possible; still, if no
  // indicator is present, fall back to config flag (dev/test).
  return config.nodeEnv === 'production';
}

function getCookieDomain(domain) {
  if (domain) return domain;
  return undefined;
}

function buildCookieOptions(options = {}) {
  const {
    req,
    maxAgeMs,
    expires,
    sameSite = DEFAULT_SAME_SITE,
    path = DEFAULT_PATH,
    domain,
    httpOnly = true,
    secure,
  } = options;

  const secureFlag = typeof secure === 'boolean' ? secure : isSecure(req);
  const opts = {
    httpOnly,
    secure: secureFlag,
    sameSite,
    path,
  };

  const resolvedDomain = getCookieDomain(domain);
  if (resolvedDomain) opts.domain = resolvedDomain;

  if (Number.isFinite(maxAgeMs)) {
    opts.maxAge = Math.trunc(maxAgeMs);
  }
  if (expires instanceof Date) {
    opts.expires = expires;
  }
  return opts;
}

function setCookie(res, name, value, options = {}) {
  if (!res || typeof res.cookie !== 'function') {
    throw new Error('res.cookie is not available');
  }
  const opts = buildCookieOptions(options);
  res.cookie(name, value, opts);
}

function clearCookie(res, name, options = {}) {
  if (!res || typeof res.clearCookie !== 'function') {
    throw new Error('res.clearCookie is not available');
  }
  const opts = buildCookieOptions({ ...options, maxAgeMs: 0, expires: new Date(0) });
  res.clearCookie(name, opts);
}

module.exports = {
  buildCookieOptions,
  setCookie,
  clearCookie,
  isSecure,
  DEFAULT_SAME_SITE,
  DEFAULT_PATH,
};
