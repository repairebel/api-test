import { FastifyRequest, FastifyReply } from 'fastify';
import {
  createDispute,
  listShopDisputes,
  listCustomerDisputes,
  getDisputeDetail,
  shopRespondToDispute,
  customerRespondToDispute,
} from './disputes.service.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';
import { generateCloudinarySignature } from '../media/media.service.js';

// ════════════════════════════════════════════════
// CUSTOMER HANDLERS
// ════════════════════════════════════════════════

// POST /v1/jobs/:jobId/disputes
export async function customerCreateDisputeHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const customerId = request.user!.userId;
  const { reasonCode, description, evidenceUrls, disputeVideoUrl, disputeVideoDurationMs } = request.body as {
    reasonCode: string;
    description: string;
    evidenceUrls?: string[];
    disputeVideoUrl?: string;
    disputeVideoDurationMs?: number;
  };

  if (!reasonCode || !description) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'reasonCode and description are required' },
    });
  }

  const dispute = await createDispute(jobId, customerId, {
    reasonCode: reasonCode as any,
    description,
    evidenceUrls,
    disputeVideoUrl,
    disputeVideoDurationMs,
  });

  return reply.code(201).send(successResponse(dispute));
}

// GET /v1/customer/disputes
export async function customerListDisputesHandler(request: FastifyRequest, reply: FastifyReply) {
  const customerId = request.user!.userId;
  const result = await listCustomerDisputes(customerId);
  return reply.send(successResponse(result));
}

// GET /v1/customer/disputes/:disputeId
export async function customerGetDisputeDetailHandler(request: FastifyRequest, reply: FastifyReply) {
  const { disputeId } = request.params as { disputeId: string };
  const customerId = request.user!.userId;
  const result = await getDisputeDetail(disputeId, customerId, 'CUSTOMER');
  return reply.send(successResponse(result));
}

// POST /v1/customer/disputes/:disputeId/respond
export async function customerRespondHandler(request: FastifyRequest, reply: FastifyReply) {
  const { disputeId } = request.params as { disputeId: string };
  const customerId = request.user!.userId;
  const { message, evidenceUrls } = request.body as { message: string; evidenceUrls?: string[] };

  if (!message) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'message is required' },
    });
  }

  const result = await customerRespondToDispute(disputeId, customerId, { message, evidenceUrls });
  return reply.code(201).send(successResponse(result));
}

// POST /v1/customer/disputes/video-signature  (pre-dispute, uses jobId)
export async function customerVideoSignatureHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = (request.body || {}) as { jobId?: string };

  if (!jobId) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'jobId is required' },
    });
  }

  const result = generateCloudinarySignature({
    context: 'DISPUTE_EVIDENCE',
    entityId: jobId,
    resourceType: 'video',
  });
  return reply.send(successResponse(result));
}

// POST /v1/customer/disputes/:disputeId/evidence-signature
export async function customerEvidenceSignatureHandler(request: FastifyRequest, reply: FastifyReply) {
  const { disputeId } = request.params as { disputeId: string };
  const { resourceType = 'image' } = (request.body || {}) as { resourceType?: 'image' | 'video' };

  if (!['image', 'video'].includes(resourceType)) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'resourceType must be image or video' },
    });
  }

  const result = generateCloudinarySignature({
    context: 'DISPUTE_EVIDENCE',
    entityId: disputeId,
    resourceType,
  });
  return reply.send(successResponse(result));
}

// ════════════════════════════════════════════════
// SHOP HANDLERS
// ════════════════════════════════════════════════

// GET /v1/shops/me/disputes
export async function shopListDisputesHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const { status } = request.query as { status?: string };
  const result = await listShopDisputes(shopId, status);
  return reply.send(successResponse(result));
}

// GET /v1/disputes/:disputeId
export async function shopGetDisputeDetailHandler(request: FastifyRequest, reply: FastifyReply) {
  const { disputeId } = request.params as { disputeId: string };
  const shopId = request.user!.shopId;
  const result = await getDisputeDetail(disputeId, shopId, 'SHOP');
  return reply.send(successResponse(result));
}

// POST /v1/disputes/:disputeId/respond
export async function shopRespondHandler(request: FastifyRequest, reply: FastifyReply) {
  const { disputeId } = request.params as { disputeId: string };
  const shopId = request.user!.shopId;
  const userId = request.user!.userId;
  const { message, evidenceUrls } = request.body as { message: string; evidenceUrls?: string[] };

  if (!message) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'message is required' },
    });
  }

  const result = await shopRespondToDispute(disputeId, shopId, userId, { message, evidenceUrls });
  return reply.code(201).send(successResponse(result));
}

// POST /v1/disputes/:disputeId/evidence-signature
export async function shopEvidenceSignatureHandler(request: FastifyRequest, reply: FastifyReply) {
  const { disputeId } = request.params as { disputeId: string };
  const { resourceType = 'image' } = (request.body || {}) as { resourceType?: 'image' | 'video' };

  if (!['image', 'video'].includes(resourceType)) {
    return reply.code(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'resourceType must be image or video' },
    });
  }

  const result = generateCloudinarySignature({
    context: 'DISPUTE_EVIDENCE',
    entityId: disputeId,
    resourceType,
  });
  return reply.send(successResponse(result));
}
