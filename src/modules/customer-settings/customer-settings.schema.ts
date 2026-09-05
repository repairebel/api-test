import { z } from 'zod';

// ── Profile ──

export const updateProfileBodySchema = z.object({
  fullName: z.string().min(1).max(255).trim().optional(),
  phone: z.string().max(20).optional(),
  avatarUrl: z.string().url().optional().nullable(),
});
export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;

// ── Security ──

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(128),
});
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;

export const changeEmailBodySchema = z.object({
  newEmail: z.string().email('Invalid email').max(255).transform(v => v.toLowerCase().trim()),
  password: z.string().min(1, 'Password is required for verification'),
});
export type ChangeEmailBody = z.infer<typeof changeEmailBodySchema>;

// ── Addresses ──

export const createAddressBodySchema = z.object({
  label: z.string().min(1).max(50).trim(),
  address: z.string().min(1).max(500).trim(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  zipCode: z.string().max(20).optional(),
  country: z.string().max(100).optional(),
  placeId: z.string().max(100).optional(),
  isDefault: z.boolean().optional(),
});
export type CreateAddressBody = z.infer<typeof createAddressBodySchema>;

export const updateAddressBodySchema = z.object({
  label: z.string().min(1).max(50).trim().optional(),
  address: z.string().min(1).max(500).trim().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  zipCode: z.string().max(20).optional(),
  country: z.string().max(100).optional(),
  placeId: z.string().max(100).optional(),
  isDefault: z.boolean().optional(),
});
export type UpdateAddressBody = z.infer<typeof updateAddressBodySchema>;

// ── Notifications ──

export const updateNotificationPrefsBodySchema = z.object({
  offers: z.boolean().optional(),
  messages: z.boolean().optional(),
  orderUpdates: z.boolean().optional(),
  payments: z.boolean().optional(),
  reviews: z.boolean().optional(),
  promotions: z.boolean().optional(),
});
export type UpdateNotificationPrefsBody = z.infer<typeof updateNotificationPrefsBodySchema>;

// ── Privacy ──

export const updatePrivacyBodySchema = z.object({
  shareUsage: z.boolean().optional(),
  shareLocation: z.boolean().optional(),
  shareRepairHistory: z.boolean().optional(),
});
export type UpdatePrivacyBody = z.infer<typeof updatePrivacyBodySchema>;

// ── Account ──

export const deleteAccountBodySchema = z.object({
  password: z.string().min(1, 'Password is required to delete account'),
});
export type DeleteAccountBody = z.infer<typeof deleteAccountBodySchema>;

// ── Payment Methods ──

export const confirmSetupBodySchema = z.object({
  setupIntentId: z.string().min(1),
});
export type ConfirmSetupBody = z.infer<typeof confirmSetupBodySchema>;

export const confirmWithTokenBodySchema = z.object({
  setupIntentId: z.string().min(1),
  cardToken: z.string().min(1),
});
export type ConfirmWithTokenBody = z.infer<typeof confirmWithTokenBodySchema>;

// ── Support Chat ──

export const supportChatBodySchema = z.object({
  message: z.string().min(1).max(2000).trim(),
  conversationId: z.string().uuid().optional(),
});
export type SupportChatBody = z.infer<typeof supportChatBodySchema>;
