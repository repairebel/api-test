import { eq, and, desc, lt, sql, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { messages, jobs, shops } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { getIO } from '../../lib/socket.js';
import { notifyShop, notifyCustomer } from '../../lib/notify.js';

// ─── List chat threads (one per job) for this shop ───

export async function listChatThreads(shopId: string) {
  // Get all jobs for the shop
  const shopJobs = await db
    .select({
      jobId: jobs.id,
      customerName: jobs.customerName,
      deviceBrand: jobs.deviceBrand,
      deviceModel: jobs.deviceModel,
      status: jobs.status,
    })
    .from(jobs)
    .where(eq(jobs.shopId, shopId))
    .orderBy(desc(jobs.updatedAt));

  if (shopJobs.length === 0) return [];

  // For each job, get the last message and unread count
  const threads = await Promise.all(
    shopJobs.map(async (job) => {
      // Last message
      const [lastMsg] = await db
        .select({
          id: messages.id,
          type: messages.type,
          text: messages.text,
          senderRole: messages.senderRole,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.jobId, job.jobId))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      // Unread count: messages sent by CUSTOMER that are not yet seen
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.jobId, job.jobId),
            eq(messages.senderRole, 'CUSTOMER'),
            isNull(messages.seenAt),
          ),
        );

      return {
        jobId: job.jobId,
        customerName: job.customerName,
        device: `${job.deviceBrand} ${job.deviceModel}`,
        jobStatus: job.status,
        lastMessage: lastMsg
          ? {
              id: lastMsg.id,
              type: lastMsg.type,
              text: lastMsg.text,
              senderRole: lastMsg.senderRole,
              createdAt: lastMsg.createdAt?.toISOString() ?? null,
            }
          : null,
        unreadCount: count,
      };
    }),
  );

  // Sort: threads with messages first (by lastMessage time desc), then no-message threads
  threads.sort((a, b) => {
    if (a.lastMessage && b.lastMessage) {
      return new Date(b.lastMessage.createdAt!).getTime() - new Date(a.lastMessage.createdAt!).getTime();
    }
    if (a.lastMessage) return -1;
    if (b.lastMessage) return 1;
    return 0;
  });

  return threads;
}

// ─── Get messages for a job (cursor-paginated) ───

export async function getMessages(
  jobId: string,
  shopId: string,
  before: string | undefined,
  limit: number,
) {
  // Verify job belongs to shop
  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.shopId, shopId)))
    .limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }

  const conditions = [eq(messages.jobId, jobId)];

  if (before) {
    // Cursor: get messages older than `before` message ID
    const [cursorMsg] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, before))
      .limit(1);

    if (cursorMsg?.createdAt) {
      conditions.push(lt(messages.createdAt, cursorMsg.createdAt));
    }
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit + 1); // +1 to check if there are more

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  return {
    data: data.map((m) => ({
      id: m.id,
      clientMessageId: m.clientMessageId,
      senderId: m.senderId,
      senderRole: m.senderRole,
      type: m.type,
      text: m.text,
      mediaUrl: m.mediaUrl,
      publicId: m.publicId,
      thumbUrl: m.thumbUrl,
      durationMs: m.durationMs,
      seenAt: m.seenAt?.toISOString() ?? null,
      createdAt: m.createdAt?.toISOString() ?? null,
    })),
    hasMore,
    nextCursor: hasMore ? data[data.length - 1]?.id : null,
  };
}

// ─── Send a message ───

interface SendMessageInput {
  jobId: string;
  senderId: string;
  senderRole: 'SHOP' | 'CUSTOMER';
  clientMessageId: string;
  type: 'TEXT' | 'IMAGE' | 'VIDEO';
  text?: string;
  mediaUrl?: string;
  publicId?: string;
  thumbUrl?: string;
  durationMs?: number;
}

export async function sendMessage(input: SendMessageInput, shopId: string) {
  const {
    jobId,
    senderId,
    senderRole,
    clientMessageId,
    type,
    text,
    mediaUrl,
    publicId,
    thumbUrl,
    durationMs,
  } = input;

  // Verify job belongs to shop
  const [job] = await db
    .select({ id: jobs.id, customerId: jobs.customerId })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.shopId, shopId)))
    .limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }

  // Idempotency: check if message with this clientMessageId already exists
  const [existing] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.jobId, jobId),
        eq(messages.clientMessageId, clientMessageId),
      ),
    )
    .limit(1);

  if (existing) {
    // Return the existing message (idempotent)
    return {
      id: existing.id,
      clientMessageId: existing.clientMessageId,
      senderId: existing.senderId,
      senderRole: existing.senderRole,
      type: existing.type,
      text: existing.text,
      mediaUrl: existing.mediaUrl,
      publicId: existing.publicId,
      thumbUrl: existing.thumbUrl,
      durationMs: existing.durationMs,
      seenAt: existing.seenAt?.toISOString() ?? null,
      createdAt: existing.createdAt?.toISOString() ?? null,
      duplicate: true,
    };
  }

  // Validate type-specific fields
  if (type === 'TEXT' && !text) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'text is required for TEXT messages');
  }
  if ((type === 'IMAGE' || type === 'VIDEO') && !mediaUrl) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'mediaUrl is required for media messages');
  }

  const [msg] = await db
    .insert(messages)
    .values({
      jobId,
      clientMessageId,
      senderId,
      senderRole,
      type,
      text: text ?? null,
      mediaUrl: mediaUrl ?? null,
      publicId: publicId ?? null,
      thumbUrl: thumbUrl ?? null,
      durationMs: durationMs ?? null,
    })
    .returning();

  // Emit Socket.IO
  try {
    const io = getIO();
    const payload = {
      id: msg.id,
      jobId,
      clientMessageId: msg.clientMessageId,
      senderId: msg.senderId,
      senderRole: msg.senderRole,
      type: msg.type,
      text: msg.text,
      mediaUrl: msg.mediaUrl,
      thumbUrl: msg.thumbUrl,
      durationMs: msg.durationMs,
      createdAt: msg.createdAt?.toISOString(),
    };
    io.to(`chat:${jobId}`).emit('chat:message', payload);
    // Also notify the customer room so their thread list refreshes
    if (job.customerId) {
      await notifyCustomer({
        customerId: job.customerId,
        event: 'chat:message',
        payload,
        push: { title: 'New Message', body: payload.text || 'You received a new message', data: { screen: 'chat', jobId } },
        persist: {
          category: 'chat',
          title: 'New Message',
          body: payload.text || 'You received a new message',
          data: { screen: 'chat', jobId },
        },
      });
    }
  } catch {}

  return {
    id: msg.id,
    clientMessageId: msg.clientMessageId,
    senderId: msg.senderId,
    senderRole: msg.senderRole,
    type: msg.type,
    text: msg.text,
    mediaUrl: msg.mediaUrl,
    publicId: msg.publicId,
    thumbUrl: msg.thumbUrl,
    durationMs: msg.durationMs,
    seenAt: null,
    createdAt: msg.createdAt?.toISOString() ?? null,
    duplicate: false,
  };
}

// ─── Mark messages as seen ───

export async function markSeen(jobId: string, shopId: string, lastSeenMessageId: string) {
  // Verify job belongs to shop
  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.shopId, shopId)))
    .limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }

  // Get the target message's createdAt
  const [targetMsg] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, lastSeenMessageId))
    .limit(1);

  if (!targetMsg) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Message not found');
  }

  // Mark all CUSTOMER messages up to and including the target as seen
  const now = new Date();
  await db
    .update(messages)
    .set({ seenAt: now })
    .where(
      and(
        eq(messages.jobId, jobId),
        eq(messages.senderRole, 'CUSTOMER'),
        isNull(messages.seenAt),
        sql`${messages.createdAt} <= ${targetMsg.createdAt}`,
      ),
    );

  // Emit Socket.IO
  try {
    const io = getIO();
    const payload = {
      jobId,
      lastSeenMessageId,
      seenAt: now.toISOString(),
      seenBy: 'SHOP',
    };
    io.to(`chat:${jobId}`).emit('chat:seen', payload);
    io.to(`shop:${shopId}`).emit('chat:seen', payload);
  } catch {}

  return { success: true, lastSeenMessageId, seenAt: now.toISOString() };
}

// ════════════════════════════════════════════════════════════════════
// CUSTOMER-FACING CHAT
// ════════════════════════════════════════════════════════════════════

// ─── List chat threads for a customer ───

export async function listCustomerChatThreads(customerId: string) {
  const customerJobs = await db
    .select({
      jobId: jobs.id,
      shopId: jobs.shopId,
      shopName: shops.name,
      shopLogoUrl: shops.logoUrl,
      deviceBrand: jobs.deviceBrand,
      deviceModel: jobs.deviceModel,
      status: jobs.status,
    })
    .from(jobs)
    .innerJoin(shops, eq(shops.id, jobs.shopId))
    .where(eq(jobs.customerId, customerId))
    .orderBy(desc(jobs.updatedAt));

  if (customerJobs.length === 0) return [];

  const threads = await Promise.all(
    customerJobs.map(async (job) => {
      const [lastMsg] = await db
        .select({
          id: messages.id,
          type: messages.type,
          text: messages.text,
          senderRole: messages.senderRole,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.jobId, job.jobId))
        .orderBy(desc(messages.createdAt))
        .limit(1);

      // Unread: messages from SHOP not yet seen
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.jobId, job.jobId),
            eq(messages.senderRole, 'SHOP'),
            isNull(messages.seenAt),
          ),
        );

      return {
        jobId: job.jobId,
        shopName: job.shopName,
        shopLogoUrl: job.shopLogoUrl,
        device: `${job.deviceBrand} ${job.deviceModel}`,
        jobStatus: job.status,
        lastMessage: lastMsg
          ? {
              id: lastMsg.id,
              type: lastMsg.type,
              text: lastMsg.text,
              senderRole: lastMsg.senderRole,
              createdAt: lastMsg.createdAt?.toISOString() ?? null,
            }
          : null,
        unreadCount: count,
      };
    }),
  );

  threads.sort((a, b) => {
    if (a.lastMessage && b.lastMessage) {
      return new Date(b.lastMessage.createdAt!).getTime() - new Date(a.lastMessage.createdAt!).getTime();
    }
    if (a.lastMessage) return -1;
    if (b.lastMessage) return 1;
    return 0;
  });

  return threads;
}

// ─── Get messages for a customer job ───

export async function getCustomerMessages(
  jobId: string,
  customerId: string,
  before: string | undefined,
  limit: number,
) {
  // Verify job belongs to customer
  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.customerId, customerId)))
    .limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }

  const conditions = [eq(messages.jobId, jobId)];

  if (before) {
    const [cursorMsg] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, before))
      .limit(1);

    if (cursorMsg?.createdAt) {
      conditions.push(lt(messages.createdAt, cursorMsg.createdAt));
    }
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  return {
    data: data.map((m) => ({
      id: m.id,
      clientMessageId: m.clientMessageId,
      senderId: m.senderId,
      senderRole: m.senderRole,
      type: m.type,
      text: m.text,
      mediaUrl: m.mediaUrl,
      publicId: m.publicId,
      thumbUrl: m.thumbUrl,
      durationMs: m.durationMs,
      seenAt: m.seenAt?.toISOString() ?? null,
      createdAt: m.createdAt?.toISOString() ?? null,
    })),
    hasMore,
    nextCursor: hasMore ? data[data.length - 1]?.id : null,
  };
}

// ─── Send a message as customer ───

export async function sendCustomerMessage(
  input: Omit<SendMessageInput, 'senderRole'>,
  customerId: string,
) {
  const { jobId, senderId, clientMessageId, type, text, mediaUrl, publicId, thumbUrl, durationMs } = input;

  // Verify job belongs to customer
  const [job] = await db
    .select({ id: jobs.id, shopId: jobs.shopId })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.customerId, customerId)))
    .limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }

  // Idempotency
  const [existing] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.jobId, jobId),
        eq(messages.clientMessageId, clientMessageId),
      ),
    )
    .limit(1);

  if (existing) {
    return {
      id: existing.id,
      clientMessageId: existing.clientMessageId,
      senderId: existing.senderId,
      senderRole: existing.senderRole,
      type: existing.type,
      text: existing.text,
      mediaUrl: existing.mediaUrl,
      publicId: existing.publicId,
      thumbUrl: existing.thumbUrl,
      durationMs: existing.durationMs,
      seenAt: existing.seenAt?.toISOString() ?? null,
      createdAt: existing.createdAt?.toISOString() ?? null,
      duplicate: true,
    };
  }

  if (type === 'TEXT' && !text) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'text is required for TEXT messages');
  }
  if ((type === 'IMAGE' || type === 'VIDEO') && !mediaUrl) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'mediaUrl is required for media messages');
  }

  const [msg] = await db
    .insert(messages)
    .values({
      jobId,
      clientMessageId,
      senderId,
      senderRole: 'CUSTOMER',
      type,
      text: text ?? null,
      mediaUrl: mediaUrl ?? null,
      publicId: publicId ?? null,
      thumbUrl: thumbUrl ?? null,
      durationMs: durationMs ?? null,
    })
    .returning();

  // Emit to chat room + shop room (for thread list refresh)
  try {
    const io = getIO();
    const payload = {
      id: msg.id,
      jobId,
      clientMessageId: msg.clientMessageId,
      senderId: msg.senderId,
      senderRole: msg.senderRole,
      type: msg.type,
      text: msg.text,
      mediaUrl: msg.mediaUrl,
      thumbUrl: msg.thumbUrl,
      durationMs: msg.durationMs,
      createdAt: msg.createdAt?.toISOString(),
    };
    io.to(`chat:${jobId}`).emit('chat:message', payload);
    // Also notify the shop room so thread list refreshes
    await notifyShop({
      shopId: job.shopId,
      event: 'chat:message',
      payload,
      push: { title: 'New Message', body: payload.text || 'You received a new message', data: { screen: 'chat-thread', jobId } },
      persist: {
        category: 'chat',
        title: 'New Message',
        body: payload.text || 'You received a new message',
        data: { screen: 'chat-thread', jobId },
      },
    });
  } catch {}

  return {
    id: msg.id,
    clientMessageId: msg.clientMessageId,
    senderId: msg.senderId,
    senderRole: msg.senderRole,
    type: msg.type,
    text: msg.text,
    mediaUrl: msg.mediaUrl,
    publicId: msg.publicId,
    thumbUrl: msg.thumbUrl,
    durationMs: msg.durationMs,
    seenAt: null,
    createdAt: msg.createdAt?.toISOString() ?? null,
    duplicate: false,
  };
}

// ─── Mark messages as seen (customer sees shop messages) ───

export async function markCustomerSeen(
  jobId: string,
  customerId: string,
  lastSeenMessageId: string,
) {
  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.customerId, customerId)))
    .limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }

  const [targetMsg] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, lastSeenMessageId))
    .limit(1);

  if (!targetMsg) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Message not found');
  }

  // Mark all SHOP messages up to target as seen
  const now = new Date();
  await db
    .update(messages)
    .set({ seenAt: now })
    .where(
      and(
        eq(messages.jobId, jobId),
        eq(messages.senderRole, 'SHOP'),
        isNull(messages.seenAt),
        sql`${messages.createdAt} <= ${targetMsg.createdAt}`,
      ),
    );

  try {
    const io = getIO();
    const payload = {
      jobId,
      lastSeenMessageId,
      seenAt: now.toISOString(),
      seenBy: 'CUSTOMER',
    };
    io.to(`chat:${jobId}`).emit('chat:seen', payload);
    io.to(`customer:${customerId}`).emit('chat:seen', payload);
  } catch {}

  return { success: true, lastSeenMessageId, seenAt: now.toISOString() };
}
