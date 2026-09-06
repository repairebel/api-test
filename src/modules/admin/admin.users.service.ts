import { eq, and, or, ilike, desc, count, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  users,
  refreshTokens,
  requests,
  jobs,
  reviews,
  reviewReplies,
  reviewReports,
  disputes,
  protectionSubscribers,
  protectionClaims,
  loginActivity,
} from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import argon2 from 'argon2';

interface ListUsersQuery {
  page?: number;
  limit?: number;
  search?: string;
  userType?: string;
  status?: string;
}

export async function listUsers(query: ListUsersQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.userType) conditions.push(eq(users.userType, query.userType as any));
  if (query.status) conditions.push(eq(users.status, query.status));
  if (query.search) {
    conditions.push(
      or(
        ilike(users.email, `%${query.search}%`),
        ilike(users.fullName, `%${query.search}%`),
        ilike(users.phone, `%${query.search}%`),
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
      avatarUrl: users.avatarUrl,
      userType: users.userType,
      status: users.status,
      stripeCustomerId: users.stripeCustomerId,
      shareUsage: users.privacyShareUsage,
      shareLocation: users.privacyShareLocation,
      shareRepairHistory: users.privacyShareRepairHistory,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(users).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
      updatedAt: r.updatedAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function getUserById(userId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');

  const activity = await db.select({
    id: loginActivity.id, userType: loginActivity.userType, ipAddress: loginActivity.ipAddress,
    location: loginActivity.location, deviceName: loginActivity.deviceName, platform: loginActivity.platform,
    userAgent: loginActivity.userAgent, createdAt: loginActivity.createdAt,
  }).from(loginActivity).where(eq(loginActivity.userId, userId)).orderBy(desc(loginActivity.createdAt)).limit(20);

  return {
    ...user,
    passwordHash: undefined,
    createdAt: user.createdAt?.toISOString() ?? null,
    updatedAt: user.updatedAt?.toISOString() ?? null,
    loginActivity: activity.map((entry) => ({ ...entry, createdAt: entry.createdAt?.toISOString() ?? null })),
    lastLogin: activity[0] ? { at: activity[0].createdAt?.toISOString() ?? null, ipAddress: activity[0].ipAddress, location: activity[0].location, deviceName: activity[0].deviceName } : null,
  };
}

export async function suspendUser(userId: string) {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ status: 'SUSPENDED', updatedAt: new Date() })
      .where(eq(users.id, userId));

    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  });
  return { message: 'User suspended', userId };
}

export async function activateUser(userId: string) {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');
  await db.update(users).set({ status: 'ACTIVE', updatedAt: new Date() }).where(eq(users.id, userId));
  return { message: 'User activated', userId };
}

export async function deleteUser(userId: string) {
  const [user] = await db.select({ id: users.id, userType: users.userType }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');

  // Use a transaction to remove all related data that doesn't auto-cascade
  await db.transaction(async (tx) => {
    // 1. Protection claims & subscribers (customerId has no FK to users)
    await tx.delete(protectionClaims).where(eq(protectionClaims.customerId, userId));
    await tx.delete(protectionSubscribers).where(eq(protectionSubscribers.customerId, userId));

    // 2. Review reports / replies where this user is reporter or replier (no FK to users)
    await tx.delete(reviewReports).where(eq(reviewReports.reporterUserId, userId));
    await tx.delete(reviewReplies).where(eq(reviewReplies.replierUserId, userId));

    // 3. Reviews (customerId has no FK to users)  — cascades review_media, review_replies, review_reports for those reviews
    await tx.delete(reviews).where(eq(reviews.customerId, userId));

    // 4. Disputes not already cascade-deleted (customerId has no FK)
    await tx.delete(disputes).where(eq(disputes.customerId, userId));

    // 5. Jobs where this user is customer (customerId has no FK) — cascades job_media, messages, job_status_events, payouts
    await tx.delete(jobs).where(eq(jobs.customerId, userId));

    // 6. Requests (customerId has no FK) — cascades dispatch_targets, offers
    await tx.delete(requests).where(eq(requests.customerId, userId));

    // 7. Finally delete the user — cascades memberships, customer_addresses,
    //    notification_prefs, refresh_tokens, password_reset_tokens, push_tokens,
    //    support_conversations, admin_users
    await tx.delete(users).where(eq(users.id, userId));
  });

  return { message: 'User and all associated data deleted', userId };
}

export async function updateUser(
  userId: string,
  data: { fullName?: string; email?: string; phone?: string },
) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');

  const set: Record<string, any> = { updatedAt: new Date() };
  if (data.fullName !== undefined) set.fullName = data.fullName;
  if (data.email !== undefined) set.email = data.email;
  if (data.phone !== undefined) set.phone = data.phone;

  await db.update(users).set(set).where(eq(users.id, userId));

  return getUserById(userId);
}

export async function resetUserPassword(userId: string, newPassword: string) {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');

  if (newPassword.length < 6) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Password must be at least 6 characters');
  }

  const passwordHash = await argon2.hash(newPassword);
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));

  return { message: 'Password reset successfully', userId };
}
