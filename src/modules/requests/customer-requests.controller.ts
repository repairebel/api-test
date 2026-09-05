import { FastifyRequest, FastifyReply } from 'fastify';
import {
  searchDeviceModelsQuerySchema,
  customerMediaSignatureBodySchema,
  createCustomerRequestBodySchema,
  listCustomerRequestsQuerySchema,
  customerRequestIdParamsSchema,
  priceEstimateQuerySchema,
  offerIdParamsSchema,
  listCustomerJobsQuerySchema,
  customerJobIdParamsSchema,
  confirmJobBodySchema,
  issueTypesQuerySchema,
} from './customer-requests.schema.js';
import {
  searchDeviceModels,
  getDistinctBrands,
  getCustomerMediaSignature,
  createCustomerRequest,
  listCustomerRequests,
  getCustomerRequestDetail,
  getPriceEstimate,
  acceptOffer,
  confirmOfferPayment,
  rejectOffer,
  cancelCustomerRequest,
  listCustomerJobs,
  getCustomerJobDetail,
  confirmCustomerJob,
  updateJobPaymentMethod,
} from './customer-requests.service.js';
import { findNearbyShops } from './requests.service.js';
import { getDatasetIssues } from '../pricing/pricing.service.js';
import {
  successResponse,
  paginatedResponse,
  AppError,
  ErrorCode,
} from '../../plugins/error-handler.plugin.js';

// GET /v1/issue-types
export async function issueTypesHandler(request: FastifyRequest, reply: FastifyReply) {
  const query = issueTypesQuerySchema.parse(request.query);
  return reply.send(successResponse(await getDatasetIssues(query.deviceModelId)));
}

// GET /v1/device-models/brands
export async function deviceBrandsHandler(_request: FastifyRequest, reply: FastifyReply) {
  const brands = await getDistinctBrands();
  return reply.send(successResponse(brands));
}

// GET /v1/device-models?brand=&query=&limit=
export async function searchDeviceModelsHandler(request: FastifyRequest, reply: FastifyReply) {
  const query = searchDeviceModelsQuerySchema.parse(request.query);
  const results = await searchDeviceModels(query.query, query.brand, query.limit, query.supportedOnly === 'true');
  return reply.send(successResponse(results));
}

// POST /v1/customer/media/cloudinary/signature
export async function customerMediaSignatureHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const body = customerMediaSignatureBodySchema.parse(request.body);
  const result = getCustomerMediaSignature(
    request.user.userId,
    body.resourceType,
    body.tempId,
  );
  return reply.send(successResponse(result));
}

// POST /v1/customer/requests
export async function createCustomerRequestHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const body = createCustomerRequestBodySchema.parse(request.body);
  const result = await createCustomerRequest(request.user.userId, body);
  return reply.status(201).send(successResponse(result));
}

// GET /v1/customer/requests
export async function listCustomerRequestsHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const query = listCustomerRequestsQuerySchema.parse(request.query);
  const { data, total } = await listCustomerRequests(
    request.user.userId,
    query.status,
    query.page,
    query.pageSize,
  );

  return reply.send(
    paginatedResponse(data, {
      page: query.page,
      pageSize: query.pageSize,
      total,
    }),
  );
}

// GET /v1/customer/requests/:requestId
export async function getCustomerRequestHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const { requestId } = customerRequestIdParamsSchema.parse(request.params);
  const result = await getCustomerRequestDetail(requestId, request.user.userId);
  return reply.send(successResponse(result));
}

// GET /v1/price-estimate
export async function priceEstimateHandler(request: FastifyRequest, reply: FastifyReply) {
  const query = priceEstimateQuerySchema.parse(request.query);
  const result = await getPriceEstimate(query);
  return reply.send(successResponse(result));
}

// POST /v1/customer/offers/:offerId/accept
export async function acceptOfferHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const { offerId } = offerIdParamsSchema.parse(request.params);
  const result = await acceptOffer(offerId, request.user.userId);
  return reply.send(successResponse(result));
}

// POST /v1/customer/offers/:offerId/confirm-payment (after 3DS)
export async function confirmOfferPaymentHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const { offerId } = offerIdParamsSchema.parse(request.params);
  const { stripePaymentIntentId } = request.body as { stripePaymentIntentId: string };
  if (!stripePaymentIntentId) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'stripePaymentIntentId is required');
  }
  const result = await confirmOfferPayment(offerId, request.user.userId, stripePaymentIntentId);
  return reply.send(successResponse(result));
}

// POST /v1/customer/offers/:offerId/reject
export async function rejectOfferHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const { offerId } = offerIdParamsSchema.parse(request.params);
  const result = await rejectOffer(offerId, request.user.userId);
  return reply.send(successResponse(result));
}

// POST /v1/customer/requests/:requestId/cancel
export async function cancelRequestHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const { requestId } = customerRequestIdParamsSchema.parse(request.params);
  const result = await cancelCustomerRequest(requestId, request.user.userId);
  return reply.send(successResponse(result));
}

// GET /v1/customer/jobs
export async function listCustomerJobsHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const query = listCustomerJobsQuerySchema.parse(request.query);
  const { data, total } = await listCustomerJobs(
    request.user.userId,
    query.status,
    query.page,
    query.pageSize,
  );

  return reply.send(
    paginatedResponse(data, {
      page: query.page,
      pageSize: query.pageSize,
      total,
    }),
  );
}

// GET /v1/customer/jobs/:jobId
export async function getCustomerJobHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const { jobId } = customerJobIdParamsSchema.parse(request.params);
  const result = await getCustomerJobDetail(jobId, request.user.userId);
  return reply.send(successResponse(result));
}

// POST /v1/customer/jobs/:jobId/confirm
export async function confirmJobHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const { jobId } = customerJobIdParamsSchema.parse(request.params);
  const body = confirmJobBodySchema.parse(request.body ?? {});
  const result = await confirmCustomerJob(jobId, request.user.userId, body.rating, body.reviewText);
  return reply.send(successResponse(result));
}

// POST /v1/customer/jobs/:jobId/update-payment
export async function updatePaymentMethodHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const { jobId } = customerJobIdParamsSchema.parse(request.params);
  const result = await updateJobPaymentMethod(jobId, request.user.userId);
  return reply.send(successResponse(result));
}

// GET /v1/customer/nearby-shops?lat=...&lng=...&radius=...
export async function customerNearbyShopsHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.userType !== 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a customer account');
  }

  const { lat, lng, radius } = request.query as { lat?: string; lng?: string; radius?: string };
  if (!lat || !lng) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'lat and lng query parameters are required');
  }

  const result = await findNearbyShops(parseFloat(lat), parseFloat(lng), radius ? parseFloat(radius) : 50);
  return reply.send(successResponse(result));
}
