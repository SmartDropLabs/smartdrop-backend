'use strict';

const DEFAULT_MAX_ENTRIES = 1000; // #722 query plan cache size limit
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Least Recently Used (LRU) cache with bounded size (#722).
 */
class LRU {
  constructor(options = {}) {
    this.max = options.max ?? DEFAULT_MAX_ENTRIES;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    // Refresh access order (move to most recently used)
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      // Evict least recently used (first inserted key in Map)
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, value);
    return this;
  }

  has(key) {
    return this.map.has(key);
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }

  keys() {
    return this.map.keys();
  }

  values() {
    return this.map.values();
  }

  entries() {
    return this.map.entries();
  }

  [Symbol.iterator]() {
    return this.map[Symbol.iterator]();
  }
}

class QueryPlanCache {
  constructor(options = {}) {
    this.maxEntries = options.max ?? options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.max = this.maxEntries;
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    this.cache = new LRU({ max: this.maxEntries });
    this.hits = 0;
    this.misses = 0;
  }

  _key(query, params) {
    return `${query}::${JSON.stringify(params ?? [])}`;
  }

  get(query, params) {
    const key = this._key(query, params);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses += 1;
      return null;
    }

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(key);
      this.misses += 1;
      return null;
    }

    this.hits += 1;
    return entry.plan;
  }

  set(query, params, plan) {
    const key = this._key(query, params);
    this.cache.set(key, { plan, cachedAt: Date.now() });
  }

  invalidate(query, params) {
    const key = this._key(query, params);
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats() {
    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0
        ? this.hits / (this.hits + this.misses)
        : 0,
    };
  }
}

const defaultCache = new QueryPlanCache();

module.exports = {
  QueryPlanCache,
  LRU,
  DEFAULT_MAX_ENTRIES,
  queryPlanCache: defaultCache,
};
