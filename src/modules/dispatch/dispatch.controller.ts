import { FastifyRequest, FastifyReply } from 'fastify';
import {
  startDispatch,
  acceptDispatch,
  declineDispatch,
} from './dispatch.service.js';
import { successResponse } from '../../plugins/error-handler.plugin.js';

// POST /v1/dispatch/start (test endpoint — simulates customer app)
export async function startDispatchHandler(request: FastifyRequest, reply: FastifyReply) {
  const { requestId } = request.body as { requestId: string };
  const result = await startDispatch(requestId);
  return reply.status(201).send(successResponse(result));
}

// POST /v1/dispatch/:dispatchId/accept
export async function acceptDispatchHandler(request: FastifyRequest, reply: FastifyReply) {
  const { dispatchId } = request.params as { dispatchId: string };
  const shopId = request.user!.shopId;
  const result = await acceptDispatch(dispatchId, shopId);
  return reply.send(successResponse(result));
}

// POST /v1/dispatch/:dispatchId/decline
export async function declineDispatchHandler(request: FastifyRequest, reply: FastifyReply) {
  const { dispatchId } = request.params as { dispatchId: string };
  const shopId = request.user!.shopId;
  const result = await declineDispatch(dispatchId, shopId);
  return reply.send(successResponse(result));
}
