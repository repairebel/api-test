import { eq, and, desc, sql, isNull, inArray, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  disputes,
  disputeMessages,
  jobs,
  jobStatusEvents,
  shops,
} from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { getIO } from '../../lib/socket.js';
import { notifyShop, notifyCustomer } from '../../lib/notify.js';

// ═══════════════════════════════════════════════
// CUSTOMER: Create dispute
// ═══════════════════════════════════════════════

interface CreateDisputeInput {
  reasonCode: 'DEVICE_NOT_FIXED' | 'NEW_DAMAGE' | 'WRONG_REPAIR' | 'MISSING_PARTS' | 'OVERCHARGED' | 'OTHER';
  description: string;
  evidenceUrls?: string[];
  disputeVideoUrl?: string;
  disputeVideoDurationMs?: number;
}

export async function createDispute(
  jobId: string,
  customerId: string,
  input: CreateDisputeInput,
) {
  // Verify job exists and belongs to customer
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }
  if (job.customerId !== customerId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This job does not belong to you');
  }

  // Only allow disputes on READY or COMPLETED jobs (payment captured but not yet released, or held)
  if (!['READY', 'COMPLETED'].includes(job.status)) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      'Disputes can only be filed on READY or COMPLETED jobs',
    );
  }

  // Cannot dispute if payment was already refunded (customer already got money back)
  if (job.paymentStatus === 'REFUNDED') {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      'Cannot file dispute — payment has already been refunded',
    );
  }

  // Check no existing open dispute for this job
  const [existingDispute] = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(
      and(
        eq(disputes.jobId, jobId),
        inArray(disputes.status, ['OPEN', 'UNDER_REVIEW']),
      ),
    )
    .limit(1);

  if (existingDispute) {
    throw new AppError(409, ErrorCode.CONFLICT, 'An active dispute already exists for this job');
  }

  // Validate dispute video (mandatory, minimum 10 seconds)
  if (!input.disputeVideoUrl) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      'Dispute video is required. Please upload a video showing the issue.',
    );
  }

  if (!input.disputeVideoDurationMs || input.disputeVideoDurationMs < 10000) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      'Dispute video must be at least 10 seconds long.',
    );
  }

  const previousStatus = job.status;

  // Create dispute + set job to DISPUTED in a transaction
  const [dispute] = await db.transaction(async (tx) => {
    const [newDispute] = await tx
      .insert(disputes)
      .values({
        jobId,
        customerId,
        shopId: job.shopId,
        reasonCode: input.reasonCode,
        description: input.description,
        evidenceUrls: input.evidenceUrls ?? [],
        disputeVideoUrl: input.disputeVideoUrl,
        disputeVideoDurationMs: String(input.disputeVideoDurationMs),
      })
      .returning();

    // Set job status to DISPUTED
    await tx
      .update(jobs)
      .set({
        status: 'DISPUTED',
        disputeReason: input.description,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));

    // Log status event
    await tx.insert(jobStatusEvents).values({
      jobId,
      fromStatus: previousStatus,
      toStatus: 'DISPUTED',
      note: `Dispute filed: ${input.reasonCode} — ${input.description.substring(0, 200)}`,
    });

    return [newDispute];
  });

  // Emit real-time events
  const io = getIO();
  const payload = {
    disputeId: dispute.id,
    jobId,
    status: dispute.status,
    reasonCode: dispute.reasonCode,
    event: 'dispute:created',
  };
  io.to(`job:${jobId}`).emit('dispute:updated', payload);
  await notifyShop({
    shopId: job.shopId,
    event: 'dispute:updated',
    payload,
    push: { title: 'Dispute Filed', body: 'A customer has filed a dispute on a job.', data: { screen: 'dispute-detail', disputeId: dispute.id, jobId } },
    persist: {
      category: 'dispute',
      title: 'Dispute Filed',
      body: 'A customer has filed a dispute on a job.',
      data: { screen: 'dispute-detail', disputeId: dispute.id, jobId },
    },
  });
  await notifyCustomer({
    customerId,
    event: 'dispute:updated',
    payload,
    persist: {
      category: 'dispute',
      title: 'Dispute Filed',
      body: 'Your dispute has been submitted.',
      data: { screen: 'dispute-detail', disputeId: dispute.id, jobId },
    },
  });
  // Notify admin dashboard about the new dispute
  try {
    const { notifyAdmin } = await import('../../lib/notify.js');
    await notifyAdmin({
      event: 'dispute:created',
      payload: { disputeId: dispute.id, jobId, reasonCode: dispute.reasonCode },
      persist: undefined,
    });
  } catch {}

  // Also emit job:status for UI updates
  io.to(`job:${jobId}`).emit('job:status', { jobId, status: 'DISPUTED', previousStatus });
  await notifyShop({
    shopId: job.shopId,
    event: 'job:status',
    payload: { jobId, status: 'DISPUTED', previousStatus },
  });

  return dispute;
}

// ═══════════════════════════════════════════════
// SHOP: List disputes
// ═══════════════════════════════════════════════

export async function listShopDisputes(shopId: string, status?: string) {
  const conditions = [eq(disputes.shopId, shopId)];
  if (status && status !== 'ALL') {
    conditions.push(eq(disputes.status, status as any));
  }

  const rows = await db
    .select({
      id: disputes.id,
      jobId: disputes.jobId,
      customerId: disputes.customerId,
      reasonCode: disputes.reasonCode,
      description: disputes.description,
      evidenceUrls: disputes.evidenceUrls,
      disputeVideoUrl: disputes.disputeVideoUrl,
      status: disputes.status,
      createdAt: disputes.createdAt,
      updatedAt: disputes.updatedAt,
      // Job info
      deviceBrand: jobs.deviceBrand,
      deviceModel: jobs.deviceModel,
      customerName: jobs.customerName,
      priceCents: jobs.priceCents,
      paymentStatus: jobs.paymentStatus,
      customerInitialVideoUrl: jobs.customerInitialVideoUrl,
      shopCompletionVideoUrl: jobs.shopCompletionVideoUrl,
    })
    .from(disputes)
    .innerJoin(jobs, eq(disputes.jobId, jobs.id))
    .where(and(...conditions))
    .orderBy(desc(disputes.createdAt));

  return rows.map((r) => ({
    id: r.id,
    jobId: r.jobId,
    customerId: r.customerId,
    reasonCode: r.reasonCode,
    description: r.description,
    evidenceUrls: r.evidenceUrls,
    status: r.status,
    createdAt: r.createdAt?.toISOString() ?? null,
    updatedAt: r.updatedAt?.toISOString() ?? null,
    device: `${r.deviceBrand} ${r.deviceModel}`,
    customerName: r.customerName,
    priceCents: r.priceCents,
    paymentStatus: r.paymentStatus,
  }));
}

// ═══════════════════════════════════════════════
// CUSTOMER: List my disputes
// ═══════════════════════════════════════════════

export async function listCustomerDisputes(customerId: string) {
  const rows = await db
    .select({
      id: disputes.id,
      jobId: disputes.jobId,
      shopId: disputes.shopId,
      reasonCode: disputes.reasonCode,
      description: disputes.description,
      evidenceUrls: disputes.evidenceUrls,
      disputeVideoUrl: disputes.disputeVideoUrl,
      status: disputes.status,
      createdAt: disputes.createdAt,
      updatedAt: disputes.updatedAt,
      // Job info
      deviceBrand: jobs.deviceBrand,
      deviceModel: jobs.deviceModel,
      priceCents: jobs.priceCents,
      paymentStatus: jobs.paymentStatus,
      customerInitialVideoUrl: jobs.customerInitialVideoUrl,
      shopCompletionVideoUrl: jobs.shopCompletionVideoUrl,
      // Shop info
      shopName: shops.name,
    })
    .from(disputes)
    .innerJoin(jobs, eq(disputes.jobId, jobs.id))
    .innerJoin(shops, eq(disputes.shopId, shops.id))
    .where(eq(disputes.customerId, customerId))
    .orderBy(desc(disputes.createdAt));

  return rows.map((r) => ({
    id: r.id,
    jobId: r.jobId,
    shopId: r.shopId,
    reasonCode: r.reasonCode,
    description: r.description,
    evidenceUrls: r.evidenceUrls,
    status: r.status,
    createdAt: r.createdAt?.toISOString() ?? null,
    updatedAt: r.updatedAt?.toISOString() ?? null,
    device: `${r.deviceBrand} ${r.deviceModel}`,
    priceCents: r.priceCents,
    paymentStatus: r.paymentStatus,
    shopName: r.shopName,
  }));
}

// ═══════════════════════════════════════════════
// SHARED: Get dispute detail (with messages)
// ═══════════════════════════════════════════════

export async function getDisputeDetail(disputeId: string, actorId: string, actorRole: 'CUSTOMER' | 'SHOP') {
  const [dispute] = await db
    .select({
      id: disputes.id,
      jobId: disputes.jobId,
      customerId: disputes.customerId,
      shopId: disputes.shopId,
      reasonCode: disputes.reasonCode,
      description: disputes.description,
      evidenceUrls: disputes.evidenceUrls,
      status: disputes.status,
      createdAt: disputes.createdAt,
      updatedAt: disputes.updatedAt,
      // Job info
      deviceBrand: jobs.deviceBrand,
      deviceModel: jobs.deviceModel,
      customerName: jobs.customerName,
      priceCents: jobs.priceCents,
      paymentStatus: jobs.paymentStatus,
      customerInitialVideoUrl: jobs.customerInitialVideoUrl,
      shopCompletionVideoUrl: jobs.shopCompletionVideoUrl,
      disputeVideoUrl: disputes.disputeVideoUrl,
      disputeVideoDurationMs: disputes.disputeVideoDurationMs,
      // Shop info
      shopName: shops.name,
    })
    .from(disputes)
    .innerJoin(jobs, eq(disputes.jobId, jobs.id))
    .innerJoin(shops, eq(disputes.shopId, shops.id))
    .where(eq(disputes.id, disputeId))
    .limit(1);

  if (!dispute) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispute not found');
  }

  // Verify actor has access
  if (actorRole === 'CUSTOMER' && dispute.customerId !== actorId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Access denied');
  }
  if (actorRole === 'SHOP' && dispute.shopId !== actorId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Access denied');
  }

  // Get messages
  const messages = await db
    .select()
    .from(disputeMessages)
    .where(eq(disputeMessages.disputeId, disputeId))
    .orderBy(disputeMessages.createdAt);

  return {
    id: dispute.id,
    jobId: dispute.jobId,
    customerId: dispute.customerId,
    shopId: dispute.shopId,
    reasonCode: dispute.reasonCode,
    description: dispute.description,
    evidenceUrls: dispute.evidenceUrls,
    disputeVideoUrl: dispute.disputeVideoUrl,
    disputeVideoDurationMs: dispute.disputeVideoDurationMs,
    customerInitialVideoUrl: dispute.customerInitialVideoUrl,
    shopCompletionVideoUrl: dispute.shopCompletionVideoUrl,
    status: dispute.status,
    createdAt: dispute.createdAt?.toISOString() ?? null,
    updatedAt: dispute.updatedAt?.toISOString() ?? null,
    device: `${dispute.deviceBrand} ${dispute.deviceModel}`,
    customerName: dispute.customerName,
    priceCents: dispute.priceCents,
    paymentStatus: dispute.paymentStatus,
    shopName: dispute.shopName,
    messages: messages.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      senderRole: m.senderRole,
      message: m.message,
      evidenceUrls: m.evidenceUrls,
      createdAt: m.createdAt?.toISOString() ?? null,
    })),
  };
}

// ═══════════════════════════════════════════════
// SHOP: Respond to dispute
// ═══════════════════════════════════════════════

interface RespondInput {
  message: string;
  evidenceUrls?: string[];
}

export async function shopRespondToDispute(
  disputeId: string,
  shopId: string,
  userId: string,
  input: RespondInput,
) {
  const [dispute] = await db
    .select()
    .from(disputes)
    .where(and(eq(disputes.id, disputeId), eq(disputes.shopId, shopId)))
    .limit(1);

  if (!dispute) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispute not found');
  }

  if (['RESOLVED_REFUND', 'RESOLVED_RELEASED', 'REJECTED'].includes(dispute.status)) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'This dispute has already been resolved');
  }

  // Create message + update status to UNDER_REVIEW if still OPEN
  const [msg] = await db.transaction(async (tx) => {
    const [newMsg] = await tx
      .insert(disputeMessages)
      .values({
        disputeId,
        senderId: userId,
        senderRole: 'SHOP',
        message: input.message,
        evidenceUrls: input.evidenceUrls ?? [],
      })
      .returning();

    if (dispute.status === 'OPEN') {
      await tx
        .update(disputes)
        .set({ status: 'UNDER_REVIEW', updatedAt: new Date() })
        .where(eq(disputes.id, disputeId));
    } else {
      await tx
        .update(disputes)
        .set({ updatedAt: new Date() })
        .where(eq(disputes.id, disputeId));
    }

    return [newMsg];
  });

  const newStatus = dispute.status === 'OPEN' ? 'UNDER_REVIEW' : dispute.status;

  // Emit real-time events
  const io = getIO();
  const payload = {
    disputeId,
    jobId: dispute.jobId,
    status: newStatus,
    event: 'dispute:response',
    senderRole: 'SHOP',
  };
  io.to(`job:${dispute.jobId}`).emit('dispute:updated', payload);
  await notifyShop({
    shopId,
    event: 'dispute:updated',
    payload,
    persist: {
      category: 'dispute',
      title: 'Dispute Response',
      body: 'You responded to the dispute.',
      data: { screen: 'dispute-detail', disputeId, jobId: dispute.jobId },
    },
  });
  await notifyCustomer({
    customerId: dispute.customerId,
    event: 'dispute:updated',
    payload,
    push: { title: 'Dispute Update', body: 'The shop has responded to your dispute.', data: { screen: 'dispute-detail', disputeId, jobId: dispute.jobId } },
    persist: {
      category: 'dispute',
      title: 'Dispute Update',
      body: 'The shop has responded to your dispute.',
      data: { screen: 'dispute-detail', disputeId, jobId: dispute.jobId },
    },
  });

  return {
    message: {
      id: msg.id,
      senderId: msg.senderId,
      senderRole: msg.senderRole,
      message: msg.message,
      evidenceUrls: msg.evidenceUrls,
      createdAt: msg.createdAt?.toISOString() ?? null,
    },
    disputeStatus: newStatus,
  };
}

// ═══════════════════════════════════════════════
// CUSTOMER: Respond to dispute (add more info)
// ═══════════════════════════════════════════════

export async function customerRespondToDispute(
  disputeId: string,
  customerId: string,
  input: RespondInput,
) {
  const [dispute] = await db
    .select()
    .from(disputes)
    .where(and(eq(disputes.id, disputeId), eq(disputes.customerId, customerId)))
    .limit(1);

  if (!dispute) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispute not found');
  }

  if (['RESOLVED_REFUND', 'RESOLVED_RELEASED', 'REJECTED'].includes(dispute.status)) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'This dispute has already been resolved');
  }

  const [msg] = await db.transaction(async (tx) => {
    const [newMsg] = await tx
      .insert(disputeMessages)
      .values({
        disputeId,
        senderId: customerId,
        senderRole: 'CUSTOMER',
        message: input.message,
        evidenceUrls: input.evidenceUrls ?? [],
      })
      .returning();

    await tx
      .update(disputes)
      .set({ updatedAt: new Date() })
      .where(eq(disputes.id, disputeId));

    return [newMsg];
  });

  // Emit real-time events
  const io = getIO();
  const payload = {
    disputeId,
    jobId: dispute.jobId,
    status: dispute.status,
    event: 'dispute:response',
    senderRole: 'CUSTOMER',
  };
  io.to(`job:${dispute.jobId}`).emit('dispute:updated', payload);
  await notifyShop({
    shopId: dispute.shopId,
    event: 'dispute:updated',
    payload,
    push: { title: 'Dispute Update', body: 'Customer added new information to the dispute.', data: { screen: 'dispute-detail', disputeId, jobId: dispute.jobId } },
  });
  await notifyCustomer({ customerId, event: 'dispute:updated', payload });

  return {
    message: {
      id: msg.id,
      senderId: msg.senderId,
      senderRole: msg.senderRole,
      message: msg.message,
      evidenceUrls: msg.evidenceUrls,
      createdAt: msg.createdAt?.toISOString() ?? null,
    },
    disputeStatus: dispute.status,
  };
}

// ═══════════════════════════════════════════════
// ADMIN: Update dispute status
// ═══════════════════════════════════════════════

export async function updateDisputeStatus(
  disputeId: string,
  newStatus: 'IN_PROGRESS' | 'UNDER_REVIEW' | 'FINALIZING',
  adminNote?: string,
) {
  const [dispute] = await db
    .select()
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);

  if (!dispute) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispute not found');
  }

  if (['RESOLVED_REFUND', 'RESOLVED_RELEASED', 'REJECTED'].includes(dispute.status)) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Cannot update a resolved dispute');
  }

  await db
    .update(disputes)
    .set({
      status: newStatus,
      updatedAt: new Date(),
    })
    .where(eq(disputes.id, disputeId));

  // Emit real-time events
  const io = getIO();
  const payload = {
    disputeId,
    jobId: dispute.jobId,
    status: newStatus,
    event: 'dispute:status_updated',
  };
  io.to(`job:${dispute.jobId}`).emit('dispute:updated', payload);
  await notifyShop({ shopId: dispute.shopId, event: 'dispute:updated', payload });
  await notifyCustomer({
    customerId: dispute.customerId,
    event: 'dispute:updated',
    payload,
    push: { title: 'Dispute Update', body: `Dispute status updated to ${newStatus.replace(/_/g, ' ')}`, data: { screen: 'dispute-detail', disputeId, jobId: dispute.jobId } },
  });

  return { disputeId, status: newStatus };
}
