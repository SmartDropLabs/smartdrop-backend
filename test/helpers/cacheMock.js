'use strict';

/**
 * In-memory mock of the ioredis surface used by src/services/cache.js.
 * Covers strings (used by cache.get/set/del), SETs, sorted SETs, LISTs,
 * and HASHes.
 */
function createCacheMock() {
  const sets = new Map();
  const zsets = new Map();
  const lists = new Map();
  const hashes = new Map();
  const counters = new Map();
  // Raw string store (with per-key TTL) backing redis.set/get/del. Real
  // Redis has exactly one string keyspace behind both the raw ioredis API
  // and cache.js's JSON-serializing get/set/del wrapper — so both are
  // implemented against this single Map (see cacheMock.get/set/del below),
  // rather than each holding its own disconnected copy of the same key.
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
  function getHash(key) {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  }
  function isExpired(entry) {
    return entry.expiresAt !== null && Date.now() >= entry.expiresAt;
  }
  function getLive(key) {
    const entry = rawStore.get(key);
    if (!entry || isExpired(entry)) return null;
    return entry;
  }

  // Queues commands issued through redis.multi()/redis.pipeline() and
  // replays them, in order, against the same redis.<command> mock
  // functions on .exec() — so MULTI/EXEC and PIPELINE go through the exact
  // same logic as calling each command directly, with no duplicated
  // implementation to drift out of sync.
  function makeChain() {
    const queue = [];
    const chain = {};
    const proxy = new Proxy(chain, {
      get(target, prop) {
        if (prop === 'exec') {
          return async () => {
            const results = [];
            for (const [cmd, args] of queue) {
              try {
                results.push([null, await redis[cmd](...args)]);
              } catch (err) {
                results.push([err, null]);
              }
            }
            return results;
          };
        }
        return (...args) => {
          queue.push([prop, args]);
          return proxy;
        };
      },
    });
    return proxy;
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
      hashes.delete(key);
      sets.delete(key);
      zsets.delete(key);
      lists.delete(key);
      return 'OK';
    }),
    get: jest.fn(async (key) => {
      const entry = getLive(key);
      return entry ? entry.value : null;
    }),
    del: jest.fn(async (key) => {
      const had = getLive(key) !== null || hashes.has(key) || sets.has(key) || zsets.has(key) || lists.has(key);
      rawStore.delete(key);
      hashes.delete(key);
      sets.delete(key);
      zsets.delete(key);
      lists.delete(key);
      return had ? 1 : 0;
    }),
    // Issue #353 (eventStore.js) uses these to store per-recipient fields
    // instead of one JSON-list string per airdrop.
    type: jest.fn(async (key) => {
      if (getLive(key)) return 'string';
      if (hashes.has(key) && hashes.get(key).size > 0) return 'hash';
      if (sets.has(key) && sets.get(key).size > 0) return 'set';
      if (zsets.has(key) && zsets.get(key).size > 0) return 'zset';
      if (lists.has(key) && lists.get(key).length > 0) return 'list';
      return 'none';
    }),
    hset: jest.fn(async (key, field, value) => {
      const isNew = !getHash(key).has(field);
      getHash(key).set(field, String(value));
      return isNew ? 1 : 0;
    }),
    hget: jest.fn(async (key, field) => {
      const h = hashes.get(key);
      return h && h.has(field) ? h.get(field) : null;
    }),
    hgetall: jest.fn(async (key) => {
      const h = hashes.get(key);
      if (!h) return {};
      return Object.fromEntries(h.entries());
    }),
    // Issue #343 (webhookDispatcher metrics persistence): HINCRBY is the
    // write-through primitive for the durable delivery counters.
    hincrby: jest.fn(async (key, field, by) => {
      const h = getHash(key);
      const next = (Number(h.get(field)) || 0) + Number(by);
      h.set(field, String(next));
      return next;
    }),
    // Issue #343: SCAN over the whole keyspace (all key types), matching a
    // Redis glob pattern. Returns the lot in one pass (cursor '0'), which is
    // all callers iterating until cursor === '0' need.
    scan: jest.fn(async (cursor, ...args) => {
      const matchIdx = args.indexOf('MATCH');
      const pattern = matchIdx === -1 ? '*' : String(args[matchIdx + 1]);
      const regex = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
      );
      const allKeys = new Set([
        ...rawStore.keys(),
        ...hashes.keys(),
        ...sets.keys(),
        ...zsets.keys(),
        ...lists.keys(),
      ]);
      const matches = [...allKeys].filter((key) => regex.test(key));
      return ['0', matches];
    }),
    pexpire: jest.fn(async (key, ms) => {
      const entry = getLive(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + Number(ms);
      return 1;
    }),
    // Issues #352/#354/#355: MULTI/EXEC — queues commands and replays them
    // against the mock's own already-implemented methods on .exec(). Real
    // MULTI/EXEC additionally guarantees no other client's commands can
    // interleave between them; this mock only needs to prove the caller
    // issues one .exec() covering all the intended writes; it does not
    // model cross-client interleaving.
    multi: jest.fn(() => makeChain()),
    pipeline: jest.fn(() => makeChain()),
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
      if (name === 'advanceLastLedger') {
        // Mirrors ADVANCE_LAST_LEDGER_LUA (issue #341): compare-and-set
        // (expected === '' means "key must be absent") plus monotonicity —
        // never store a lower ledger than the one already stored. Reads and
        // the write below are uninterrupted, matching Redis running the
        // script to completion.
        redis.advanceLastLedger = jest.fn(async (key, expected, nextValue) => {
          const cursor = getLive(key) ? getLive(key).value : null;
          if (expected === '') {
            if (cursor !== null) return 0;
          } else if (cursor === null || cursor !== expected) {
            return 0;
          }
          const nextNumber = Number(nextValue);
          if (!Number.isFinite(nextNumber)) return 0;
          if (cursor !== null) {
            const cursorNumber = Number(cursor);
            if (Number.isFinite(cursorNumber) && nextNumber < cursorNumber) return 0;
          }
          rawStore.set(key, { value: String(nextValue), expiresAt: null });
          return 1;
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
      const raw = await redis.get(key);
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }),
    set: jest.fn(async (key, value, ttlSeconds) => {
      const serialized = JSON.stringify(value);
      if (ttlSeconds) await redis.set(key, serialized, 'EX', ttlSeconds);
      else await redis.set(key, serialized);
    }),
    del: jest.fn(async (key) => { await redis.del(key); }),
    disconnect: jest.fn(async () => {}),
  };

  // Read-only view over rawStore, parsed, for tests that inspect the
  // stored value directly rather than through cache.get() (e.g.
  // webhookRepository.test.js's encryption-at-rest assertions). Backed by
  // the same rawStore cache.set/get and raw redis.set/get share, so it
  // sees a write made through either API.
  const store = {
    get(key) {
      const entry = getLive(key);
      if (!entry) return undefined;
      try {
        return JSON.parse(entry.value);
      } catch {
        return entry.value;
      }
    },
  };

  function reset() {
    sets.clear();
    zsets.clear();
    lists.clear();
    hashes.clear();
    counters.clear();
    rawStore.clear();
    Object.values(redis).forEach((fn) => fn.mockClear?.());
    cacheMock.get.mockClear();
    cacheMock.set.mockClear();
    cacheMock.del.mockClear();
  }

  return { cacheMock, redis, store, sets, zsets, lists, hashes, counters, reset };
}

module.exports = { createCacheMock };
