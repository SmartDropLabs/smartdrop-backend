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
 * Expects an `X-Webhook-Timestamp` (or legacy `X-Request-Timestamp`) header
 * and a `X-Webhook-Signature` header in the format `sha256=<hex digest>`.
 * The signature covers `<timestamp>.<raw request body>` so a valid signature
 * cannot be replayed by replacing its timestamp.
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

  const timestampHeader = req.headers['x-webhook-timestamp'] || req.headers['x-request-timestamp'];
  if (typeof timestampHeader !== 'string') {
    return sendError(res, 401, 'WEBHOOK_TIMESTAMP_MISSING', 'X-Webhook-Timestamp header is required.');
  }

  if (!/^\d{1,13}$/.test(timestampHeader)) {
    return sendError(res, 401, 'WEBHOOK_SIGNATURE_EXPIRED', 'Webhook timestamp is invalid.');
  }

  const timestamp = Number(timestampHeader);
  const timestampSeconds = timestamp > 1e11 ? Math.floor(timestamp / 1000) : timestamp;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || Math.abs(now - timestampSeconds) > 300) {
    return sendError(res, 401, 'WEBHOOK_SIGNATURE_EXPIRED', 'Webhook timestamp expired or outside 5-minute tolerance window.');
  }

  const expectedSignature =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(`${timestampHeader}.`).update(rawBody).digest('hex');

  // Constant-time comparison to prevent timing attacks.
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return sendError(res, 401, 'WEBHOOK_SIGNATURE_INVALID', 'Signature verification failed.');
  }

  next();
}

module.exports = { webhookSignatureMiddleware };
