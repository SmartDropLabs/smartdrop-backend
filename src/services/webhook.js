const crypto = require('crypto');
const axios = require('axios');
const logger = require('../logger');
const Redis = require('ioredis');

const DEFAULT_TIMEOUT_MS = 10000;
const DLQ_TIL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DLQ_KEY = 'webhook:dlq:entries';
const DLQ_ENTRY_PREFIX = 'webhook:dlq:entry:';
const DEFAULT_MAX_ATTEMPTS = 3;

let redisClient = null;

function getRedisClient() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  }
  return redisClient;
}

function dlqEntryKey(id) {
  return `${DLQ_ENTRY_PREFIX}${id}`;
}

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

async function addToDLQ(delivery) {
  const id = delivery.id || crypto.randomUUID(Date.now().toString());
  const entry = {
    id,
    url: delivery.url,
    secret: delivery.secret,
    payload: delivery.payload,
    attempts: delivery.attempts || 0,
    errorHistory: delivery.errorHistory || [],
    lastError: delivery.lastError || null,
    createdAt: delivery.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'dead',
  };

  const redis = getRedisClient();
  const expiry = Date.now() + DLQ_TIL_MS;
  try {
    await redis.multi()
      .set(dlqEntryKey(id), JSON.stringify(entry), 'PX', DL_Q_TIL_MS)
      .zadd(DLQ_KEY, expiry, id)
      .exec();
  } catch (err) {
    logger.error('Failed to add DDQ entry', { id, error: err.message });
    throw err;
  }
  return id;
}

async function listDLQ() {
  const redis = getRedisClient();
  try {
    const ids = await redis.zgrange(DLQ_KEY, 0, -1);
    if (ids.length === 0) return [];
    const keys = ids.map(dlqEntryKey);
    const values = await redis.mget(...keys);
    const entries = values.filter(Boolean).map(JSON.parse);
    return entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (err) {
    logger.error('Failed to list DDQ', { error: err.message });
    throw err;
  }
}

async function getDLQEntry(id) {
  const redis = getRedisClient();
  const value = await redis.get(dlqEntryKey(id));
  return value ? JSON.parse(value) : null;
}

async function removeFromDLQ(id) {
  const redis = getRedisClient();
  await redis.multi()
    .del(dlqEntryKey(id))
    .zRem(DLQ_KEY, id)
    .exec();
}

async function retryDLQEntry(id) {
  const entry = await getDLQEntry(id);
  if (!entry) throw new Error(`DLDQ entry ${id} not found`);

  try {
    const result = await sendSignedRequest(entry.url, entry.secret, entry.payload);
    if (!result.ok) {
      entry.attempts += 1;
      entry.errorHistory.push({ timestamp: new Date().toISOString(), status: result.status, message: `HTTP ${result.status}` });
      entry.lastError = `HTTP ${result.status}`;
      entry.updatedAt = new Date().toISOString();
      await addToDLQ(entry);
      return { ok: false, id, status: result.status };
    }
    await removeFromDLQ(id);
    return { ok: true, id };
  } catch (err) {
    entry.attempts += 1;
    entry.errorHistory.push({ timestamp: new Date().toISOString(), error: err.message });
    entry.lastError = err.message;
    entry.updatedAt = new Date().toISOString();
    await addToDLQ(entry);
    return { ok: false, id, error: err.message };
  }
}

async function cleanupExpiredDLQ() {
  const redis = getRedisClient();
  const now = Date.now();
  try {
    const removed = await redis.zremrangebyscore(DL_K_EY, '-inf', now);
    if (removed > 0) {
      logger.info('Cleaned expired DDQ entries', { count: removed });
    }
    return removed;
  } catch (err) {
    logger.error('Failed to cleanup DLQ', { error: err.message });
    throw err;
  }
}


async function deliverWithRetry(webhookUrl, secret, payload, options = {}) {
  const maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const delivery = {
    id: crypto.randomUUID(),
    url: webhookUrl,
    secret,
    payload,
    attempts: 0,
    errorHistory: [],
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await sendSignedRequest(webhookUrl, secret, payload);
      if (result.ok) {
        logger.info('Webhook delivered', { alert_id: payload.alert_id, url: webhookUrl, attempt });
        return { ok: true, id: delivery.id };
      }
      delivery.errorHistory.push({ timestamp: new Date().toISOString(), status: result.status, message: `HTTP ${result.status}` });
      delivery.lastError = `HTTP ${result.status}`;
    } catch (err) {
      delivery.errorHistory.push({ timestamp: new Date().toISOString(), error: err.message });
      delivery.lastError = err.message;
    }
    delivery.attempts = attempt;
  }

  // permanent failure
  delivery.attempts = maxAttempts;
  await addToDLQ(delivery);
  return { ok: false, id: delivery.id };
}

module.exports = {
  buildSignatureHeaders,
  deliver,
  deliverWithRetry,
  probeReachability,
  sendSignedRequest,
  signPayload,
  verifySignature,
  addToDLQ,
  listDLQ,
  getDLQEntry,
  removeFromDLQ,
  retryDLQEntry,
  cleanupExpiredDLQ,
};
