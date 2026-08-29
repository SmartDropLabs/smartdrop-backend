'use strict';

/**
 * In-memory mock of the ioredis surface used by src/services/cache.js.
 * Covers strings (used by cache.get/set/del), SETs, sorted SETs, and LISTs.
 */
function createCacheMock() {
  const store = new Map();
  const sets = new Map();
  const zsets = new Map();
  const lists = new Map();
  const counters = new Map();
  // Separate raw string store (with per-key TTL) backing redis.set/get/del —
  // distinct from `store` above, which backs the higher-level cacheMock.
  // get/set JSON API with different key/value semantics.
  const rawStore = new Map();

  function getSet(key) {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key);
  }
  function getZSet(key) {
    if (!zsets.has(key)) zsets.set(key, new Map());
    return zsets.get(key);
  }
  function getList(key) {
    if (!lists.has(key)) lists.set(key, []);
    return lists.get(key);
  }
  function isExpired(entry) {
    return entry.expiresAt !== null && Date.now() >= entry.expiresAt;
  }
  function getLive(key) {
    const entry = rawStore.get(key);
    if (!entry || isExpired(entry)) return null;
    return entry;
  }

  const redis = {
    smembers: jest.fn(async (key) => [...(sets.get(key) || [])]),
    sadd: jest.fn(async (key, val) => { getSet(key).add(val); }),
    srem: jest.fn(async (key, val) => { sets.get(key)?.delete(val); }),
    zadd: jest.fn(async (key, score, member) => { getZSet(key).set(member, Number(score)); }),
    zcard: jest.fn(async (key) => (zsets.get(key) || new Map()).size),
    rpush: jest.fn(async (key, ...vals) => { getList(key).push(...vals); }),
    llen: jest.fn(async (key) => (lists.get(key) || []).length),
    lrange: jest.fn(async (key, start, stop) => {
      const list = lists.get(key) || [];
      const resolveIndex = (i) => (i < 0 ? Math.max(list.length + i, 0) : i);
      return list.slice(resolveIndex(start), resolveIndex(stop) + 1);
    }),
    zrem: jest.fn(async (key, ...members) => {
      const z = zsets.get(key);
      if (!z) return;
      for (const m of members) z.delete(m);
    }),
    zrevrange: jest.fn(async (key, start, stop) => {
      const z = zsets.get(key);
      if (!z) return [];
      const sorted = [...z.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
      // Real Redis treats negative indices as counting from the end
      // (-1 = last element) — needed for the common "N to the end"
      // idiom (e.g. ZREVRANGE key 0 -1), which plain `slice(start,
      // stop + 1)` gets wrong for any negative stop (#131).
      const resolveIndex = (i) => (i < 0 ? Math.max(sorted.length + i, 0) : i);
      return sorted.slice(resolveIndex(start), resolveIndex(stop) + 1);
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
    // ioredis-style raw SET, supporting the NX/PX/EX option pairs used by
    // leaderElection.js's lease acquisition (`SET key val NX PX ttlMs`).
    // Returns 'OK' on success, null if NX and the key already holds a
    // live (non-expired) value — matching real Redis's SET NX semantics.
    set: jest.fn(async (key, value, ...args) => {
      let nx = false;
      let ttlMs = null;
      for (let i = 0; i < args.length; i += 1) {
        const arg = String(args[i]).toUpperCase();
        if (arg === 'NX') nx = true;
        else if (arg === 'PX') { ttlMs = Number(args[i + 1]); i += 1; }
        else if (arg === 'EX') { ttlMs = Number(args[i + 1]) * 1000; i += 1; }
      }
      if (nx && getLive(key)) return null;
      rawStore.set(key, { value: String(value), expiresAt: ttlMs !== null ? Date.now() + ttlMs : null });
      return 'OK';
    }),
    get: jest.fn(async (key) => {
      const entry = getLive(key);
      return entry ? entry.value : null;
    }),
    del: jest.fn(async (key) => (rawStore.delete(key) ? 1 : 0)),
    pexpire: jest.fn(async (key, ms) => {
      const entry = getLive(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + Number(ms);
      return 1;
    }),
    // Mimics ioredis#defineCommand for the custom commands this codebase
    // registers (see deliveryRepository.js and leaderElection.js). Real
    // Redis runs the Lua body single-threaded to completion, so this mock
    // implementation reads and mutates without an intervening `await`,
    // preserving that atomicity guarantee for tests.
    defineCommand: jest.fn((name, { lua } = {}) => {
      if (name === 'popDueRetriesAtomic') {
        redis.popDueRetriesAtomic = jest.fn(async (queueKey, maxScore, limit) => {
          const z = getZSet(queueKey);
          const max = Number(maxScore);
          const ids = [...z.entries()]
            .filter(([, score]) => score <= max)
            .sort((a, b) => a[1] - b[1])
            .slice(0, Number(limit))
            .map(([m]) => m);
          ids.forEach((id) => z.delete(id));
          return ids;
        });
        return;
      }
      if (name === 'renewLease') {
        // Mirrors RENEW_LUA: renew only if we still hold the lease.
        redis.renewLease = jest.fn(async (key, expectedValue, ttlMs) => {
          const entry = getLive(key);
          if (entry && entry.value === expectedValue) {
            entry.expiresAt = Date.now() + Number(ttlMs);
            return 1;
          }
          return 0;
        });
        return;
      }
      if (name === 'releaseLease') {
        // Mirrors RELEASE_LUA: release only if we still hold the lease.
        redis.releaseLease = jest.fn(async (key, expectedValue) => {
          const entry = getLive(key);
          if (entry && entry.value === expectedValue) {
            rawStore.delete(key);
            return 1;
          }
          return 0;
        });
        return;
      }
      throw new Error(`cacheMock.defineCommand: unsupported command "${name}" (lua: ${typeof lua})`);
    }),
  };

  const cacheMock = {
    getClient: () => redis,
    isConnected: () => true,
    getCommandQueueLength: () => 0,
    getConcurrencyStats: () => ({ active: 0, waiting: 0, available: 50, max: 50 }),
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
    lists.clear();
    counters.clear();
    rawStore.clear();
    Object.values(redis).forEach((fn) => fn.mockClear?.());
    cacheMock.get.mockClear();
    cacheMock.set.mockClear();
    cacheMock.del.mockClear();
  }

  return { cacheMock, redis, store, sets, zsets, lists, counters, reset };
}

module.exports = { createCacheMock };
