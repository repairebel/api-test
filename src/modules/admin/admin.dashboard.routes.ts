import { FastifyPluginAsync } from 'fastify';
import { requireUserType } from '../../plugins/auth.plugin.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import {
  getDashboardStats,
  getWeeklyRevenue,
  getJobsByCategory,
  getJobStatusChart,
  getActivityFeed,
} from './admin.dashboard.service.js';

const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = [fastify.authenticate, requireUserType('ADMIN')];

  fastify.get('/admin/dashboard', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      const stats = await getDashboardStats();
      return reply.send(successResponse(stats));
    },
  });

  fastify.get('/admin/dashboard/weekly-revenue', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      const data = await getWeeklyRevenue();
      return reply.send(successResponse(data));
    },
  });

  fastify.get('/admin/dashboard/jobs-by-category', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      const data = await getJobsByCategory();
      return reply.send(successResponse(data));
    },
  });

  fastify.get('/admin/dashboard/job-status-chart', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      const data = await getJobStatusChart();
      return reply.send(successResponse(data));
    },
  });

  fastify.get('/admin/dashboard/activity-feed', {
    preHandler: auth,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
      const data = await getActivityFeed();
      return reply.send(successResponse(data));
    },
  });
};

export default dashboardRoutes;
