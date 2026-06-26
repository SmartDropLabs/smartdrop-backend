const crypto = require('crypto');
const axios = require('axios');
const logger = require('../logger');

const DEFAULT_TIMEOUT_MS = 10000;

function payloadBody(payload) {
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

function signPayload(secret, payload, timestamp = Date.now()) {
  const body = payloadBody(payload);
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

function buildSignatureHeaders(secret, payload, timestamp = Date.now()) {
  const signature = signPayload(secret, payload, timestamp);
  return {
    'Content-Type': 'application/json',
    'X-SmartDrop-Signature': `sha256=${signature}`,
    'X-SmartDrop-Timestamp': String(timestamp),
  };
}

function verifySignature(secret, payload, signatureHeader, timestamp) {
  if (!signatureHeader || !timestamp || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expected = Buffer.from(signPayload(secret, payload, timestamp), 'hex');
  const actual = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function sendSignedRequest(webhookUrl, secret, payload, options = {}) {
  const timestamp = options.timestamp || Date.now();
  const headers = buildSignatureHeaders(secret, payload, timestamp);
  const startedAt = Date.now();

  try {
    const response = await axios.post(webhookUrl, payload, {
      headers,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      duration_ms: Date.now() - startedAt,
    };
  } catch (err) {
    err.duration_ms = Date.now() - startedAt;
    throw err;
  }
}

async function deliver(webhookUrl, secret, payload) {
  try {
    const result = await sendSignedRequest(webhookUrl, secret, payload);
    if (result.ok) {
      logger.info('Webhook delivered', { alert_id: payload.alert_id, url: webhookUrl });
      return;
    }

    logger.warn('Webhook delivery failed', {
      alert_id: payload.alert_id,
      url: webhookUrl,
      status: result.status,
    });
  } catch (err) {
    logger.warn('Webhook delivery failed', {
      alert_id: payload.alert_id,
      url: webhookUrl,
      error: err.message,
    });
  }
}

module.exports = {
  buildSignatureHeaders,
  deliver,
  sendSignedRequest,
  signPayload,
  verifySignature,
};
