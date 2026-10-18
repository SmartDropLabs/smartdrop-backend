'use strict';

const AppError = require('../errors/AppError');
const logger = require('../logger');
const config = require('../config');

/**
 * Exempt internal probes and health check endpoints that cluster agents
 * legitimately access over plain HTTP inside the private cluster network.
 */
function isExemptPath(path) {
  if (!path) return false;
  return (
    path === '/health' ||
    path.startsWith('/health/') ||
    path === '/metrics'
  );
}

/**
 * Determine the safe target hostname for HTTPS redirection.
 * Never blindly reflects untrusted Host headers to prevent Host Header Injection.
 */
function resolveRedirectHost(req, httpsConfig) {
  const primaryHost = httpsConfig.host;
  const allowedHosts = httpsConfig.allowedHosts || [];

  const rawHost = req.get('host') || '';
  const hostWithoutPort = rawHost.split(':')[0].toLowerCase();

  // If the host header is explicitly in the allowedHosts list, it is safe to use.
  if (allowedHosts.length > 0) {
    const isAllowed = allowedHosts.some((allowed) => {
      const allowedLower = allowed.toLowerCase();
      return allowedLower === rawHost.toLowerCase() || allowedLower === hostWithoutPort;
    });
    if (isAllowed) {
      return rawHost;
    }
  }

  // Fall back to configured primary host, or first allowed host, or a safe default.
  if (primaryHost) {
    return primaryHost;
  }

  if (allowedHosts.length > 0) {
    return allowedHosts[0];
  }

  // Default fallback if no host is configured
  return 'localhost';
}

/**
 * Build Strict-Transport-Security header value based on configuration.
 *
 * NOTE ON PRELOAD:
 * HSTS preload is strictly opt-in (`hstsPreload: true`). Submitting a domain
 * to the browser HSTS preload list (hstspreload.org) hardcodes HTTPS into all
 * major browsers. Removal is arduous and can take months, which risks breaking
 * services if HTTPS configuration is ever rolled back.
 */
function buildHstsHeader(httpsConfig) {
  const maxAge = httpsConfig.hstsMaxAge || 31536000;
  let header = `max-age=${maxAge}`;
  if (httpsConfig.hstsIncludeSubDomains) {
    header += '; includeSubDomains';
  }
  if (httpsConfig.hstsPreload) {
    header += '; preload';
  }
  return header;
}

/**
 * Middleware for HTTPS enforcement and HSTS header management (#468).
 */
function createHttpsEnforcementMiddleware(customConfig) {
  return function httpsEnforcementMiddleware(req, res, next) {
    const httpsConfig = customConfig || config.https || {};

    // 1. Loop Guard and Misconfiguration Warning
    // If a reverse proxy or CDN forwarded X-Forwarded-Proto: https, but Express
    // reports req.secure === false, the Express `trust proxy` setting is missing or
    // does not trust the proxy IP. This would cause an infinite redirect loop.
    if (req.get('x-forwarded-proto')?.toLowerCase() === 'https' && !req.secure) {
      logger.warn(
        'Potential HTTPS redirect loop detected: client provided X-Forwarded-Proto: https, ' +
        'but req.secure is false. Ensure Express "trust proxy" is properly configured for upstream proxies.',
        {
          ip: req.ip,
          path: req.originalUrl || req.url,
          remoteAddress: req.socket?.remoteAddress,
        }
      );
    }

    // 2. Strict-Transport-Security: Send ONLY on secure responses
    if (req.secure) {
      const hstsValue = buildHstsHeader(httpsConfig);
      res.setHeader('Strict-Transport-Security', hstsValue);
    }

    // 3. Check if HTTPS enforcement is disabled (e.g. local dev or edge SSL termination)
    if (!httpsConfig.enforce) {
      return next();
    }

    // 4. Secure requests pass through immediately
    if (req.secure) {
      return next();
    }

    // 5. Check exemptions for internal cluster probes (health & metrics)
    const requestPath = req.path || req.originalUrl?.split('?')[0] || '';
    if (isExemptPath(requestPath)) {
      return next();
    }

    // 6. State-changing requests over plain HTTP: Reject with 403 Forbidden
    // Safe methods (GET, HEAD, OPTIONS) can be safely redirected.
    // State-changing requests (POST, PUT, PATCH, DELETE) have ALREADY transmitted
    // sensitive payload/credentials over cleartext HTTP. Redirecting them silently
    // cannot remediate cleartext disclosure and may perpetuate insecure client habits.
    const isSafeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
    if (!isSafeMethod) {
      logger.warn('Rejected state-changing request over plain HTTP', {
        method: req.method,
        path: req.originalUrl || req.url,
        ip: req.ip,
      });
      return next(
        new AppError(
          'FORBIDDEN',
          'State-changing requests over plain HTTP are prohibited; HTTPS is required',
          403,
          {
            method: req.method,
            protocol: req.protocol,
            suggestion: 'Please re-issue the request over HTTPS',
          }
        )
      );
    }

    // 7. Safe methods over plain HTTP: 308 Permanent Redirect preserving method
    const targetHost = resolveRedirectHost(req, httpsConfig);
    const redirectUrl = `https://${targetHost}${req.originalUrl || req.url}`;

    logger.info('Redirecting plain HTTP request to HTTPS', {
      originalUrl: req.originalUrl || req.url,
      redirectUrl,
    });

    res.setHeader('Location', redirectUrl);
    return res.status(308).end();
  };
}

module.exports = {
  createHttpsEnforcementMiddleware,
  httpsEnforcementMiddleware: createHttpsEnforcementMiddleware(),
  isExemptPath,
  resolveRedirectHost,
  buildHstsHeader,
};
