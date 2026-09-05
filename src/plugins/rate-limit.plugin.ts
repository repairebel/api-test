import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { redis } from '../lib/redis.js';

const rateLimitPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    redis,
    keyGenerator: (request) => {
      // Use X-Forwarded-For if behind a proxy, otherwise IP
      return request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
        ?? request.ip;
    },
    errorResponseBuilder: (_request, context) => ({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: `Too many requests. Limit: ${context.max} per ${context.after}`,
      },
    }),
  });
};

export default fp(rateLimitPlugin, { name: 'rate-limit' });
