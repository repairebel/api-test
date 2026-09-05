import { eq, and, or, ilike, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { disputes, disputeMessages, jobs, shops, requests, payouts } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { env } from '../../config/env.js';

interface ListDisputesQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
}

export async function listDisputes(query: ListDisputesQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.status) conditions.push(eq(disputes.status, query.status as any));
  if (query.search) {
    conditions.push(
      or(
        ilike(disputes.description, `%${query.search}%`),
        ilike(shops.name, `%${query.search}%`),
        ilike(jobs.customerName, `%${query.search}%`),
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: disputes.id,
        jobId: disputes.jobId,
        customerId: disputes.customerId,
        shopId: disputes.shopId,
        shopName: shops.name,
        reasonCode: disputes.reasonCode,
        description: disputes.description,
        evidenceUrls: disputes.evidenceUrls,
        status: disputes.status,
        disputeVideoUrl: disputes.disputeVideoUrl,
        disputeVideoDurationMs: disputes.disputeVideoDurationMs,
        customerName: jobs.customerName,
        deviceBrand: jobs.deviceBrand,
        deviceModel: jobs.deviceModel,
        priceCents: jobs.priceCents,
        paymentStatus: jobs.paymentStatus,
        stripePaymentIntentId: jobs.stripePaymentIntentId,
        customerInitialVideoUrl: jobs.customerInitialVideoUrl,
        shopCompletionVideoUrl: jobs.shopCompletionVideoUrl,
        proofMedia: jobs.proofMedia,
        requestVideoUrl: requests.videoUrl,
        requestPhotos: requests.photos,
        createdAt: disputes.createdAt,
        updatedAt: disputes.updatedAt,
      })
      .from(disputes)
      .leftJoin(shops, eq(shops.id, disputes.shopId))
      .leftJoin(jobs, eq(jobs.id, disputes.jobId))
      .leftJoin(requests, eq(requests.id, jobs.requestId))
      .where(where)
      .orderBy(desc(disputes.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(disputes)
      .leftJoin(shops, eq(shops.id, disputes.shopId))
      .leftJoin(jobs, eq(jobs.id, disputes.jobId))
      .where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      customerRequestVideoProvided: Boolean(r.requestVideoUrl),
      createdAt: r.createdAt?.toISOString() ?? null,
      updatedAt: r.updatedAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function getDisputeById(disputeId: string) {
  const [dispute] = await db
    .select({
      id: disputes.id,
      jobId: disputes.jobId,
      customerId: disputes.customerId,
      shopId: disputes.shopId,
      shopName: shops.name,
      reasonCode: disputes.reasonCode,
      description: disputes.description,
      evidenceUrls: disputes.evidenceUrls,
      status: disputes.status,
      disputeVideoUrl: disputes.disputeVideoUrl,
      disputeVideoDurationMs: disputes.disputeVideoDurationMs,
      customerName: jobs.customerName,
      deviceBrand: jobs.deviceBrand,
      deviceModel: jobs.deviceModel,
      priceCents: jobs.priceCents,
      paymentStatus: jobs.paymentStatus,
      stripePaymentIntentId: jobs.stripePaymentIntentId,
      customerInitialVideoUrl: jobs.customerInitialVideoUrl,
      shopCompletionVideoUrl: jobs.shopCompletionVideoUrl,
      proofMedia: jobs.proofMedia,
      requestVideoUrl: requests.videoUrl,
      requestPhotos: requests.photos,
      createdAt: disputes.createdAt,
      updatedAt: disputes.updatedAt,
    })
    .from(disputes)
    .leftJoin(shops, eq(shops.id, disputes.shopId))
    .leftJoin(jobs, eq(jobs.id, disputes.jobId))
    .leftJoin(requests, eq(requests.id, jobs.requestId))
    .where(eq(disputes.id, disputeId))
    .limit(1);

  if (!dispute) throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispute not found');

  return {
    ...dispute,
    customerRequestVideoProvided: Boolean(dispute.requestVideoUrl),
    createdAt: dispute.createdAt?.toISOString() ?? null,
    updatedAt: dispute.updatedAt?.toISOString() ?? null,
  };
}

export async function getDisputeMessages(disputeId: string) {
  const rows = await db
    .select()
    .from(disputeMessages)
    .where(eq(disputeMessages.disputeId, disputeId))
    .orderBy(disputeMessages.createdAt);

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt?.toISOString() ?? null,
  }));
}

export async function sendDisputeMessage(disputeId: string, adminUserId: string, message: string) {
  const [dispute] = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);
  if (!dispute) throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispute not found');

  const [msg] = await db
    .insert(disputeMessages)
    .values({
      disputeId,
      senderId: adminUserId,
      senderRole: 'ADMIN',
      message,
    })
    .returning();

  // Update dispute to UNDER_REVIEW if currently OPEN
  await db
    .update(disputes)
    .set({ status: 'UNDER_REVIEW', updatedAt: new Date() })
    .where(and(eq(disputes.id, disputeId), eq(disputes.status, 'OPEN')));

  return { ...msg, createdAt: msg.createdAt?.toISOString() ?? null };
}

// ─── Stripe refund helper ───
async function processStripeRefund(
  stripePaymentIntentId: string | null,
  amountCents?: number,
  stripeTransferId?: string | null,
): Promise<{ refunded: boolean; refundId?: string; transferReversalId?: string; reason?: string }> {
  if (!stripePaymentIntentId) {
    return { refunded: false, reason: 'No payment intent on record' };
  }
  if (stripePaymentIntentId.startsWith('pi_mock_')) {
    return { refunded: true, refundId: `re_mock_${Date.now()}`, reason: 'Mock refund (test mode)' };
  }
  if (!env.STRIPE_SECRET_KEY) {
    return { refunded: false, reason: 'Stripe not configured on server' };
  }

  try {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);

    let transferReversalId: string | undefined;

    // If a transfer was already made to the shop, reverse it first
    // so the refund comes from the shop's connected account, not RepairRebel
    if (stripeTransferId && !stripeTransferId.startsWith('tr_mock_')) {
      try {
        const reversalParams: any = {};
        if (amountCents && amountCents > 0) {
          reversalParams.amount = amountCents;
        }
        const reversal = await stripe.transfers.createReversal(stripeTransferId, reversalParams);
        transferReversalId = reversal.id;
        console.log(`↩️ Transfer reversal ${reversal.id} for transfer ${stripeTransferId}${amountCents ? ` amount=${amountCents}` : ' (full)'}`);
      } catch (err: any) {
        console.error('⚠️ Transfer reversal failed (will still attempt refund):', err.message);
      }
    }

    // Refund the customer from the platform payment intent
    const params: { payment_intent: string; amount?: number } = {
      payment_intent: stripePaymentIntentId,
    };
    if (amountCents && amountCents > 0) {
      params.amount = amountCents;
    }

    const refund = await stripe.refunds.create(params);
    console.log(`💸 Stripe refund created: ${refund.id} for PI ${stripePaymentIntentId}${amountCents ? ` amount=${amountCents}` : ' (full)'}`);
    return { refunded: true, refundId: refund.id, transferReversalId };
  } catch (err: any) {
    console.error('⚠️ Stripe refund failed:', err.message);
    return { refunded: false, reason: err.message };
  }
}

// ─── Resolve dispute with refund ───
interface RefundOptions {
  type: 'full' | 'partial';
  amountCents?: number;
}

export async function resolveDisputeRefund(disputeId: string, options?: RefundOptions) {
  const [dispute] = await db
    .select({
      id: disputes.id,
      status: disputes.status,
      jobId: disputes.jobId,
    })
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);

  if (!dispute) throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispute not found');
  if (dispute.status === 'RESOLVED_REFUND' || dispute.status === 'RESOLVED_RELEASED') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Dispute already resolved');
  }

  // Get the job to access Stripe payment intent
  const [job] = await db
    .select({
      id: jobs.id,
      stripePaymentIntentId: jobs.stripePaymentIntentId,
      priceCents: jobs.priceCents,
      paymentStatus: jobs.paymentStatus,
    })
    .from(jobs)
    .where(eq(jobs.id, dispute.jobId))
    .limit(1);

  if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Associated job not found');

  // Check if money was already transferred to the shop's connected account
  const [payout] = await db
    .select({ stripeTransferId: payouts.stripeTransferId })
    .from(payouts)
    .where(and(eq(payouts.jobId, dispute.jobId), eq(payouts.status, 'COMPLETED')))
    .limit(1);

  // Determine refund amount
  const isPartial = options?.type === 'partial' && options.amountCents && options.amountCents > 0;
  const refundAmountCents = isPartial ? options!.amountCents! : undefined;

  if (isPartial && refundAmountCents! > job.priceCents) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Refund amount exceeds job price');
  }

  // Process Stripe refund (reverses transfer first if one exists)
  const stripeResult = await processStripeRefund(
    job.stripePaymentIntentId,
    refundAmountCents,
    payout?.stripeTransferId,
  );

  // Mark dispute as resolved
  await db.update(disputes).set({ status: 'RESOLVED_REFUND', updatedAt: new Date() }).where(eq(disputes.id, disputeId));

  // Mark job payment as refunded
  await db.update(jobs).set({ paymentStatus: 'REFUNDED', updatedAt: new Date() }).where(eq(jobs.id, dispute.jobId));

  return {
    message: 'Dispute resolved with refund',
    disputeId,
    refundAmountCents: refundAmountCents ?? job.priceCents,
    stripe: stripeResult,
  };
}

// ─── Close dispute (release payment to shop) ───
export async function closeDispute(disputeId: string) {
  const [dispute] = await db
    .select({ id: disputes.id, status: disputes.status })
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);

  if (!dispute) throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispute not found');
  if (dispute.status === 'RESOLVED_REFUND' || dispute.status === 'RESOLVED_RELEASED' || dispute.status === 'REJECTED') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Dispute already closed');
  }

  await db.update(disputes).set({ status: 'RESOLVED_RELEASED', updatedAt: new Date() }).where(eq(disputes.id, disputeId));
  return { message: 'Dispute closed (payment released to shop)', disputeId };
}

// ─── Reject dispute ───
export async function rejectDispute(disputeId: string) {
  const [dispute] = await db
    .select({ id: disputes.id, status: disputes.status })
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);

  if (!dispute) throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispute not found');
  if (dispute.status === 'RESOLVED_REFUND' || dispute.status === 'RESOLVED_RELEASED' || dispute.status === 'REJECTED') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Dispute already resolved');
  }

  await db.update(disputes).set({ status: 'REJECTED', updatedAt: new Date() }).where(eq(disputes.id, disputeId));
  return { message: 'Dispute rejected', disputeId };
}

// ─── Update dispute status ───
export async function updateDisputeStatus(
  disputeId: string,
  newStatus: 'IN_PROGRESS' | 'UNDER_REVIEW' | 'FINALIZING',
) {
  const [dispute] = await db
    .select({ id: disputes.id, status: disputes.status })
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);

  if (!dispute) throw new AppError(404, ErrorCode.NOT_FOUND, 'Dispute not found');
  if (['RESOLVED_REFUND', 'RESOLVED_RELEASED', 'REJECTED'].includes(dispute.status)) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Cannot update a resolved dispute');
  }

  await db.update(disputes).set({ status: newStatus, updatedAt: new Date() }).where(eq(disputes.id, disputeId));
  return { message: `Dispute status updated to ${newStatus}`, disputeId, status: newStatus };
}
