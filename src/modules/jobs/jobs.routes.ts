import { FastifyPluginAsync } from 'fastify';
import { requireApproved } from '../../plugins/require-approved.plugin.js';
import {
  listJobsHandler,
  getJobHandler,
  updateJobStatusHandler,
} from './jobs.controller.js';

const jobsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── List jobs for current shop ──
  fastify.get('/shops/me/jobs', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listJobsHandler,
  });

  // ── Get single job ──
  fastify.get('/jobs/:jobId', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: getJobHandler,
  });

  // ── Update job status ──
  fastify.patch('/jobs/:jobId/status', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: updateJobStatusHandler,
  });
};

export default jobsRoutes;
