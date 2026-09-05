import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';
import { logAudit } from './admin.audit.helper.js';
import {
  listJobs,
  getJobById,
  getJobEvents,
  getJobMedia,
  cancelJob,
} from './admin.jobs.service.js';

const jobsRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/jobs', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const q = req.query as any;
      const result = await listJobs({
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        search: q.search,
        status: q.status,
      });
      return reply.send(paginatedResponse(result.data, result.pagination));
    },
  });

  fastify.get('/admin/jobs/:jobId', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const job = await getJobById(jobId);
      return reply.send(successResponse(job));
    },
  });

  fastify.get('/admin/jobs/:jobId/events', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const events = await getJobEvents(jobId);
      return reply.send(successResponse(events));
    },
  });

  fastify.get('/admin/jobs/:jobId/media', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const media = await getJobMedia(jobId);
      return reply.send(successResponse(media));
    },
  });

  fastify.post('/admin/jobs/:jobId/cancel', {
    preHandler: auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const result = await cancelJob(jobId);
      await logAudit(req.user!.userId, `Cancelled job ${jobId}`, 'order', jobId);
      return reply.send(successResponse(result));
    },
  });
};

export default jobsRoutes;
