const crypto = require('crypto');
const cache = require('./cache');
const webhook = require('./webhook');
const logger = require('../logger');

const IDS_KEY = 'alerts:ids';
const COOLDOWN_MS = 5 * 60 * 1000;

function alertKey(id) {
  return `alert:${id}`;
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
  const { asset, type, threshold_usd, webhook_url, webhook_secret, repeat } = data;

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
    created_at: new Date().toISOString(),
    last_fired_at: null,
    baseline_price: baselinePrice,
  };

  const redis = cache.getClient();
  await cache.set(alertKey(id), alert);
  await redis.zadd(IDS_KEY, Date.now(), id);

  return alert;
}

async function list() {
  const redis = cache.getClient();
  const ids = await redis.zrevrange(IDS_KEY, 0, -1);
  const alerts = await Promise.all(ids.map((id) => cache.get(alertKey(id))));
  return alerts.filter(Boolean);
}

async function listPaginated({ offset = 0, limit = 20 } = {}) {
  const redis = cache.getClient();
  const total = await redis.zcard(IDS_KEY);
  const paginatedIds = await redis.zrevrange(IDS_KEY, offset, offset + limit - 1);
  const alerts = await Promise.all(
    paginatedIds.map((id) => cache.get(alertKey(id)))
  );
  return {
    alerts: alerts.filter(Boolean),
    total
  };
}

async function remove(id) {
  const redis = cache.getClient();
  const existing = await cache.get(alertKey(id));
  if (!existing) return null;
  await cache.del(alertKey(id));
  await redis.zrem(IDS_KEY, id);
  return existing;
}

async function fire(alert, priceUsd) {
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
}

async function evaluateForAsset(asset, priceUsd) {
  const redis = cache.getClient();
  const ids = await redis.zrevrange(IDS_KEY, 0, -1);

  for (const id of ids) {
    const alert = await cache.get(alertKey(id));
    if (!alert || alert.asset !== asset.toUpperCase()) continue;

    if (!isTriggered(alert, priceUsd)) continue;

    if (alert.repeat && alert.last_fired_at) {
      const elapsed = Date.now() - new Date(alert.last_fired_at).getTime();
      if (elapsed < COOLDOWN_MS) continue;
    }

    await fire(alert, priceUsd);

    if (!alert.repeat) {
      await remove(id);
    } else {
      alert.last_fired_at = new Date().toISOString();
      await cache.set(alertKey(id), alert);
    }
  }
}

async function evaluateAll() {
  const allAlerts = await list();
  const assets = [...new Set(allAlerts.map((a) => a.asset))];

  for (const asset of assets) {
    const cached = await cache.get(`price:${asset}`);
    if (!cached || cached.price == null) continue;
    await evaluateForAsset(asset, cached.price);
  }
}

module.exports = { create, list, listPaginated, remove, evaluateForAsset, evaluateAll };
