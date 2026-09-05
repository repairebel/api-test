import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db } from '../../db/client.js';
import { shops, onboardingSubmissions } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { env } from '../../config/env.js';
import { getIO } from '../../lib/socket.js';
import type {
  UpdateShopBody,
  UpdateLocationBody,
  UpdateHoursBody,
  UpdateServiceAreaBody,
  SubmitOnboardingBody,
} from './onboarding.schema.js';

// ──────────────────────────────────────────────────────────
// UPDATE SHOP INFO
// ──────────────────────────────────────────────────────────

export async function updateShop(shopId: string, data: UpdateShopBody) {
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updateData.name = data.name;
  if (data.phone !== undefined) updateData.phone = data.phone || null;
  if (data.website !== undefined) updateData.website = data.website || null;
  if (data.description !== undefined) updateData.description = data.description || null;
  if (data.categories !== undefined) updateData.categories = data.categories;
  if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl || null;

  const [updated] = await db
    .update(shops)
    .set(updateData)
    .where(eq(shops.id, shopId))
    .returning({
      id: shops.id,
      name: shops.name,
      phone: shops.phone,
      website: shops.website,
      description: shops.description,
      categories: shops.categories,
      logoUrl: shops.logoUrl,
    });

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  return updated;
}

// ──────────────────────────────────────────────────────────
// UPDATE LOCATION
// ──────────────────────────────────────────────────────────

export async function updateLocation(shopId: string, data: UpdateLocationBody) {
  const [updated] = await db
    .update(shops)
    .set({
      address: data.address,
      latitude: data.latitude,
      longitude: data.longitude,
      placeId: data.placeId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning({
      id: shops.id,
      address: shops.address,
      latitude: shops.latitude,
      longitude: shops.longitude,
      placeId: shops.placeId,
    });

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  return updated;
}

// ──────────────────────────────────────────────────────────
// UPDATE BUSINESS HOURS
// ──────────────────────────────────────────────────────────

export async function updateHours(shopId: string, data: UpdateHoursBody) {
  const [updated] = await db
    .update(shops)
    .set({
      businessHours: data.hours,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning({
      id: shops.id,
      businessHours: shops.businessHours,
    });

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  return updated;
}

// ──────────────────────────────────────────────────────────
// UPDATE SERVICE AREA
// ──────────────────────────────────────────────────────────

export async function updateServiceArea(shopId: string, data: UpdateServiceAreaBody) {
  const [updated] = await db
    .update(shops)
    .set({
      serviceRadius: data.radiusKm,
      latitude: data.latitude,
      longitude: data.longitude,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning({
      id: shops.id,
      serviceRadius: shops.serviceRadius,
      latitude: shops.latitude,
      longitude: shops.longitude,
    });

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  return updated;
}

// ──────────────────────────────────────────────────────────
// SUBMIT ONBOARDING
// ──────────────────────────────────────────────────────────

export async function submitOnboarding(shopId: string, data: SubmitOnboardingBody) {
  // Check current status — only allow submit from NOT_STARTED or REJECTED
  const [shop] = await db
    .select({ onboardingStatus: shops.onboardingStatus })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');

  if (shop.onboardingStatus === 'IN_REVIEW') {
    throw new AppError(409, ErrorCode.CONFLICT, 'Onboarding is already under review');
  }
  if (shop.onboardingStatus === 'APPROVED') {
    throw new AppError(409, ErrorCode.CONFLICT, 'Shop is already approved');
  }

  // Atomic: upsert submission + set status to IN_REVIEW
  await db.transaction(async (tx) => {
    // Delete any previous submission (for re-submit after rejection)
    await tx
      .delete(onboardingSubmissions)
      .where(eq(onboardingSubmissions.shopId, shopId));

    await tx.insert(onboardingSubmissions).values({
      shopId,
      ownerFirstName: data.ownerFirstName,
      ownerLastName: data.ownerLastName,
      ownerDob: data.ownerDob,
      llcDocumentUrls: data.llcDocumentUrls ?? [],
      incorporationDocUrl: data.incorporationDocUrl ?? null,
      businessLicenseUrl: data.businessLicenseUrl ?? null,
      idDocumentUrl: data.idDocumentUrl,
    });

    await tx
      .update(shops)
      .set({
        onboardingStatus: 'IN_REVIEW',
        rejectionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(shops.id, shopId));
  });

  return { status: 'IN_REVIEW' as const };
}

// ──────────────────────────────────────────────────────────
// GET ONBOARDING STATUS
// ──────────────────────────────────────────────────────────

export async function getOnboardingStatus(shopId: string) {
  const [shop] = await db
    .select({
      onboardingStatus: shops.onboardingStatus,
      rejectionReason: shops.rejectionReason,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');

  return {
    status: shop.onboardingStatus,
    reason: shop.rejectionReason,
  };
}

// ──────────────────────────────────────────────────────────
// ADMIN: APPROVE SHOP
// ──────────────────────────────────────────────────────────

export async function approveShop(shopId: string) {
  const [shop] = await db
    .select({ onboardingStatus: shops.onboardingStatus })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');

  const [updated] = await db
    .update(shops)
    .set({
      onboardingStatus: 'APPROVED',
      rejectionReason: null,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning({ id: shops.id, onboardingStatus: shops.onboardingStatus });

  // Emit Socket.IO event so the store app navigates immediately
  try {
    getIO().to(`shop:${shopId}`).emit('onboarding:status_changed', {
      status: 'APPROVED',
      reason: null,
    });
  } catch { /* socket not ready in tests */ }

  return updated;
}

// ──────────────────────────────────────────────────────────
// ADMIN: REJECT SHOP
// ──────────────────────────────────────────────────────────

export async function rejectShop(shopId: string, reason: string) {
  const [shop] = await db
    .select({ onboardingStatus: shops.onboardingStatus })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');

  const [updated] = await db
    .update(shops)
    .set({
      onboardingStatus: 'REJECTED',
      rejectionReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning({
      id: shops.id,
      onboardingStatus: shops.onboardingStatus,
      rejectionReason: shops.rejectionReason,
    });

  // Emit Socket.IO event so the store app shows rejection
  try {
    getIO().to(`shop:${shopId}`).emit('onboarding:status_changed', {
      status: 'REJECTED',
      reason,
    });
  } catch { /* socket not ready in tests */ }

  return updated;
}

// ──────────────────────────────────────────────────────────
// CLOUDINARY SIGNED UPLOAD
// ──────────────────────────────────────────────────────────

export function getCloudinarySignature(shopId: string) {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'Cloudinary is not configured');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `onboarding/${shopId}`;

  // Build the string-to-sign (params sorted alphabetically)
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = crypto
    .createHash('sha1')
    .update(paramsToSign + apiSecret)
    .digest('hex');

  return {
    signature,
    timestamp,
    apiKey,
    cloudName,
    folder,
  };
}
