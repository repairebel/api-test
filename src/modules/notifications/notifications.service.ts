import { db } from '../../db/client.js';
import { pushTokens, notifications } from '../../db/schema/index.js';
import { eq, and, desc, sql } from 'drizzle-orm';

// ─── Push token management ─────────────────────────────────

export async function registerPushToken(
  userId: string,
  token: string,
  platform: string,
  appType: 'STORE' | 'CUSTOMER',
): Promise<void> {
  // Upsert: delete any existing token for this user+app, then insert
  await db
    .delete(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)));

  await db.insert(pushTokens).values({
    userId,
    token,
    platform,
    appType,
  });
}

export async function unregisterPushToken(userId: string, token: string): Promise<void> {
  await db
    .delete(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)));
}

export async function unregisterAllTokens(userId: string, appType: 'STORE' | 'CUSTOMER'): Promise<void> {
  await db
    .delete(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.appType, appType)));
}

// ─── Notification CRUD ──────────────────────────────────────

export interface CreateNotificationInput {
  userId: string;
  targetType: 'STORE' | 'CUSTOMER' | 'ADMIN';
  category: 'order' | 'dispatch' | 'chat' | 'dispute' | 'payout' | 'review' | 'system' | 'offer' | 'protection';
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function createNotification(input: CreateNotificationInput) {
  const [row] = await db.insert(notifications).values({
    userId: input.userId,
    targetType: input.targetType,
    category: input.category,
    title: input.title,
    body: input.body,
    data: input.data ?? {},
  }).returning();
  return row;
}

export async function getUserNotifications(
  userId: string,
  opts: { page?: number; limit?: number; category?: string; read?: boolean } = {},
) {
  const page = opts.page ?? 1;
  const limit = Math.min(opts.limit ?? 30, 100);
  const offset = (page - 1) * limit;

  let where = eq(notifications.userId, userId);

  if (opts.category) {
    where = and(where, eq(notifications.category, opts.category as any))!;
  }
  if (opts.read !== undefined) {
    where = and(where, eq(notifications.read, opts.read))!;
  }

  const rows = await db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .offset(offset);

  return rows;
}

export async function getUnreadCount(userId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
  return result?.count ?? 0;
}

export async function markNotificationRead(notificationId: string, userId: string): Promise<boolean> {
  const result = await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));
  return (result as any).rowCount > 0;
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
}
