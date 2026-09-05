import { eq, and, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { auditLogs } from '../../db/schema/index.js';

interface ListAuditLogsQuery {
  page?: number;
  limit?: number;
  actionType?: string;
  adminUserId?: string;
}

export async function listAuditLogs(query: ListAuditLogsQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.actionType) conditions.push(eq(auditLogs.actionType, query.actionType as any));
  if (query.adminUserId) conditions.push(eq(auditLogs.adminUserId, query.adminUserId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(auditLogs).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}
