import { z } from 'zod';

// ── Query schemas ──

export const listRequestsQuerySchema = z.object({
  status: z.enum(['LIVE', 'HISTORY']).default('LIVE'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// ── Params schemas ──

export const requestIdParamsSchema = z.object({
  requestId: z.string().uuid(),
});

export const dispatchIdParamsSchema = z.object({
  dispatchId: z.string().uuid(),
});

// ── Offer body schema ──

export const createOfferBodySchema = z.object({
  priceCents: z.number().int().positive(),
  etaMinutes: z.number().int().positive(),
  warrantyDays: z.number().int().min(0).default(0),
  partsQuality: z.enum(['AFTERMARKET', 'PREMIUM', 'ORIGINAL']).default('AFTERMARKET'),
  note: z.string().max(1000).optional(),
  reserveInventoryItemId: z.string().uuid().optional(),
});
