'use strict';

/**
 * In-memory mock of the ioredis surface used by src/services/cache.js.
 * Covers strings (used by cache.get/set/del), SETs, and sorted SETs.
 */
function createCacheMock() {
  const store = new Map();
  const sets = new Map();
  const zsets = new Map();
  const counters = new Map();

  function getSet(key) {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key);
  }
  function getZSet(key) {
    if (!zsets.has(key)) zsets.set(key, new Map());
    return zsets.get(key);
  }

  const redis = {
    smembers: jest.fn(async (key) => [...(sets.get(key) || [])]),
    sadd: jest.fn(async (key, val) => { getSet(key).add(val); }),
    srem: jest.fn(async (key, val) => { sets.get(key)?.delete(val); }),
    zadd: jest.fn(async (key, score, member) => { getZSet(key).set(member, Number(score)); }),
    zrem: jest.fn(async (key, ...members) => {
      const z = zsets.get(key);
      if (!z) return;
      for (const m of members) z.delete(m);
    }),
    zrevrange: jest.fn(async (key, start, stop) => {
      const z = zsets.get(key);
      if (!z) return [];
      const sorted = [...z.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
      return sorted.slice(start, stop + 1);
    }),
    zrangebyscore: jest.fn(async (key, min, max, ...rest) => {
      const z = zsets.get(key);
      if (!z) return [];
      const minScore = min === '-inf' ? -Infinity : Number(min);
      const maxScore = max === '+inf' ? Infinity : Number(max);
      let sorted = [...z.entries()]
        .filter(([, score]) => score >= minScore && score <= maxScore)
        .sort((a, b) => a[1] - b[1])
        .map(([m]) => m);
      const limitIdx = rest.indexOf('LIMIT');
      if (limitIdx !== -1) {
        const offset = Number(rest[limitIdx + 1]);
        const count = Number(rest[limitIdx + 2]);
        sorted = sorted.slice(offset, offset + count);
      }
      return sorted;
    }),
    zremrangebyrank: jest.fn(async (key, start, stop) => {
      const z = zsets.get(key);
      if (!z) return;
      const sortedAsc = [...z.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
      const end = stop < 0 ? sortedAsc.length + stop : stop;
      const begin = start < 0 ? sortedAsc.length + start : start;
      for (let i = begin; i <= end && i < sortedAsc.length; i += 1) {
        z.delete(sortedAsc[i]);
      }
    }),
    incr: jest.fn(async (key) => {
      const n = (counters.get(key) || 0) + 1;
      counters.set(key, n);
      return n;
    }),
    expire: jest.fn(async () => 1),
  };

  const cacheMock = {
    getClient: () => redis,
    isConnected: () => true,
    get: jest.fn(async (key) => {
      const v = store.get(key);
      return v !== undefined ? JSON.parse(JSON.stringify(v)) : null;
    }),
    set: jest.fn(async (key, value) => { store.set(key, JSON.parse(JSON.stringify(value))); }),
    del: jest.fn(async (key) => { store.delete(key); }),
    disconnect: jest.fn(async () => {}),
  };

  function reset() {
    store.clear();
    sets.clear();
    zsets.clear();
    counters.clear();
    Object.values(redis).forEach((fn) => fn.mockClear?.());
    cacheMock.get.mockClear();
    cacheMock.set.mockClear();
    cacheMock.del.mockClear();
  }

  return { cacheMock, redis, store, sets, zsets, counters, reset };
}

module.exports = { createCacheMock };
