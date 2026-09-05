import { FastifyPluginAsync } from 'fastify';
import { requireApproved } from '../../plugins/require-approved.plugin.js';
import {
  cloudinarySignatureHandler,
  addJobMediaHandler,
  listJobMediaHandler,
} from './media.controller.js';

const mediaRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Cloudinary signature (for direct upload from client) ──
  // NOTE: Only requires authentication (not approval) so onboarding shops can upload documents
  fastify.post('/media/cloudinary/signature', {
    preHandler: [fastify.authenticate],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: cloudinarySignatureHandler,
  });

  // ── Store media for a job ──
  fastify.post('/jobs/:jobId/media', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: addJobMediaHandler,
  });

  // ── List media for a job ──
  fastify.get('/jobs/:jobId/media', {
    preHandler: [fastify.authenticate, requireApproved],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: listJobMediaHandler,
  });
};

export default mediaRoutes;
