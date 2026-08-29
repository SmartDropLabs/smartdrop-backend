const Redis = require('ioredis');
const config = require('../config');
const logger = require('../logger');
const Semaphore = require('../utils/semaphore');

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 1000;
const CONNECT_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 3000;
const COMMAND_QUEUE_WARN_THRESHOLD = parseInt(process.env.REDIS_COMMAND_QUEUE_WARN_THRESHOLD, 10) || 100;
const COMMAND_QUEUE_BACKPRESSURE_THRESHOLD = parseInt(process.env.REDIS_COMMAND_QUEUE_BACKPRESSURE_THRESHOLD, 10) || 500;

let client = null;
let reconnectAttempts = 0;

// Concurrency limiter to prevent Redis connection pool exhaustion (issue #249).
// Limits concurrent in-flight Redis commands to prevent queue buildup.
const MAX_CONCURRENT_OPS = parseInt(process.env.REDIS_MAX_CONCURRENT_OPS, 10) || 50;
const operationSemaphore = new Semaphore(MAX_CONCURRENT_OPS);

let consecutiveQueueWarnings = 0;

function _checkQueueBackpressure(caller) {
  const queueLen = getCommandQueueLength();
  if (queueLen > COMMAND_QUEUE_BACKPRESSURE_THRESHOLD) {
    consecutiveQueueWarnings++;
    if (consecutiveQueueWarnings % 10 === 1) {
      logger.error('Redis command queue critically deep — backpressure active', {
        queue_length: queueLen,
        threshold: COMMAND_QUEUE_BACKPRESSURE_THRESHOLD,
        caller,
        consecutive_warnings: consecutiveQueueWarnings,
      });
    }
    return true;
  }
  if (queueLen > COMMAND_QUEUE_WARN_THRESHOLD) {
    consecutiveQueueWarnings++;
    if (consecutiveQueueWarnings % 5 === 1) {
      logger.warn('Redis command queue depth high', {
        queue_length: queueLen,
        threshold: COMMAND_QUEUE_WARN_THRESHOLD,
        caller,
      });
    }
    return false;
  }
  if (consecutiveQueueWarnings > 0) {
    logger.info('Redis command queue depth recovered', { queue_length: queueLen, caller });
    consecutiveQueueWarnings = 0;
  }
  return false;
}

function getClient() {
  if (!client) {
    client = new Redis(config.redis.url, {
      lazyConnect: true,
      enableOfflineQueue: true,
      connectTimeout: CONNECT_TIMEOUT_MS,
      commandTimeout: COMMAND_TIMEOUT_MS,
      retryStrategy(times) {
        if (times > MAX_RETRIES) {
          logger.error('Redis max reconnection attempts reached', { attempts: times });
          return null;
        }
        const delay = Math.min(times * RETRY_DELAY_MS, 30000);
        logger.warn('Redis reconnecting', { attempt: times, delayMs: delay });
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    client.on('error', (err) => {
      reconnectAttempts++;
      logger.error('Redis connection error', { error: err.message, reconnectAttempts });
    });
    client.on('connect', () => {
      reconnectAttempts = 0;
      logger.info('Redis connected');
    });
    client.on('ready', () => {
      reconnectAttempts = 0;
      logger.info('Redis ready');
    });
    client.on('close', () => {
      logger.warn('Redis connection closed');
    });
    client.connect().catch(() => {});
  }
  return client;
}

function isConnected() {
  return client !== null && client.status === 'ready';
}

function getCommandQueueLength() {
  if (!client) return 0;
  return client.commandQueue ? client.commandQueue.length : 0;
}

function getConcurrencyStats() {
  return {
    active: operationSemaphore.active,
    waiting: operationSemaphore.waiting,
    available: operationSemaphore.available,
    max: MAX_CONCURRENT_OPS,
  };
}

async function get(key) {
  const release = await operationSemaphore.acquire(5000);
  try {
    _checkQueueBackpressure('get');
    const redis = getClient();
    const data = await redis.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  } finally {
    release();
  }
}

async function set(key, value, ttlSeconds) {
  const release = await operationSemaphore.acquire(5000);
  try {
    _checkQueueBackpressure('set');
    const redis = getClient();
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await redis.setex(key, ttlSeconds, serialized);
    } else {
      await redis.set(key, serialized);
    }
  } finally {
    release();
  }
}

async function del(key) {
  const release = await operationSemaphore.acquire(5000);
  try {
    const redis = getClient();
    await redis.del(key);
  } finally {
    release();
  }
}

async function disconnect() {
  if (client) {
    await client.quit();
    client = null;
  }
}

module.exports = {
  get, set, del, disconnect, getClient, isConnected,
  getCommandQueueLength, getConcurrencyStats,
};
