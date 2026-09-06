import { notifyAdmin } from '../../lib/notify.js';
import { eq, desc, count, and, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  supportConversations,
  supportMessages,
  supportAgentStatus,
  users,
  adminUsers,
} from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { getIO } from '../../lib/socket.js';

// ─── Agent Availability ───

export async function toggleAgentAvailability(adminUserId: string, isAvailable: boolean) {
  const [row] = await db
    .insert(supportAgentStatus)
    .values({ adminUserId, isAvailable, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: supportAgentStatus.adminUserId,
      set: { isAvailable, updatedAt: new Date() },
    })
    .returning();

  return row;
}

export async function getAgentStatus(adminUserId: string) {
  const [row] = await db
    .select()
    .from(supportAgentStatus)
    .where(eq(supportAgentStatus.adminUserId, adminUserId))
    .limit(1);

  return { isAvailable: row?.isAvailable ?? false };
}

export async function getAvailableAgentsCount() {
  const [row] = await db
    .select({ count: count() })
    .from(supportAgentStatus)
    .where(eq(supportAgentStatus.isAvailable, true));

  return { count: Number(row?.count ?? 0) };
}

export async function getAvailableAgents() {
  const rows = await db
    .select({
      adminUserId: supportAgentStatus.adminUserId,
      userId: adminUsers.userId,
      name: adminUsers.name,
    })
    .from(supportAgentStatus)
    .innerJoin(adminUsers, eq(adminUsers.id, supportAgentStatus.adminUserId))
    .where(eq(supportAgentStatus.isAvailable, true));

  return rows;
}

// ─── Customer: Connect to Agent ───

export async function connectToAgent(
  userId: string,
  category: string,
  description: string,
) {
  // Get customer name
  const [customer] = await db
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const customerName = customer?.fullName ?? customer?.email ?? 'Customer';

  // Create waiting conversation
  const [conv] = await db
    .insert(supportConversations)
    .values({
      userId,
      title: `${category} — ${customerName}`,
      category,
      description,
      status: 'waiting',
      ticketStatus: 'open',
    })
    .returning();

  // Insert the initial message from customer
  await db.insert(supportMessages).values({
    conversationId: conv.id,
    role: 'user',
    content: description,
    senderName: customerName,
  });

  await notifyAdmin({ event: 'support:new-request', payload: { conversationId: conv.id, customerName, category, description, createdAt: conv.createdAt },
    persist: { category: 'chat', title: 'New support request', body: `${customerName}: ${description.slice(0, 160)}`, data: { conversationId: conv.id } } });

  return {
    conversationId: conv.id,
    status: conv.status,
    customerName,
  };
}

export async function checkAgentAvailable() {
  const { count: agentCount } = await getAvailableAgentsCount();
  return { available: agentCount > 0, agentCount };
}

// ─── Agent: Accept Conversation ───

export async function acceptConversation(conversationId: string, adminUserId: string) {
  // Get agent name
  const [agent] = await db
    .select({ name: adminUsers.name })
    .from(adminUsers)
    .where(eq(adminUsers.id, adminUserId))
    .limit(1);

  const agentName = agent?.name ?? 'Support Agent';

  // Atomic: only accept if status is still 'waiting'
  const [updated] = await db
    .update(supportConversations)
    .set({
      status: 'active',
      agentId: adminUserId,
      agentName,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(supportConversations.id, conversationId),
        eq(supportConversations.status, 'waiting'),
      ),
    )
    .returning();

  if (!updated) {
    // Someone else already accepted? Check current state
    const [conv] = await db
      .select({ status: supportConversations.status, agentName: supportConversations.agentName })
      .from(supportConversations)
      .where(eq(supportConversations.id, conversationId))
      .limit(1);

    if (!conv) throw new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found');

    if (conv.status === 'active') {
      return { alreadyTaken: true, agentName: conv.agentName ?? 'Another agent' };
    }

    throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Conversation is ${conv.status}`);
  }

  // Add system message to conversation
  await db.insert(supportMessages).values({
    conversationId,
    role: 'assistant',
    content: `${agentName} has joined the conversation.`,
    senderName: 'System',
  });

  // Emit to support room and admin room
  try {
    const io = getIO();
    io.to(`support:${conversationId}`).emit('support:accepted', {
      conversationId,
      agentName,
      agentId: adminUserId,
    });
    io.to('admin').emit('support:accepted', {
      conversationId,
      agentName,
      agentId: adminUserId,
    });
  } catch {}

  return { alreadyTaken: false, agentName, conversationId };
}

// ─── Messaging ───

export async function sendSupportMessage(
  conversationId: string,
  senderId: string,
  role: 'user' | 'assistant',
  content: string,
  type: string = 'text',
  mediaUrl?: string
) {
  // Verify conversation exists and is active (or waiting for user messages)
  const [conv] = await db
    .select({ id: supportConversations.id, status: supportConversations.status })
    .from(supportConversations)
    .where(eq(supportConversations.id, conversationId))
    .limit(1);

  if (!conv) throw new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found');
  if (conv.status === 'closed') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Conversation is closed');
  }

  // Get sender name
  let senderName = 'Unknown';
  if (role === 'user') {
    const [u] = await db
      .select({ fullName: users.fullName, email: users.email })
      .from(users)
      .where(eq(users.id, senderId))
      .limit(1);
    senderName = u?.fullName ?? u?.email ?? 'Customer';
  } else {
    const [a] = await db
      .select({ name: adminUsers.name })
      .from(adminUsers)
      .where(eq(adminUsers.id, senderId))
      .limit(1);
    senderName = a?.name ?? 'Support Agent';
  }

  const [msg] = await db
    .insert(supportMessages)
    .values({
      conversationId,
      role,
      content,
      type,
      mediaUrl,
      senderName,
    })
    .returning();

  // Update conversation timestamp
  await db
    .update(supportConversations)
    .set({ updatedAt: new Date() })
    .where(eq(supportConversations.id, conversationId));

  const messagePayload = {
    id: msg.id,
    conversationId,
    role: msg.role,
    content: msg.content,
    type: msg.type,
    mediaUrl: msg.mediaUrl,
    senderName,
    createdAt: msg.createdAt?.toISOString() ?? new Date().toISOString(),
  };

  // Emit real-time message
  try {
    const io = getIO();
    io.to(`support:${conversationId}`).emit('support:message', messagePayload);
  } catch {}

  if (role === 'user') await notifyAdmin({ event: 'support:customer-message', payload: messagePayload,
    persist: { category: 'chat', title: `Support message from ${senderName}`, body: content.slice(0, 160) || 'New attachment', data: { conversationId, messageId: msg.id } } });

  return messagePayload;
}

// ─── List / Get ───

export async function listSupportTickets(query: { page?: number; limit?: number; status?: string; ticketStatus?: string }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions = [];
  if (query.status) {
    conditions.push(eq(supportConversations.status, query.status as any));
  }
  if (query.ticketStatus) {
    conditions.push(eq(supportConversations.ticketStatus, query.ticketStatus as any));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: supportConversations.id,
        userId: supportConversations.userId,
        userEmail: users.email,
        userName: users.fullName,
        title: supportConversations.title,
        category: supportConversations.category,
        description: supportConversations.description,
        status: supportConversations.status,
        ticketStatus: supportConversations.ticketStatus,
        agentId: supportConversations.agentId,
        agentName: supportConversations.agentName,
        closedAt: supportConversations.closedAt,
        createdAt: supportConversations.createdAt,
        updatedAt: supportConversations.updatedAt,
      })
      .from(supportConversations)
      .leftJoin(users, eq(users.id, supportConversations.userId))
      .where(whereClause)
      .orderBy(desc(supportConversations.updatedAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(supportConversations).where(whereClause),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
      updatedAt: r.updatedAt?.toISOString() ?? null,
      closedAt: r.closedAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function listWaitingConversations() {
  const rows = await db
    .select({
      id: supportConversations.id,
      userId: supportConversations.userId,
      userName: users.fullName,
      userEmail: users.email,
      title: supportConversations.title,
      category: supportConversations.category,
      description: supportConversations.description,
      createdAt: supportConversations.createdAt,
    })
    .from(supportConversations)
    .leftJoin(users, eq(users.id, supportConversations.userId))
    .where(eq(supportConversations.status, 'waiting'))
    .orderBy(supportConversations.createdAt);

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt?.toISOString() ?? null,
  }));
}

export async function getSupportConversation(conversationId: string) {
  const [conv] = await db
    .select({
      id: supportConversations.id,
      userId: supportConversations.userId,
      userEmail: users.email,
      userName: users.fullName,
      title: supportConversations.title,
      category: supportConversations.category,
      description: supportConversations.description,
      status: supportConversations.status,
      ticketStatus: supportConversations.ticketStatus,
      agentId: supportConversations.agentId,
      agentName: supportConversations.agentName,
      closedAt: supportConversations.closedAt,
      createdAt: supportConversations.createdAt,
      updatedAt: supportConversations.updatedAt,
    })
    .from(supportConversations)
    .leftJoin(users, eq(users.id, supportConversations.userId))
    .where(eq(supportConversations.id, conversationId))
    .limit(1);

  if (!conv) throw new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found');

  const messages = await db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.conversationId, conversationId))
    .orderBy(supportMessages.createdAt);

  return {
    ...conv,
    createdAt: conv.createdAt?.toISOString() ?? null,
    updatedAt: conv.updatedAt?.toISOString() ?? null,
    closedAt: conv.closedAt?.toISOString() ?? null,
    messages: messages.map((m) => ({
      ...m,
      createdAt: m.createdAt?.toISOString() ?? null,
    })),
  };
}

// ─── Ticket Management ───

export async function updateTicketStatus(conversationId: string, ticketStatus: 'open' | 'in_review' | 'closed') {
  const [updated] = await db
    .update(supportConversations)
    .set({ ticketStatus, updatedAt: new Date() })
    .where(eq(supportConversations.id, conversationId))
    .returning();

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found');

  try {
    const io = getIO();
    io.to(`support:${conversationId}`).emit('support:ticket-updated', {
      conversationId,
      ticketStatus,
    });
  } catch {}

  return { conversationId, ticketStatus };
}

// ─── Transfer ───

export async function transferConversation(conversationId: string, fromAgentId: string, toAgentId: string) {
  // Get target agent info
  const [toAgent] = await db
    .select({ name: adminUsers.name })
    .from(adminUsers)
    .where(eq(adminUsers.id, toAgentId))
    .limit(1);

  if (!toAgent) throw new AppError(404, ErrorCode.NOT_FOUND, 'Target agent not found');

  // Verify the target agent is available
  const [agentStatus] = await db
    .select()
    .from(supportAgentStatus)
    .where(and(eq(supportAgentStatus.adminUserId, toAgentId), eq(supportAgentStatus.isAvailable, true)))
    .limit(1);

  if (!agentStatus) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Target agent is not available');
  }

  const [updated] = await db
    .update(supportConversations)
    .set({
      agentId: toAgentId,
      agentName: toAgent.name,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(supportConversations.id, conversationId),
        eq(supportConversations.agentId, fromAgentId),
      ),
    )
    .returning();

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found or not assigned to you');

  // Get from-agent name for system message
  const [fromAgent] = await db
    .select({ name: adminUsers.name })
    .from(adminUsers)
    .where(eq(adminUsers.id, fromAgentId))
    .limit(1);

  // Add system message
  await db.insert(supportMessages).values({
    conversationId,
    role: 'assistant',
    content: `Chat transferred from ${fromAgent?.name ?? 'previous agent'} to ${toAgent.name}.`,
    senderName: 'System',
  });

  try {
    const io = getIO();
    io.to(`support:${conversationId}`).emit('support:transferred', {
      conversationId,
      fromAgentName: fromAgent?.name,
      toAgentName: toAgent.name,
      toAgentId,
    });
    io.to('admin').emit('support:transferred', {
      conversationId,
      fromAgentName: fromAgent?.name,
      toAgentName: toAgent.name,
      toAgentId,
    });
  } catch {}

  return { conversationId, newAgentName: toAgent.name };
}

// ─── Close Conversation ───

export async function closeConversation(conversationId: string, adminUserId: string) {
  const [updated] = await db
    .update(supportConversations)
    .set({
      status: 'closed',
      closedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(supportConversations.id, conversationId))
    .returning();

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found');

  // Get agent name
  const [agent] = await db
    .select({ name: adminUsers.name })
    .from(adminUsers)
    .where(eq(adminUsers.id, adminUserId))
    .limit(1);

  // System message
  await db.insert(supportMessages).values({
    conversationId,
    role: 'assistant',
    content: `Chat closed by ${agent?.name ?? 'agent'}.`,
    senderName: 'System',
  });

  try {
    const io = getIO();
    io.to(`support:${conversationId}`).emit('support:closed', {
      conversationId,
      closedBy: agent?.name ?? 'agent',
    });
  } catch {}

  return { conversationId, status: 'closed' };
}

// ─── Legacy: reply (kept for backward compatibility, also emits socket) ───

export async function replySupportMessage(
  conversationId: string, 
  content: string, 
  adminUserId?: string,
  type: string = 'text',
  mediaUrl?: string
) {
  const [conv] = await db
    .select({ id: supportConversations.id })
    .from(supportConversations)
    .where(eq(supportConversations.id, conversationId))
    .limit(1);

  if (!conv) throw new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found');

  let senderName = 'Support Agent';
  if (adminUserId) {
    const [agent] = await db
      .select({ name: adminUsers.name })
      .from(adminUsers)
      .where(eq(adminUsers.id, adminUserId))
      .limit(1);
    senderName = agent?.name ?? 'Support Agent';
  }

  const [msg] = await db
    .insert(supportMessages)
    .values({
      conversationId,
      role: 'assistant',
      content,
      type,
      mediaUrl,
      senderName,
    })
    .returning();

  await db
    .update(supportConversations)
    .set({ updatedAt: new Date() })
    .where(eq(supportConversations.id, conversationId));

  const messagePayload = {
    ...msg,
    createdAt: msg.createdAt?.toISOString() ?? null,
  };

  try {
    const io = getIO();
    io.to(`support:${conversationId}`).emit('support:message', messagePayload);
  } catch {}

  return messagePayload;
}

// ─── Customer: list own conversations ───

export async function listCustomerConversations(userId: string) {
  const rows = await db
    .select({
      id: supportConversations.id,
      title: supportConversations.title,
      category: supportConversations.category,
      status: supportConversations.status,
      agentName: supportConversations.agentName,
      createdAt: supportConversations.createdAt,
      updatedAt: supportConversations.updatedAt,
    })
    .from(supportConversations)
    .where(eq(supportConversations.userId, userId))
    .orderBy(desc(supportConversations.updatedAt))
    .limit(20);

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt?.toISOString() ?? null,
    updatedAt: r.updatedAt?.toISOString() ?? null,
  }));
}
