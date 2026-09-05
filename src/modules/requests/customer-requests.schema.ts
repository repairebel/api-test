import { z } from 'zod';

// GET /v1/device-models?brand=&query=
export const searchDeviceModelsQuerySchema = z.object({
  brand: z.string().optional(),
  query: z.string().optional().default(''),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  supportedOnly: z.enum(['true', 'false']).optional().default('true'),
});

// POST /v1/customer/media/cloudinary/signature
export const customerMediaSignatureBodySchema = z.object({
  resourceType: z.enum(['image', 'video']),
  tempId: z.string().uuid().optional(),
});

// POST /v1/customer/requests
export const createCustomerRequestBodySchema = z.object({
  deviceModelId: z.string().uuid(),
  catalogVersion: z.string().min(1).max(100).optional(),
  deviceBrand: z.string().min(1).max(100),
  deviceModel: z.string().min(1).max(255),
  issueType: z.string().min(1).max(50),
  issueDescription: z.string().max(5000).optional().default(''),
  photos: z.array(z.string().url()).max(10).default([]),
  videoUrl: z.string().url().optional(),
  customerOfferCents: z.number().int().positive().max(2147483647),
  latitude: z.string().min(1),
  longitude: z.string().min(1),
  address: z.string().min(1).max(1000),
  dispatchRadiusMiles: z.coerce.number().int().min(1).max(90).optional().default(25),
});

// GET /v1/customer/requests
export const listCustomerRequestsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'HISTORY']).optional().default('ACTIVE'),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
});

// GET /v1/customer/requests/:requestId
export const customerRequestIdParamsSchema = z.object({
  requestId: z.string().uuid(),
});

// GET /v1/price-estimate?deviceBrand=&issueType=&lat=&lng=
export const priceEstimateQuerySchema = z.object({
  deviceModelId: z.string().uuid(),
  deviceBrand: z.string().min(1).max(100).optional(),
  deviceModel: z.string().min(1).max(255).optional(),
  issueType: z.string().min(1).max(50),
  lat: z.string().optional(),
  lng: z.string().optional(),
});

export const issueTypesQuerySchema = z.object({ deviceModelId: z.string().uuid().optional() });

// POST /v1/customer/offers/:offerId/accept
export const offerIdParamsSchema = z.object({
  offerId: z.string().uuid(),
});

// GET /v1/customer/jobs
export const listCustomerJobsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'COMPLETED']).optional().default('ACTIVE'),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
});

// GET /v1/customer/jobs/:jobId
export const customerJobIdParamsSchema = z.object({
  jobId: z.string().uuid(),
});

// POST /v1/customer/jobs/:jobId/confirm
export const confirmJobBodySchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  reviewText: z.string().max(2000).optional(),
});
