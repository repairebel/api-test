import { z } from 'zod';

// ── PATCH /v1/shops/me ──

export const updateShopBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  phone: z.string().max(30).optional(),
  website: z.string().url().max(500).optional().or(z.literal('')),
  description: z.string().max(2000).optional(),
  categories: z.array(z.string().min(1).max(50)).max(10).optional(),
  logoUrl: z.string().url().max(1000).optional().or(z.literal('')),
});

export type UpdateShopBody = z.infer<typeof updateShopBodySchema>;

// ── PATCH /v1/shops/me/location ──

export const updateLocationBodySchema = z.object({
  address: z.string().min(1).max(500),
  latitude: z.string().min(1).max(20),
  longitude: z.string().min(1).max(20),
  placeId: z.string().max(300).optional(),
});

export type UpdateLocationBody = z.infer<typeof updateLocationBodySchema>;

// ── PATCH /v1/shops/me/hours ──

const dayScheduleSchema = z.object({
  day: z.string().min(1),
  isOpen: z.boolean(),
  openTime: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
});

export const updateHoursBodySchema = z.object({
  hours: z.array(dayScheduleSchema).min(7).max(7),
});

export type UpdateHoursBody = z.infer<typeof updateHoursBodySchema>;

// ── PATCH /v1/shops/me/service-area ──

export const updateServiceAreaBodySchema = z.object({
  radiusKm: z.number().int().min(1).max(160),
  latitude: z.string().min(1).max(20),
  longitude: z.string().min(1).max(20),
});

export type UpdateServiceAreaBody = z.infer<typeof updateServiceAreaBodySchema>;

// ── POST /v1/onboarding/submit ──

export const submitOnboardingBodySchema = z
  .object({
    ownerFirstName: z.string().min(1).max(100),
    ownerLastName: z.string().min(1).max(100),
    ownerDob: z.string().min(1).max(20), // MM/DD/YYYY
    llcDocumentUrls: z.array(z.string().url()).optional().default([]),
    incorporationDocUrl: z.string().url().optional(),
    businessLicenseUrl: z.string().url().optional(),
    idDocumentUrl: z.string().url(),
  })
  .refine(
    (data) =>
      (data.llcDocumentUrls && data.llcDocumentUrls.length > 0) ||
      data.incorporationDocUrl ||
      data.businessLicenseUrl,
    { message: 'At least one business document (LLC, incorporation, or license) is required' },
  );

export type SubmitOnboardingBody = z.infer<typeof submitOnboardingBodySchema>;

// ── POST /v1/admin/onboarding/:shopId/reject ──

export const adminRejectBodySchema = z.object({
  reason: z.string().min(1).max(1000),
});

export type AdminRejectBody = z.infer<typeof adminRejectBodySchema>;
