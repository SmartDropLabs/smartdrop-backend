'use strict';

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

class QueryPlanCache {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    this.cache = new Map();
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

    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }

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
  queryPlanCache: defaultCache,
};
