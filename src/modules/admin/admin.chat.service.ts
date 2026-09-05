import { eq, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { messages, jobs, shops } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

export async function listChats(query: { page?: number; limit?: number }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  // Get distinct jobs that have messages, with last message info
  const rows = await db.execute(sql`
    SELECT
      j.id AS "jobId",
      j.customer_id AS "customerId",
      j.customer_name AS "customerName",
      j.shop_id AS "shopId",
      s.name AS "shopName",
      j.device_model AS "deviceModel",
      j.status AS "jobStatus",
      (SELECT COUNT(*) FROM messages m WHERE m.job_id = j.id)::int AS "messageCount",
      (SELECT m2.text FROM messages m2 WHERE m2.job_id = j.id ORDER BY m2.created_at DESC LIMIT 1) AS "lastMessage",
      (SELECT m3.created_at FROM messages m3 WHERE m3.job_id = j.id ORDER BY m3.created_at DESC LIMIT 1) AS "lastMessageAt"
    FROM jobs j
    LEFT JOIN shops s ON s.id = j.shop_id
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.job_id = j.id)
    ORDER BY "lastMessageAt" DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}
  `);

  const [{ total }] = await db.execute(sql`
    SELECT COUNT(DISTINCT j.id)::int AS total
    FROM jobs j
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.job_id = j.id)
  `).then((r) => r.rows as any[]);

  return {
    data: rows.rows,
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function getChatMessages(jobId: string, query: { page?: number; limit?: number }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const offset = (page - 1) * limit;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(eq(messages.jobId, jobId))
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(messages).where(eq(messages.jobId, jobId)),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      seenAt: r.seenAt?.toISOString() ?? null,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function sendAdminMessage(jobId: string, adminUserId: string, text: string) {
  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');

  const [msg] = await db
    .insert(messages)
    .values({
      jobId,
      clientMessageId: `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderId: adminUserId,
      senderRole: 'ADMIN',
      type: 'TEXT',
      text,
    })
    .returning();

  return { ...msg, createdAt: msg.createdAt?.toISOString() ?? null };
}
