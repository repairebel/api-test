import { performance } from 'node:perf_hooks';
import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { recordRequest, recordRequestFailure } from '../lib/http-telemetry.js';

const telemetryPlugin: FastifyPluginAsync = async (fastify) => {
  const starts = new WeakMap<object, number>();

  fastify.addHook('onRequest', async (request) => {
    starts.set(request, performance.now());
  });

  fastify.addHook('onError', async (request, _reply, error) => {
    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400
      ? error.statusCode
      : 500;
    if (statusCode < 500) return;
    recordRequestFailure({
      method: request.method,
      route: request.routeOptions?.url || request.url,
      statusCode,
      code: typeof error.code === 'string' ? error.code.slice(0, 60) : undefined,
    });
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const startedAt = starts.get(request) ?? performance.now();
    recordRequest({
      durationMs: Math.max(0, performance.now() - startedAt),
      method: request.method,
      route: request.routeOptions?.url || request.url,
      statusCode: reply.statusCode,
    });
  });
};

export default fp(telemetryPlugin, { name: 'telemetry' });
