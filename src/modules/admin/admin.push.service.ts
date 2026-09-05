import { eq, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pushTokens, users } from '../../db/schema/index.js';

export async function listPushTokens(query: { page?: number; limit?: number; appType?: string }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.appType) conditions.push(eq(pushTokens.appType, query.appType as any));

  const where = conditions.length > 0 ? (conditions.length === 1 ? conditions[0] : undefined) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: pushTokens.id,
        userId: pushTokens.userId,
        userEmail: users.email,
        userName: users.fullName,
        token: pushTokens.token,
        platform: pushTokens.platform,
        appType: pushTokens.appType,
        createdAt: pushTokens.createdAt,
        updatedAt: pushTokens.updatedAt,
      })
      .from(pushTokens)
      .leftJoin(users, eq(users.id, pushTokens.userId))
      .where(where)
      .orderBy(desc(pushTokens.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(pushTokens).where(where),
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

export async function getPushStats() {
  const [stats] = await db
    .select({
      total: count(),
      storeTokens: sql<number>`COUNT(*) FILTER (WHERE ${pushTokens.appType} = 'STORE')`,
      customerTokens: sql<number>`COUNT(*) FILTER (WHERE ${pushTokens.appType} = 'CUSTOMER')`,
      iosTokens: sql<number>`COUNT(*) FILTER (WHERE ${pushTokens.platform} = 'ios')`,
      androidTokens: sql<number>`COUNT(*) FILTER (WHERE ${pushTokens.platform} = 'android')`,
    })
    .from(pushTokens);

  return stats;
}
