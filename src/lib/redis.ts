import Redis from 'ioredis';
import { env } from '../config/env.js';
import { getRedisConnectionOptions } from './redis-config.js';

export const redis = new Redis({
  ...getRedisConnectionOptions(env.REDIS_URL),
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err.message);
});

redis.on('connect', () => {
  console.log('✅ Redis connected');
});
