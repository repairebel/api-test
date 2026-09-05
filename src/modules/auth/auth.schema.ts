import { z } from 'zod';

// ---------- Request Schemas ----------

/** Shop owner signup (creates user + shop + membership) */
export const signupShopBodySchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .max(255)
    .transform((v) => v.toLowerCase().trim()),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
  shopName: z
    .string()
    .min(1, 'Shop name is required')
    .max(255, 'Shop name must be at most 255 characters')
    .trim(),
});

/** Backward compat alias */
export const signupBodySchema = signupShopBodySchema;

/** Customer signup (creates user only) */
export const signupCustomerBodySchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(255, 'Name must be at most 255 characters')
    .trim(),
  email: z
    .string()
    .email('Invalid email address')
    .max(255)
    .transform((v) => v.toLowerCase().trim()),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
  phone: z
    .string()
    .max(20, 'Phone must be at most 20 characters')
    .optional(),
});

export const loginBodySchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .max(255)
    .transform((v) => v.toLowerCase().trim()),
  password: z.string().min(1, 'Password is required'),
  expectedUserType: z
    .enum(['CUSTOMER', 'SHOP_OWNER', 'ADMIN'])
    .optional(),
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const logoutBodySchema = z.object({
  refreshToken: z.string().optional(),
});

export const forgotPasswordBodySchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .max(255)
    .transform((v) => v.toLowerCase().trim()),
  expectedUserType: z
    .enum(['CUSTOMER', 'SHOP_OWNER', 'ADMIN'])
    .optional(),
});

export const resetPasswordBodySchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
});

// ---------- Inferred Types ----------

export type SignupShopBody = z.infer<typeof signupShopBodySchema>;
/** Backward compat alias */
export type SignupBody = SignupShopBody;
export type SignupCustomerBody = z.infer<typeof signupCustomerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type RefreshBody = z.infer<typeof refreshBodySchema>;
export type LogoutBody = z.infer<typeof logoutBodySchema>;
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBodySchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;
