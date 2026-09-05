import { FastifyRequest, FastifyReply } from 'fastify';
import {
  generateCloudinarySignature,
  addJobMedia,
  listJobMedia,
} from './media.service.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';

// POST /v1/media/cloudinary/signature
export async function cloudinarySignatureHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = (request.body || {}) as {
    context?: 'JOB_PROOF' | 'CHAT' | 'ONBOARDING' | 'DISPUTE_EVIDENCE' | 'SUPPORT_CHAT';
    jobId?: string;
    resourceType?: 'image' | 'video';
  };

  const context = body.context;
  const jobId = body.jobId;
  const resourceType = body.resourceType || 'image';

  if (!['image', 'video'].includes(resourceType)) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'resourceType must be image or video' },
    });
  }

  // If context is ONBOARDING or no context provided, use legacy onboarding signature
  if (!context || context === 'ONBOARDING') {
    const shopId = request.user!.shopId;
    const result = generateCloudinarySignature({
      context: 'ONBOARDING',
      entityId: shopId,
      resourceType,
    });
    return reply.send(successResponse(result));
  }

  if (!['JOB_PROOF', 'CHAT', 'DISPUTE_EVIDENCE', 'SUPPORT_CHAT'].includes(context)) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'context must be JOB_PROOF, CHAT, ONBOARDING, DISPUTE_EVIDENCE, or SUPPORT_CHAT' },
    });
  }

  if (!jobId) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'jobId/conversationId is required for this context' },
    });
  }

  const result = generateCloudinarySignature({ context, entityId: jobId, resourceType });
  return reply.send(successResponse(result));
}

// POST /v1/jobs/:jobId/media
export async function addJobMediaHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const shopId = request.user!.shopId;
  const { type, url, publicId, thumbUrl, durationMs, sizeBytes, mimeType } = request.body as {
    type: 'IMAGE' | 'VIDEO';
    url: string;
    publicId: string;
    thumbUrl?: string;
    durationMs?: number;
    sizeBytes?: number;
    mimeType?: string;
  };

  if (!type || !url || !publicId) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'type, url, and publicId are required' },
    });
  }

  if (!['IMAGE', 'VIDEO'].includes(type)) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'type must be IMAGE or VIDEO' },
    });
  }

  const result = await addJobMedia({
    jobId,
    shopId,
    type,
    url,
    publicId,
    thumbUrl,
    durationMs,
    sizeBytes,
    mimeType,
  });

  return reply.code(201).send(successResponse(result));
}

// GET /v1/jobs/:jobId/media
export async function listJobMediaHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const shopId = request.user!.shopId;
  const media = await listJobMedia(jobId, shopId);
  return reply.send(successResponse(media));
}
