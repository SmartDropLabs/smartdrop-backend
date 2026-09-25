'use strict';

/**
 * Resolve the client IP of a request.
 *
 * Behind a reverse proxy / load balancer `req.socket.remoteAddress` is the
 * proxy, so the left-most `x-forwarded-for` hop wins when the header is
 * present. Same rule the rest of the codebase uses (middleware/auth.js,
 * ws/PriceSubscriptionManager) — this module is the single implementation of it.
 */
function getClientIp(req) {
  const forwardedFor = req?.headers?.['x-forwarded-for'];

  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    const first = String(forwardedFor[0]).split(',')[0].trim();
    if (first) return first;
  } else if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    const first = forwardedFor.split(',')[0].trim();
    if (first) return first;
  }

  const socket = req?.socket || req?.connection;
  return socket?.remoteAddress || 'unknown';
}

module.exports = { getClientIp };
