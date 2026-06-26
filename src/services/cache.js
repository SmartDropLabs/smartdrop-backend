const Redis = require('ioredis');
const config = require('../config');
const logger = require('../logger');

let client = null;

function getClient() {
  if (!client) {
    client = new Redis({
      ...config.redis,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    client.on('error', (err) => {
      logger.error('Redis connection error', { error: err.message });
    });
    client.on('connect', () => {
      logger.info('Redis connected');
    });
    client.on('ready', () => {
      logger.info('Redis ready');
    });
    // Kick off the initial connection without blocking or throwing here;
    // errors are surfaced via the 'error' event above.
    client.connect().catch(() => {});
  }
  return client;
}

function isConnected() {
  return client !== null && client.status === 'ready';
}

async function get(key) {
  const redis = getClient();
  const data = await redis.get(key);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

async function set(key, value, ttlSeconds) {
  const redis = getClient();
  const serialized = JSON.stringify(value);
  if (ttlSeconds) {
    await redis.setex(key, ttlSeconds, serialized);
  } else {
    await redis.set(key, serialized);
  }
}

async function del(key) {
  const redis = getClient();
  await redis.del(key);
}

async function disconnect() {
  if (client) {
    await client.quit();
    client = null;
  }
}

module.exports = { get, set, del, disconnect, getClient, isConnected };
