import { FastifyRequest, FastifyReply } from 'fastify';
import {
  listRequestsQuerySchema,
  requestIdParamsSchema,
  dispatchIdParamsSchema,
  createOfferBodySchema,
} from './requests.schema.js';
import { createCustomerRequestBodySchema } from './customer-requests.schema.js';
import { z } from 'zod';
import {
  listShopRequests,
  getRequestForShop,
  markDispatchSeen,
  createOffer,
  createTestRequest,
  customerAcceptOffer,
  findNearbyShops,
  getOffersForRequest,
  getRequestStatus,
} from './requests.service.js';
import {
  successResponse,
  paginatedResponse,
} from '../../plugins/error-handler.plugin.js';

// GET /v1/shops/me/requests?status=LIVE|HISTORY&page=1&pageSize=20
export async function listRequestsHandler(request: FastifyRequest, reply: FastifyReply) {
  const query = listRequestsQuerySchema.parse(request.query);
  const shopId = request.user!.shopId;

  const { data, total } = await listShopRequests(shopId, query.status, query.page, query.pageSize);

  return reply.send(
    paginatedResponse(data, {
      page: query.page,
      pageSize: query.pageSize,
      total,
    }),
  );
}

// GET /v1/requests/:requestId
export async function getRequestHandler(request: FastifyRequest, reply: FastifyReply) {
  const { requestId } = requestIdParamsSchema.parse(request.params);
  const shopId = request.user!.shopId;

  const result = await getRequestForShop(requestId, shopId);
  return reply.send(successResponse(result));
}

// POST /v1/dispatch/:dispatchId/seen
export async function markSeenHandler(request: FastifyRequest, reply: FastifyReply) {
  const { dispatchId } = dispatchIdParamsSchema.parse(request.params);
  const shopId = request.user!.shopId;

  const result = await markDispatchSeen(dispatchId, shopId);
  return reply.send(successResponse(result));
}

// POST /v1/requests/:requestId/offers
export async function createOfferHandler(request: FastifyRequest, reply: FastifyReply) {
  const { requestId } = requestIdParamsSchema.parse(request.params);
  const body = createOfferBodySchema.parse(request.body);
  const shopId = request.user!.shopId;

  const result = await createOffer(requestId, shopId, body);
  return reply.status(201).send(successResponse(result));
}

// POST /v1/test/create-request (no auth — for testing only)
export async function createTestRequestHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = createCustomerRequestBodySchema.extend({
    customerName: z.string().min(1).max(255),
    shopId: z.string().uuid(),
    distanceKm: z.number().nonnegative().optional(),
  }).parse(request.body);
  const result = await createTestRequest(body);
  return reply.status(201).send(successResponse(result));
}

// POST /v1/test/accept-offer (no auth — simulates customer accepting)
export async function customerAcceptOfferHandler(request: FastifyRequest, reply: FastifyReply) {
  const { offerId } = request.body as { offerId: string };
  const result = await customerAcceptOffer(offerId);
  return reply.send(successResponse(result));
}

// GET /v1/test/nearby-shops?lat=40.7128&lng=-74.0060&radius=50
export async function nearbyShopsHandler(request: FastifyRequest, reply: FastifyReply) {
  const { lat, lng, radius } = request.query as { lat: string; lng: string; radius?: string };
  const result = await findNearbyShops(parseFloat(lat), parseFloat(lng), radius ? parseFloat(radius) : undefined);
  return reply.send(successResponse(result));
}

// GET /v1/test/requests/:requestId/offers
export async function requestOffersHandler(request: FastifyRequest, reply: FastifyReply) {
  const { requestId } = request.params as { requestId: string };
  const result = await getOffersForRequest(requestId);
  return reply.send(successResponse(result));
}

// GET /v1/test/requests/:requestId
export async function requestStatusHandler(request: FastifyRequest, reply: FastifyReply) {
  const { requestId } = request.params as { requestId: string };
  const result = await getRequestStatus(requestId);
  return reply.send(successResponse(result));
}
