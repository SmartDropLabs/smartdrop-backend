const AppError = require("../errors/AppError");

/**
 * CSRF defense-in-depth for state-changing webhook endpoints (#320).
 *
 * `buildCorsMiddleware` already rejects cross-origin requests whose Origin
 * header doesn't match `corsAllowedOrigins` — but it treats a request with
 * NO Origin header as automatically allowed (`if (!origin || ...)`), and a
 * plain HTML `<form>` submission can omit Origin in some conditions and
 * carries no JSON body / custom headers at all. Requiring this header
 * closes that gap: a real browser CSRF (no attacker-controlled JS, just a
 * form or an <img>/<a> tag) can never set a custom header, so a request
 * missing it is never a cross-site form submission — regardless of what
 * Origin/Referer it did or didn't send.
 *
 * This does not replace `requireApiKey` — a stolen API key still lets an
 * attacker call the API directly. It specifically closes the "victim's
 * authenticated browser session becomes an unwitting proxy" vector the
 * issue describes.
 */
function requireCsrfHeader(req, res, next) {
  if (!req.get("x-requested-with")) {
    return next(
      new AppError(
        "CSRF_HEADER_REQUIRED",
        "Missing required X-Requested-With header",
        403,
      ),
    );
  }
  next();
}

module.exports = { requireCsrfHeader };
