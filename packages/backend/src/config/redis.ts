import Redis from 'ioredis';
import { getEnv } from './env';

let redis: Redis | null = null;
let redisAvailable = false;

export function getRedis(): Redis | null {
  if (!redis) {
    try {
      const env = getEnv();
      redis = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 3000,
        lazyConnect: true,
        retryStrategy(times) {
          if (times > 3) return null; // Stop retrying after 3
          return Math.min(times * 200, 2000);
        },
      });

      redis.on('error', (err) => {
        if (redisAvailable) console.warn('[Redis] Connection lost:', err.message);
        redisAvailable = false;
      });

      redis.on('connect', () => {
        redisAvailable = true;
      });

      // Try to connect but don't block
      redis.connect().catch(() => {
        redisAvailable = false;
      });
    } catch (err) {
      console.warn('[Redis] Init failed, running without cache');
      return null;
    }
  }
  return redis;
}

// Helper: cache with TTL — gracefully returns null if Redis is down
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const r = getRedis();
    if (!r || !redisAvailable) return null;
    const val = await r.get(key);
    if (!val) return null;
    return JSON.parse(val) as T;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number = 300): Promise<void> {
  try {
    const r = getRedis();
    if (!r || !redisAvailable) return;
    await r.setex(key, ttlSeconds, JSON.stringify(value));
  } catch {
    // Cache write failure is non-fatal
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    const r = getRedis();
    if (!r || !redisAvailable) return;
    await r.del(key);
  } catch {}
}
