const axios = require('axios');
const logger = require('../logger');
const signature = require('./webhookSignature');

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Headers for an alert delivery.
 *
 * The signing scheme itself lives entirely in `webhookSignature` — this used
 * to carry a second, subtly different HMAC implementation, which is how the
 * alert path and the dispatcher path drifted apart in the first place (#97).
 */
function buildSignatureHeaders(secret, payload, timestamp = Date.now()) {
  return {
    'Content-Type': 'application/json',
    ...signature.signatureHeaders(secret, payload, timestamp),
  };
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

async function probeReachability(webhookUrl, options = {}) {
  const timeoutMs = options.timeoutMs || 3000;
  const lastError = { message: 'No response received' };

  for (const method of ['head', 'get']) {
    try {
      const response = await axios[method](webhookUrl, {
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
