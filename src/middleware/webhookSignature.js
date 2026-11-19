'use strict';

const crypto = require('crypto');
const config = require('../config');
const { sendError } = require('./errorHandler');

/**
 * WebhookSignatureMiddleware (#474)
 *
 * Validates incoming webhook signatures to prevent forged webhooks.
 * Uses HMAC-SHA256 with the configured webhook secret.
 *
 * Expects the signature in the `X-Webhook-Signature` header in the format
 * `sha256=<hex digest>`. The signature is computed over the raw request body.
 */
function webhookSignatureMiddleware(req, res, next) {
  const signature = req.headers['x-webhook-signature'];
  const secret = config.webhooks?.signatureSecret;

  if (!secret) {
    // If no secret is configured, reject incoming webhooks to fail closed.
    return sendError(res, 403, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature validation is not configured.');
  }

  if (!signature) {
    return sendError(res, 401, 'WEBHOOK_SIGNATURE_MISSING', 'X-Webhook-Signature header is required.');
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    return sendError(res, 400, 'WEBHOOK_RAW_BODY_MISSING', 'Raw body is required for signature verification.');
  }

  // Validate timestamp if provided to prevent replay attacks (#639)
  const timestampHeader = req.headers['x-webhook-timestamp'] || req.headers['x-request-timestamp'];
  if (timestampHeader) {
    const ts = Number(timestampHeader);
    const now = Math.floor(Date.now() / 1000);
    const tsSec = ts > 1e11 ? Math.floor(ts / 1000) : ts;
    if (isNaN(tsSec) || Math.abs(now - tsSec) > 300) {
      return sendError(res, 401, 'WEBHOOK_SIGNATURE_EXPIRED', 'Webhook timestamp expired or outside 5-minute tolerance window.');
    }
  }

  const expectedSignature =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  // Constant-time comparison to prevent timing attacks.
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return sendError(res, 401, 'WEBHOOK_SIGNATURE_INVALID', 'Signature verification failed.');
  }

  next();
}

module.exports = { webhookSignatureMiddleware };
