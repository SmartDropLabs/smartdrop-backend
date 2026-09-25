const axios = require('axios');
const logger = require('../logger');
const { getRequestIdHeaders } = require('../middleware/requestId');
const signature = require('./webhookSignature');

const DEFAULT_TIMEOUT_MS = 10000;

// Issue #302: this module used to carry its own HMAC signing implementation
// (a plain `sha256(timestamp.body)` digest, no replay protection), separate
// from and inconsistent with `webhookSignature.js`'s nonce + replay-window
// scheme already used by webhookDispatcher.js for outbound event deliveries.
// Two different signature formats meant a webhook receiver had to handle
// two incompatible `X-SmartDrop-Signature` shapes depending on which code
// path sent the request, and the older one here had no replay protection.
// This module now delegates all signing to `webhookSignature.js` and keeps
// only the HTTP delivery mechanics (retries aren't handled here — see
// webhookDispatcher.js for the retrying delivery path).
function buildSignatureHeaders(secret, payload) {
  return {
    'Content-Type': 'application/json',
    'X-SmartDrop-Signature': signature.sign(secret, payload),
  };
}

async function sendSignedRequest(webhookUrl, secret, payload, options = {}) {
  const headers = {
    ...buildSignatureHeaders(secret, payload),
    ...getRequestIdHeaders(),
  };
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

async function probeReachability(webhookUrl, options = {}) {
  const timeoutMs = options.timeoutMs || 3000;
  const lastError = { message: 'No response received' };

  for (const method of ['head', 'get']) {
    try {
      const response = await axios[method](webhookUrl, {
        headers: getRequestIdHeaders(),
        timeout: timeoutMs,
        validateStatus: () => true,
      });

      if (response && response.status >= 200 && response.status < 400) {
        return { reachable: true, status: response.status, method };
      }
      if (response && response.status) {
        return { reachable: false, status: response.status, method, error: `Target responded with HTTP ${response.status}` };
      }
    } catch (err) {
      lastError.message = err?.message || 'Request failed';
    }
  }

  return { reachable: false, method: 'head', error: lastError.message };
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
  probeReachability,
  sendSignedRequest,
};
