// Issue #480: No query result caching
// Implements query result caching to reduce database load

import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';

export interface CacheConfig {
  /** Redis client instance */
  redis: any;
  /** Default TTL in seconds */
  defaultTTL?: number;
  /** Key prefix for cache entries */
  keyPrefix?: string;
  /** Enable cache compression */
  compression?: boolean;
  /** Cache only GET requests */
  getOnly?: boolean;
}

export interface CacheOptions {
  /** TTL in seconds for this specific cache entry */
  ttl?: number;
  /** Cache key override */
  key?: string;
  /** Cache tags for invalidation */
  tags?: string[];
  /** Conditional caching based on request/response */
  condition?: (req: Request, res: Response) => boolean;
}

const DEFAULT_CONFIG: Partial<CacheConfig> = {
  defaultTTL: 300, // 5 minutes
  keyPrefix: 'smartdrop:cache:',
  compression: false,
  getOnly: true,
};

/**
 * Query result caching middleware
 * 
 * Caches API responses in Redis to reduce database load and improve performance.
 * 
 * Features:
 * - Automatic cache key generation based on URL and query params
 * - Configurable TTL per route
 * - Cache invalidation by tags
 * - Conditional caching
 * - Request ID tracking in cache metadata
 * 
 * Usage:
 * ```
 * import { createQueryCache } from './middleware/query-cache';
 * 
 * const cache = createQueryCache({ redis: redisClient });
 * 
 * // Cache with default TTL
 * router.get('/airdrops', cache(), getAirdrops);
 * 
 * // Cache with custom TTL
 * router.get('/pools', cache({ ttl: 60 }), getPools);
 * 
 * // Cache with tags for invalidation
 * router.get('/rewards/:poolId', cache({ tags: ['rewards', 'pool'] }), getRewards);
 * ```
 */
export function createQueryCache(config: CacheConfig) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return function queryCache(options: CacheOptions = {}) {
    return async (req: Request, res: Response, next: NextFunction) => {
      // Only cache GET requests by default
      if (mergedConfig.getOnly && req.method !== 'GET') {
        return next();
      }

      const cacheKey = options.key || generateCacheKey(req, mergedConfig.keyPrefix!);
      const cacheTTL = options.ttl || mergedConfig.defaultTTL!;

      try {
        // Try to get cached response
        const cachedData = await mergedConfig.redis.get(cacheKey);

        if (cachedData) {
          const cached = JSON.parse(cachedData);

          // Set cache headers
          res.setHeader('X-Cache', 'HIT');
          res.setHeader('X-Cache-Key', cacheKey);
          res.setHeader('X-Cache-Age', Date.now() - cached.timestamp);

          // Send cached response
          return res.status(cached.statusCode).json(cached.body);
        }

        // Cache miss
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('X-Cache-Key', cacheKey);

        // Intercept response to cache it
        const originalJson = res.json.bind(res);

        res.json = function (body: any) {
          // Check conditional caching
          if (options.condition && !options.condition(req, res)) {
            return originalJson(body);
          }

          // Only cache successful responses
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const cacheData = {
              statusCode: res.statusCode,
              body,
              timestamp: Date.now(),
              requestId: req.requestId,
              tags: options.tags || [],
            };

            // Store in cache (fire and forget)
            mergedConfig.redis
              .setex(cacheKey, cacheTTL, JSON.stringify(cacheData))
              .catch((err: Error) => {
                console.error('Cache write error:', err);
              });

            // Store tags mapping for invalidation
            if (options.tags && options.tags.length > 0) {
              storeCacheTags(mergedConfig.redis, cacheKey, options.tags, cacheTTL).catch(
                (err: Error) => {
                  console.error('Cache tag storage error:', err);
                },
              );
            }
          }

          return originalJson(body);
        };

        next();
      } catch (error) {
        // Cache errors should not break the request
        console.error('Cache middleware error:', error);
        next();
      }
    };
  };
}

/**
 * Generate cache key from request
 */
function generateCacheKey(req: Request, prefix: string): string {
  const url = req.originalUrl || req.url;
  const method = req.method;
  
  // Include query params in key
  const queryString = JSON.stringify(req.query);
  
  // Hash for consistent key length
  const hash = createHash('sha256')
    .update(`${method}:${url}:${queryString}`)
    .digest('hex')
    .substring(0, 16);

  return `${prefix}${hash}`;
}

/**
 * Store cache tags for invalidation
 */
async function storeCacheTags(
  redis: any,
  cacheKey: string,
  tags: string[],
  ttl: number,
): Promise<void> {
  const promises = tags.map((tag) => {
    const tagKey = `smartdrop:cache:tag:${tag}`;
    return redis.sadd(tagKey, cacheKey).then(() => redis.expire(tagKey, ttl));
  });

  await Promise.all(promises);
}

/**
 * Cache invalidation utility
 */
export class CacheInvalidator {
  constructor(private redis: any, private keyPrefix: string = 'smartdrop:cache:') {}

  /**
   * Invalidate cache by exact key
   */
  async invalidateKey(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /**
   * Invalidate cache by pattern
   */
  async invalidatePattern(pattern: string): Promise<number> {
    const keys = await this.redis.keys(`${this.keyPrefix}${pattern}`);
    
    if (keys.length === 0) {
      return 0;
    }

    await this.redis.del(...keys);
    return keys.length;
  }

  /**
   * Invalidate cache by tag
   */
  async invalidateByTag(tag: string): Promise<number> {
    const tagKey = `smartdrop:cache:tag:${tag}`;
    const cacheKeys = await this.redis.smembers(tagKey);

    if (cacheKeys.length === 0) {
      return 0;
    }

    // Delete all cached entries with this tag
    await this.redis.del(...cacheKeys);
    
    // Delete the tag set itself
    await this.redis.del(tagKey);

    return cacheKeys.length;
  }

  /**
   * Invalidate cache by multiple tags
   */
  async invalidateByTags(tags: string[]): Promise<number> {
    let totalInvalidated = 0;

    for (const tag of tags) {
      const count = await this.invalidateByTag(tag);
      totalInvalidated += count;
    }

    return totalInvalidated;
  }

  /**
   * Clear all cache entries
   */
  async clearAll(): Promise<number> {
    return this.invalidatePattern('*');
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    totalKeys: number;
    totalTags: number;
    memoryUsage: string;
  }> {
    const keys = await this.redis.keys(`${this.keyPrefix}*`);
    const tags = await this.redis.keys('smartdrop:cache:tag:*');
    const info = await this.redis.info('memory');

    // Parse memory usage from info
    const memoryMatch = info.match(/used_memory_human:(.+)/);
    const memoryUsage = memoryMatch ? memoryMatch[1].trim() : 'unknown';

    return {
      totalKeys: keys.length,
      totalTags: tags.length,
      memoryUsage,
    };
  }
}

/**
 * Cache warming utility
 */
export class CacheWarmer {
  constructor(
    private redis: any,
    private keyPrefix: string = 'smartdrop:cache:',
  ) {}

  /**
   * Warm cache by pre-fetching data
   */
  async warmCache(entries: Array<{
    key: string;
    fetcher: () => Promise<any>;
    ttl: number;
    tags?: string[];
  }>): Promise<void> {
    const promises = entries.map(async (entry) => {
      try {
        const data = await entry.fetcher();
        const cacheData = {
          statusCode: 200,
          body: data,
          timestamp: Date.now(),
          tags: entry.tags || [],
        };

        const cacheKey = `${this.keyPrefix}${entry.key}`;
        await this.redis.setex(cacheKey, entry.ttl, JSON.stringify(cacheData));

        if (entry.tags && entry.tags.length > 0) {
          await storeCacheTags(this.redis, cacheKey, entry.tags, entry.ttl);
        }
      } catch (error) {
        console.error(`Cache warming failed for key ${entry.key}:`, error);
      }
    });

    await Promise.all(promises);
  }
}

/**
 * Express middleware to add cache control headers
 */
export function cacheControlHeaders(maxAge: number = 300) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  };
}

/**
 * Conditional cache middleware
 * Only caches when specific conditions are met
 */
export function conditionalCache(
  config: CacheConfig,
  condition: (req: Request) => boolean,
  options: CacheOptions = {},
) {
  const cache = createQueryCache(config);

  return (req: Request, res: Response, next: NextFunction) => {
    if (condition(req)) {
      return cache(options)(req, res, next);
    }
    next();
  };
}
