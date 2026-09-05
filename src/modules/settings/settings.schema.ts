import { z } from 'zod';

// ── GET /v1/shops/me/profile ── (no body)

// ── PATCH /v1/shops/me/warranty ──

const partWarrantyOverrideSchema = z.object({
  partType: z.string().min(1).max(100),
  days: z.number().int().min(0).max(3650),
  enabled: z.boolean(),
});

export const updateWarrantyBodySchema = z.object({
  warrantyEnabled: z.boolean().optional(),
  defaultWarrantyDays: z.number().int().min(1).max(3650).optional(),
  perPartWarrantyOverrides: z.array(partWarrantyOverrideSchema).max(20).optional(),
  warrantyPolicyText: z.string().max(5000).optional().or(z.literal('')),
});

export type UpdateWarrantyBody = z.infer<typeof updateWarrantyBodySchema>;

// ── PATCH /v1/shops/me/vacation ──

export const updateVacationBodySchema = z.object({
  vacationMode: z.boolean(),
});

export type UpdateVacationBody = z.infer<typeof updateVacationBodySchema>;

// ── PATCH /v1/shops/me/notifications ──

export const updateNotificationsBodySchema = z.object({
  notificationSound: z.boolean().optional(),
  notificationVibration: z.boolean().optional(),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional().nullable(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional().nullable(),
});

export type UpdateNotificationsBody = z.infer<typeof updateNotificationsBodySchema>;

// ── PATCH /v1/shops/me/location (extended with city/state/zip/country) ──

export const updateLocationExtBodySchema = z.object({
  address: z.string().min(1).max(500),
  city: z.string().max(100).optional().or(z.literal('')),
  state: z.string().max(100).optional().or(z.literal('')),
  zipCode: z.string().max(20).optional().or(z.literal('')),
  country: z.string().max(100).optional().or(z.literal('')),
  latitude: z.string().min(1).max(20),
  longitude: z.string().min(1).max(20),
  placeId: z.string().max(300).optional(),
});

export type UpdateLocationExtBody = z.infer<typeof updateLocationExtBodySchema>;

// ── POST /v1/stripe/connect/start ── (no body)

export const startStripeConnectBodySchema = z.object({
  returnUrl: z.string().min(1).max(2000).optional(),
  refreshUrl: z.string().min(1).max(2000).optional(),
});

export type StartStripeConnectBody = z.infer<typeof startStripeConnectBodySchema>;

// ── GET /v1/stripe/connect/status ── (no body)
