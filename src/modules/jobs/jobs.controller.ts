import { FastifyRequest, FastifyReply } from 'fastify';
import {
  listShopJobs,
  getJobForShop,
  updateJobStatus,
} from './jobs.service.js';
import { successResponse, paginatedResponse } from '../../plugins/error-handler.plugin.js';

// GET /v1/shops/me/jobs?status=BOOKED&page=1&pageSize=20
export async function listJobsHandler(request: FastifyRequest, reply: FastifyReply) {
  const shopId = request.user!.shopId;
  const { status, page = '1', pageSize = '20' } = request.query as Record<string, string>;

  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(50, Math.max(1, parseInt(pageSize, 10) || 20));

  const { data, total } = await listShopJobs(shopId, status, p, ps);
  return reply.send(paginatedResponse(data, { page: p, pageSize: ps, total }));
}

// GET /v1/jobs/:jobId
export async function getJobHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const shopId = request.user!.shopId;
  const job = await getJobForShop(jobId, shopId);
  return reply.send(successResponse(job));
}

// PATCH /v1/jobs/:jobId/status
export async function updateJobStatusHandler(request: FastifyRequest, reply: FastifyReply) {
  const { jobId } = request.params as { jobId: string };
  const shopId = request.user!.shopId;
  const { status, note } = request.body as { status: string; note?: string };
  const result = await updateJobStatus(jobId, shopId, status as any, note);
  return reply.send(successResponse(result));
}
