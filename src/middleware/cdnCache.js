'use strict';

/**
 * CDN caching headers middleware (#583, #584).
 *
 * Sets CDN-specific cache headers (Surrogate-Control, CDN-Cache-Control)
 * and ensures response compression is properly configured for API responses.
 */

const CDN_CACHEABLE_ROUTES = [
  { pattern: /^\/api\/prices/, maxAge: 30 },
  { pattern: /^\/api\/airdrops\/?$/, maxAge: 60 },
  { pattern: /^\/api\/metrics/, maxAge: 15 },
  { pattern: /^\/health/, maxAge: 5 },
];

const NO_CDN_ROUTES = [
  /^\/api\/auth/,
  /^\/api\/keys/,
  /^\/api\/webhooks/,
  /^\/api\/admin/,
];

/**
 * Set CDN cache headers based on route.
 * Surrogate-Control is for CDN edge caching.
 * CDN-Cache-Control is a standard for CDN providers.
 */
function cdnCache(options = {}) {
  const { defaultMaxAge = 0 } = options;

  return (req, res, next) => {
    const path = req.path;

    // Never CDN-cache sensitive routes
    if (NO_CDN_ROUTES.some((p) => p.test(path))) {
      res.setHeader('Surrogate-Control', 'no-store');
      res.setHeader('CDN-Cache-Control', 'no-store');
      return next();
    }

    // Check if route is CDN-cacheable
    const cacheable = CDN_CACHEABLE_ROUTES.find((c) => c.pattern.test(path));
    if (cacheable) {
      res.setHeader('Surrogate-Control', `max-age=${cacheable.maxAge}`);
      res.setHeader('CDN-Cache-Control', `public, max-age=${cacheable.maxAge}`);
      res.setHeader('Vary', 'Accept-Encoding');
      return next();
    }

    // Default: private, no CDN caching
    res.setHeader('Surrogate-Control', `private, max-age=${defaultMaxAge}`);
    res.setHeader('CDN-Cache-Control', `private, max-age=${defaultMaxAge}`);
    next();
  };
}

module.exports = {
  cdnCache,
  CDN_CACHEABLE_ROUTES,
  NO_CDN_ROUTES,
};
