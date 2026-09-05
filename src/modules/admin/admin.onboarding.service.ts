import { eq, and, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  shops,
  onboardingSubmissions,
  memberships,
  users,
} from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

export async function listOnboardingSubmissions(query: { page?: number; limit?: number; status?: string }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  // Filter by shop onboarding status
  if (query.status) conditions.push(eq(shops.onboardingStatus, query.status as any));
  // Only show shops that have a submission
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        submissionId: onboardingSubmissions.id,
        shopId: onboardingSubmissions.shopId,
        shopName: shops.name,
        onboardingStatus: shops.onboardingStatus,
        ownerFirstName: onboardingSubmissions.ownerFirstName,
        ownerLastName: onboardingSubmissions.ownerLastName,
        ownerDob: onboardingSubmissions.ownerDob,
        llcDocumentUrls: onboardingSubmissions.llcDocumentUrls,
        incorporationDocUrl: onboardingSubmissions.incorporationDocUrl,
        businessLicenseUrl: onboardingSubmissions.businessLicenseUrl,
        idDocumentUrl: onboardingSubmissions.idDocumentUrl,
        submittedAt: onboardingSubmissions.submittedAt,
        createdAt: onboardingSubmissions.createdAt,
      })
      .from(onboardingSubmissions)
      .innerJoin(shops, eq(shops.id, onboardingSubmissions.shopId))
      .where(where)
      .orderBy(desc(onboardingSubmissions.submittedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(onboardingSubmissions)
      .innerJoin(shops, eq(shops.id, onboardingSubmissions.shopId))
      .where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function getOnboardingDetail(shopId: string) {
  const [submission] = await db
    .select()
    .from(onboardingSubmissions)
    .where(eq(onboardingSubmissions.shopId, shopId))
    .limit(1);

  if (!submission) throw new AppError(404, ErrorCode.NOT_FOUND, 'Onboarding submission not found');

  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId)).limit(1);

  // Get owner info
  const ownerMembership = await db
    .select({
      userId: memberships.userId,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.shopId, shopId), eq(memberships.role, 'OWNER')))
    .limit(1);

  return {
    submission: {
      ...submission,
      submittedAt: submission.submittedAt?.toISOString() ?? null,
      createdAt: submission.createdAt?.toISOString() ?? null,
      updatedAt: submission.updatedAt?.toISOString() ?? null,
    },
    shop: shop
      ? {
          ...shop,
          createdAt: shop.createdAt?.toISOString() ?? null,
          updatedAt: shop.updatedAt?.toISOString() ?? null,
        }
      : null,
    owner: ownerMembership[0] ?? null,
  };
}

export async function approveOnboarding(shopId: string) {
  const [shop] = await db
    .select({ id: shops.id, onboardingStatus: shops.onboardingStatus })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  if (shop.onboardingStatus === 'APPROVED') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Shop already approved');
  }

  await db
    .update(shops)
    .set({ onboardingStatus: 'APPROVED', rejectionReason: null, updatedAt: new Date() })
    .where(eq(shops.id, shopId));

  return { message: 'Shop approved', shopId };
}

export async function rejectOnboarding(shopId: string, reason: string) {
  const [shop] = await db
    .select({ id: shops.id, onboardingStatus: shops.onboardingStatus })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');

  await db
    .update(shops)
    .set({ onboardingStatus: 'REJECTED', rejectionReason: reason, updatedAt: new Date() })
    .where(eq(shops.id, shopId));

  return { message: 'Shop rejected', shopId, reason };
}
