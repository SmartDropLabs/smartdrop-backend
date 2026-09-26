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

const PROBE_RETRY_ATTEMPTS = parseInt(process.env.WEBHOOK_PROBE_RETRY_ATTEMPTS, 10) || 2;
const PROBE_RETRY_DELAY_MS = parseInt(process.env.WEBHOOK_PROBE_RETRY_DELAY_MS, 10) || 250;

function isTransientProbeError(err) {
  // A response was received (even a 4xx/5xx) — that's a real answer from
  // the target, not a transient failure, so it's handled by the caller via
  // response.status and never reaches this function.
  const code = err?.code;
  return [
    'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNREFUSED',
    'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
  ].includes(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Issue #311: probeReachability previously gave up on the very first
// network-level failure of each method (e.g. a connection reset or DNS
// hiccup), even though such errors are frequently transient and a
// registration-time probe against a cold/just-deployed receiver is exactly
// the situation where a brief retry is most likely to flip an unreachable
// result into a reachable one. HTTP error responses (4xx/5xx) are not
// retried — they're a real answer, not a transient failure.
async function probeReachability(webhookUrl, options = {}) {
  const timeoutMs = options.timeoutMs || 3000;
  const retryAttempts = options.retryAttempts ?? PROBE_RETRY_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? PROBE_RETRY_DELAY_MS;
  const lastError = { message: 'No response received' };

  for (const method of ['head', 'get']) {
    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
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
        if (attempt < retryAttempts && isTransientProbeError(err)) {
          await sleep(retryDelayMs);
          continue;
        }
        break;
      }
    }
  }

  return { reachable: false, method: 'head', error: lastError.message };
}

async function deliver(webhookUrl, secret, payload) {
  const result = await sendSignedRequest(webhookUrl, secret, payload);
  if (result.ok) {
    logger.info('Webhook delivered', { alert_id: payload.alert_id, url: webhookUrl });
    return;
  }

  const error = new Error(`Webhook delivery failed with status ${result.status}`);
  error.statusCode = result.status;
  error.duration_ms = result.duration_ms;
  logger.warn('Webhook delivery failed', {
    alert_id: payload.alert_id,
    url: webhookUrl,
    status: result.status,
  });
  throw error;
}

module.exports = {
  buildSignatureHeaders,
  deliver,
  probeReachability,
  sendSignedRequest,
};
