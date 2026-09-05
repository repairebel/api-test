import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { redis } from '../lib/redis.js';
import { AppError, ErrorCode } from './error-handler.plugin.js';

const IDEMPOTENCY_TTL = 86_400; // 24 hours in seconds
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const idempotencyPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const key = request.headers['idempotency-key'] as string | undefined;
    if (!key || !MUTATING_METHODS.has(request.method)) return;

    const cacheKey = `idem:${key}:${request.method}:${request.url}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      const parsed = JSON.parse(cached);

      // Verify the request fingerprint matches
      const bodyHash = JSON.stringify(request.body ?? {});
      if (parsed.bodyHash !== bodyHash) {
        throw new AppError(
          422,
          ErrorCode.IDEMPOTENCY_MISMATCH,
          'Idempotency-Key has already been used with a different request body',
        );
      }

      // Return the cached response
      reply.status(parsed.statusCode).send(parsed.body);
      return reply; // Short-circuit
    }

    // Store the key for caching after the response is sent
    (request as any).__idempotencyKey = cacheKey;
    (request as any).__idempotencyBodyHash = JSON.stringify(request.body ?? {});
  });

  fastify.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: string) => {
    const cacheKey = (request as any).__idempotencyKey as string | undefined;
    if (!cacheKey) return payload;

    const cacheValue = JSON.stringify({
      statusCode: reply.statusCode,
      body: JSON.parse(payload),
      bodyHash: (request as any).__idempotencyBodyHash,
    });

    await redis.set(cacheKey, cacheValue, 'EX', IDEMPOTENCY_TTL);
    return payload;
  });
};

export default fp(idempotencyPlugin, { name: 'idempotency' });
