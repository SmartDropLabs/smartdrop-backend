'use strict';

/**
 * CDN caching headers middleware (#583, #584, #658).
 *
 * Sets CDN-specific cache headers (Surrogate-Control, CDN-Cache-Control)
 * and ensures response compression is properly configured for API responses.
 * 
 * Issue #658: Added CDN cache purge functionality for deployments.
 */

const logger = require('../logger');
const config = require('../config');

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

/**
 * Issue #658: Purge CDN cache on deploy to prevent serving stale assets.
 * Call this function during deployment/startup to clear CDN cache.
 */
async function purgeCDN() {
  const cdnPurgeUrl = config.cdn?.purgeUrl || process.env.CDN_PURGE_URL;
  const cdnApiKey = config.cdn?.apiKey || process.env.CDN_API_KEY;
  
  if (!cdnPurgeUrl) {
    logger.warn('[CDN] No CDN_PURGE_URL configured, skipping cache purge');
    return { success: false, reason: 'no_url_configured' };
  }

  try {
    logger.info('[CDN] Purging CDN cache on deploy', { url: cdnPurgeUrl });
    
    const headers = {
      'Content-Type': 'application/json',
    };
    
    if (cdnApiKey) {
      headers['Authorization'] = `Bearer ${cdnApiKey}`;
    }
    
    const response = await fetch(cdnPurgeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ purge: 'all' }),
    });

    if (!response.ok) {
      throw new Error(`CDN purge failed with status ${response.status}`);
    }

    logger.info('[CDN] Successfully purged CDN cache');
    return { success: true, timestamp: new Date().toISOString() };
  } catch (error) {
    logger.error('[CDN] Failed to purge CDN cache', { error: error.message });
    return { success: false, error: error.message };
  }
}

module.exports = {
  cdnCache,
  purgeCDN,
  CDN_CACHEABLE_ROUTES,
  NO_CDN_ROUTES,
};
