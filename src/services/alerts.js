const crypto = require('crypto');
const cache = require('./cache');
const webhook = require('./webhook');
const logger = require('../logger');

const IDS_KEY = 'alerts:ids';
const COOLDOWN_MS = 5 * 60 * 1000;
const DEDUP_WINDOW_SECONDS = 300;

// Escalation (issue #689): an alert that is still unacknowledged this long
// after creation is escalated once via its webhook. Default 15 minutes;
// override with ALERT_ESCALATION_TIMEOUT_MS.
const ESCALATION_TIMEOUT_MS = parseInt(process.env.ALERT_ESCALATION_TIMEOUT_MS, 10) || 15 * 60 * 1000;
// Short-lived lock so concurrent evaluators (multiple instances, overlapping
// passes) cannot both deliver the escalation for the same alert.
const ESCALATION_LOCK_TTL_SECONDS = 60;

function getAlertDedupKey(alert) {
  const resource = alert.resource || alert.asset || alert.id;
  return `alert:dedup:${alert.type}:${resource}`;
}

async function isDuplicateAlert(alert) {
  const key = getAlertDedupKey(alert);
  try {
    const existing = await cache.get(key);
    if (existing) return true;
    await cache.set(key, { id: alert.id, type: alert.type, at: Date.now() }, DEDUP_WINDOW_SECONDS);
  } catch (err) {
    // Ignore cache retrieval/storage failure so alerts aren't blocked
  }
  return false;
}
// Ceiling on one asset's alert evaluation pass (issue #315). evaluateForAsset
// makes several Redis round trips per alert with no timeout of its own, so a
// slow/hanging Redis instance could otherwise block the evaluation loop
// (and evaluateAll's iteration over every watched asset) indefinitely.
const ALERT_EVAL_TIMEOUT_MS = parseInt(process.env.ALERT_EVAL_TIMEOUT_MS, 10) || 10000;

function alertKey(id) {
  return `alert:${id}`;
}

// Secondary index (issue #310): evaluateForAsset only ever needs the alerts
// for one asset, but used to ZREVRANGE the *entire* IDS_KEY sorted set and
// fetch + filter every alert in the system on every price tick, regardless
// of how many assets it actually watches. Kept in sync with IDS_KEY by
// create()/remove() so evaluateForAssetInner can look up just this asset's
// ids directly instead of scanning everything.
function assetIdsKey(asset) {
  return `alerts:asset:${asset.toUpperCase()}`;
}

function generateId() {
  return `alrt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function isTriggered(alert, priceUsd) {
  if (alert.type === 'above') return priceUsd > alert.threshold_usd;
  if (alert.type === 'below') return priceUsd < alert.threshold_usd;
  if (alert.type === 'change_pct') {
    if (alert.baseline_price === null) return false;
    const pct = Math.abs((priceUsd - alert.baseline_price) / alert.baseline_price) * 100;
    return pct >= alert.threshold_usd;
  }
  return false;
}

async function create(data) {
  const { asset, type, threshold_usd, webhook_url, webhook_secret, repeat, owner_ip } = data;

  const id = generateId();

  let baselinePrice = null;
  if (type === 'change_pct') {
    const cached = await cache.get(`price:${asset.toUpperCase()}`);
    if (cached && cached.price) baselinePrice = cached.price;
  }

  const alert = {
    id,
    asset: asset.toUpperCase(),
    type,
    threshold_usd,
    webhook_url,
    webhook_secret,
    repeat: repeat === true,
    owner_ip: owner_ip || null,
    created_at: new Date().toISOString(),
    last_fired_at: null,
    baseline_price: baselinePrice,
    // Escalation state (issue #689). Absent/false until acknowledge() is
    // called or escalateAlert() delivers the escalation.
    acknowledged: false,
    acknowledged_at: null,
    escalated_at: null,
  };

  const redis = cache.getClient();
  // One MULTI/EXEC transaction instead of two separate round trips (issue
  // #303) — both writes are freshly computed above, so a crash between them
  // used to leave either an alert record with no entry in IDS_KEY (invisible
  // to list()/evaluateAll(), so it would never fire), or an id in IDS_KEY
  // with no backing record (a phantom entry list() would still return).
  await redis.multi()
    .set(alertKey(id), JSON.stringify(alert))
    .zadd(IDS_KEY, Date.now(), id)
    .sadd(assetIdsKey(alert.asset), id)
    .exec();

  return alert;
}

// Hard ceiling on unbounded list queries (issue #530).
const MAX_LIST_LIMIT = 1000;

async function list() {
  const redis = cache.getClient();
  const ids = await redis.zrevrange(IDS_KEY, 0, -1);
  if (ids.length === 0) return [];
  const alerts = await cache.mget(ids.map(alertKey));
  return alerts.filter(Boolean);
}

async function listPaginated({ offset = 0, limit = 20 } = {}) {
  const redis = cache.getClient();
  const total = await redis.zcard(IDS_KEY);
  const paginatedIds = await redis.zrevrange(IDS_KEY, offset, offset + limit - 1);
  if (paginatedIds.length === 0) {
    return {
      alerts: [],
      total,
    };
  }
  const alerts = await cache.mget(paginatedIds.map(alertKey));
  return {
    alerts: alerts.filter(Boolean),
    total,
  };
}

async function get(id) {
  return cache.get(alertKey(id));
}

async function remove(id) {
  const redis = cache.getClient();
  const existing = await cache.get(alertKey(id));
  if (!existing) return null;
  // One MULTI/EXEC transaction instead of two separate round trips (issue
  // #304) — a crash between them used to leave either a dangling id in
  // IDS_KEY with no backing record (a phantom entry list() would still
  // return), or a deleted-but-still-indexed alert that evaluateAll() would
  // try to re-read as null.
  await redis.multi()
    .del(alertKey(id))
    .zrem(IDS_KEY, id)
    .srem(assetIdsKey(existing.asset), id)
    .exec();
  return existing;
}

async function fire(alert, priceUsd) {
  if (await isDuplicateAlert(alert)) {
    logger.info('Duplicate alert suppressed by deduplication', { alert_id: alert.id, asset: alert.asset });
    return false;
  }

  const payload = {
    event: 'price.alert',
    alert_id: alert.id,
    asset: alert.asset,
    type: alert.type,
    threshold_usd: alert.threshold_usd,
    actual_price_usd: priceUsd,
    triggered_at: new Date().toISOString(),
  };

  logger.info('Price alert triggered', { alert_id: alert.id, asset: alert.asset, price: priceUsd });
  await webhook.deliver(alert.webhook_url, alert.webhook_secret, payload);
  return true;
}

// Marks an alert as acknowledged so it is never escalated. Returns the
// updated alert, or null if the alert does not exist. Acknowledging an
// already-acknowledged alert is a no-op that returns the existing record.
async function acknowledge(id) {
  const existing = await cache.get(alertKey(id));
  if (!existing) return null;
  if (existing.acknowledged) return existing;
  const updated = {
    ...existing,
    acknowledged: true,
    acknowledged_at: new Date().toISOString(),
  };
  await cache.set(alertKey(id), updated);
  return updated;
}

// An alert is due for escalation when it has not been acknowledged, has not
// already been escalated, and was created at least ESCALATION_TIMEOUT_MS ago.
function isEscalationDue(alert, now = Date.now()) {
  if (!alert || alert.acknowledged || alert.escalated_at) return false;
  const createdMs = Date.parse(alert.created_at);
  if (Number.isNaN(createdMs)) return false;
  return now - createdMs > ESCALATION_TIMEOUT_MS;
}

function escalationLockKey(id) {
  return `alert:escalation-lock:${id}`;
}

// Escalates a single alert once. Idempotent: returns false without delivering
// if the alert is acknowledged, already escalated, or another worker holds the
// escalation lock. The durable `escalated_at` marker prevents re-escalation
// after the lock expires. Returns true only when this call delivered it.
async function escalateAlert(alert) {
  if (!alert || alert.acknowledged || alert.escalated_at) return false;

  const redis = cache.getClient();
  // SET NX EX: only one caller across all instances can take the lock.
  const locked = await redis.set(
    escalationLockKey(alert.id),
    '1',
    'EX',
    ESCALATION_LOCK_TTL_SECONDS,
    'NX'
  );
  if (locked !== 'OK') return false;

  // Re-read under the lock: another worker may have finished escalating
  // (or the alert may have been acknowledged) between our check and the lock.
  const current = await cache.get(alertKey(alert.id));
  if (!current || current.acknowledged || current.escalated_at) {
    await redis.del(escalationLockKey(alert.id));
    return false;
  }

  const payload = {
    event: 'alert.escalated',
    alert_id: current.id,
    asset: current.asset,
    type: current.type,
    threshold_usd: current.threshold_usd,
    created_at: current.created_at,
    escalation_timeout_ms: ESCALATION_TIMEOUT_MS,
    escalated_at: new Date().toISOString(),
  };

  try {
    await webhook.deliver(current.webhook_url, current.webhook_secret, payload);
  } catch (err) {
    // Delivery failed: release the lock so a later pass can retry.
    await redis.del(escalationLockKey(alert.id));
    logger.error('Alert escalation delivery failed', { alert_id: current.id, error: err.message });
    throw err;
  }

  await cache.set(alertKey(current.id), { ...current, escalated_at: payload.escalated_at });
  logger.warn('Alert escalated after acknowledgement timeout', { alert_id: current.id, asset: current.asset });
  return true;
}

// Scans all alerts (paged, like evaluateAll) and escalates those that are due.
// Returns the number of alerts escalated in this pass. A failure on one alert
// is logged and does not stop the pass.
async function evaluateEscalations({ now = Date.now() } = {}) {
  let escalated = 0;
  let offset = 0;

  for (;;) {
    const { alerts: page, total } = await listPaginated({
      offset,
      limit: EVALUATE_ALL_PAGE_SIZE,
    });
    for (const alert of page) {
      if (!isEscalationDue(alert, now)) continue;
      try {
        if (await escalateAlert(alert)) escalated += 1;
      } catch (err) {
        logger.error('Alert escalation pass error', { alert_id: alert.id, error: err.message });
      }
    }
    offset += EVALUATE_ALL_PAGE_SIZE;
    if (offset >= total || page.length === 0) break;
  }

  return escalated;
}

function assetCooldownKey(asset) {
  return `alert:cooldown:${asset.toUpperCase()}`;
}

async function evaluateForAsset(asset, priceUsd) {
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`evaluateForAsset timed out after ${ALERT_EVAL_TIMEOUT_MS}ms`)),
      ALERT_EVAL_TIMEOUT_MS
    );
  });

  try {
    await Promise.race([evaluateForAssetInner(asset, priceUsd), timeout]);
  } catch (err) {
    logger.error('Alert evaluation failed or timed out', { asset, error: err.message });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function evaluateForAssetInner(asset, priceUsd) {
  const redis = cache.getClient();
  const ids = await redis.smembers(assetIdsKey(asset));

  for (const id of ids) {
    const alert = await cache.get(alertKey(id));
    // Index and record can drift (e.g. a record written by an older
    // version before this index existed) — fall back to the asset check
    // rather than trusting the index blindly.
    if (!alert || alert.asset !== asset.toUpperCase()) continue;

    if (!isTriggered(alert, priceUsd)) continue;

    if (alert.repeat) {
      if (alert.last_fired_at) {
        const elapsed = Date.now() - new Date(alert.last_fired_at).getTime();
        if (elapsed < COOLDOWN_MS) continue;
      }
      const assetLastFired = await cache.get(assetCooldownKey(alert.asset));
      if (assetLastFired) {
        const assetElapsed = Date.now() - new Date(assetLastFired).getTime();
        if (assetElapsed < COOLDOWN_MS) continue;
      }
    }

    await fire(alert, priceUsd);

    if (!alert.repeat) {
      await remove(id);
    } else {
      const nowIso = new Date().toISOString();
      alert.last_fired_at = nowIso;
      if (alert.type === 'change_pct') {
        alert.baseline_price = priceUsd;
      }
      await cache.set(alertKey(id), alert);
      await cache.set(assetCooldownKey(alert.asset), nowIso);
    }
  }
}

const EVALUATE_ALL_PAGE_SIZE = 100;

async function evaluateAll() {
  const assets = new Set();
  let offset = 0;

  // Page through via listPaginated instead of list()'s unbounded
  // ZREVRANGE 0 -1 (#319) — evaluateForAsset only needs the distinct
  // asset set, not every alert loaded into memory at once.
  for (;;) {
    const { alerts: page, total } = await listPaginated({
      offset,
      limit: EVALUATE_ALL_PAGE_SIZE,
    });
    for (const alert of page) {
      assets.add(alert.asset);
    }
    offset += EVALUATE_ALL_PAGE_SIZE;
    if (offset >= total || page.length === 0) break;
  }

  for (const asset of assets) {
    const cached = await cache.get(`price:${asset}`);
    if (!cached || cached.price == null) continue;
    await evaluateForAsset(asset, cached.price);
  }
}

// One-time backfill for the assetIdsKey() index (issue #310): populates it
// for alerts that were created before this index existed, so
// evaluateForAssetInner doesn't silently stop seeing them. Safe to run
// repeatedly (SADD is idempotent); not wired into any automatic startup
// path since it's an O(n) full scan — meant to be run once, manually, by an
// operator against an existing deployment's pre-existing alert set.
async function backfillAssetIndex() {
  const redis = cache.getClient();
  const ids = await redis.zrevrange(IDS_KEY, 0, -1);
  const multi = redis.multi();
  let queued = 0;
  for (const id of ids) {
    const alert = await cache.get(alertKey(id));
    if (!alert) continue;
    multi.sadd(assetIdsKey(alert.asset), id);
    queued += 1;
  }
  if (queued > 0) await multi.exec();
  return queued;
}

module.exports = {
  create,
  get,
  list,
  listPaginated,
  remove,
  evaluateForAsset,
  evaluateAll,
  backfillAssetIndex,
  fire,
  isDuplicateAlert,
  getAlertDedupKey,
  DEDUP_WINDOW_SECONDS,
  // Escalation (issue #689)
  acknowledge,
  escalateAlert,
  evaluateEscalations,
  isEscalationDue,
  ESCALATION_TIMEOUT_MS,
};
