'use strict';

/**
 * Cache-Control response headers middleware (#525).
 *
 * Sets appropriate Cache-Control headers on API responses to enable
 * client caching where safe and prevent caching of sensitive data.
 */

const CACHEABLE_PATHS = [
  { pattern: /^\/api\/prices/, maxAge: 30, public: true },
  { pattern: /^\/api\/airdrops\/?$/, maxAge: 60, public: true },
  { pattern: /^\/api\/metrics/, maxAge: 10, public: true },
  { pattern: /^\/health/, maxAge: 5, public: true },
];

const NO_CACHE_PATHS = [
  /^\/api\/auth/,
  /^\/api\/keys/,
  /^\/api\/webhooks/,
];

/**
 * Set Cache-Control headers based on the request path.
 */
function cacheControl(options = {}) {
  const { defaultMaxAge = 0 } = options;

  return (req, res, next) => {
    const path = req.path;

    // Never cache auth/keys/webhooks responses
    if (NO_CACHE_PATHS.some((p) => p.test(path))) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return next();
    }

    // Check if path is cacheable
    const cacheable = CACHEABLE_PATHS.find((c) => c.pattern.test(path));
    if (cacheable) {
      const directive = cacheable.public ? 'public' : 'private';
      res.setHeader(
        'Cache-Control',
        `${directive}, max-age=${cacheable.maxAge}, stale-while-revalidate=${Math.floor(cacheable.maxAge / 2)}`,
      );
      return next();
    }

    // Default: no caching for API responses
    res.setHeader('Cache-Control', `private, max-age=${defaultMaxAge}`);
    next();
  };
}

module.exports = {
  cacheControl,
  CACHEABLE_PATHS,
  NO_CACHE_PATHS,
};
