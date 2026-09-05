import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { jobs, jobStatusEvents, jobMedia, offers, inventoryItems, inventoryMovements, requests } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { getIO } from '../../lib/socket.js';
import { notifyShop, notifyCustomer } from '../../lib/notify.js';
import { env } from '../../config/env.js';

type JobStatus = 'BOOKED' | 'CHECKED_IN' | 'IN_PROGRESS' | 'READY' | 'COMPLETED' | 'DISPUTED' | 'CANCELLED';

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  BOOKED: ['CHECKED_IN', 'CANCELLED'],
  CHECKED_IN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['READY', 'CANCELLED'],
  // READY → COMPLETED is only allowed via customer confirmation (confirmCustomerJob)
  READY: [],
};

// ─── List jobs for a shop ───

export async function listShopJobs(
  shopId: string,
  status: string | undefined,
  page: number,
  pageSize: number,
) {
  const offset = (page - 1) * pageSize;

  const conditions = [eq(jobs.shopId, shopId)];
  if (status && status !== 'ALL') {
    // Support comma-separated statuses: BOOKED,IN_PROGRESS
    const statuses = status.split(',').map((s) => s.trim()) as JobStatus[];
    conditions.push(inArray(jobs.status, statuses));
  } else {
    // "ALL" tab: exclude CANCELLED jobs (terminal state, no dedicated tab)
    conditions.push(
      inArray(jobs.status, ['BOOKED', 'CHECKED_IN', 'IN_PROGRESS', 'READY', 'COMPLETED', 'DISPUTED'] as JobStatus[]),
    );
  }

  const whereClause = and(...conditions);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(whereClause);

  const rows = await db
    .select()
    .from(jobs)
    .where(whereClause)
    .orderBy(desc(jobs.createdAt))
    .limit(pageSize)
    .offset(offset);

  return {
    data: rows.map((j) => ({
      jobId: j.id,
      requestId: j.requestId,
      deviceBrand: j.deviceBrand,
      deviceModel: j.deviceModel,
      device: `${j.deviceBrand} ${j.deviceModel}`,
      issueDescription: j.issueDescription,
      customerName: j.customerName,
      priceCents: j.priceCents,
      etaMinutes: j.etaMinutes,
      warrantyDays: j.warrantyDays,
      partsQuality: j.partsQuality,
      status: j.status,
      paymentStatus: j.paymentStatus,
      scheduledAt: j.scheduledAt?.toISOString() ?? null,
      completedAt: j.completedAt?.toISOString() ?? null,
      proofCount: Array.isArray(j.proofMedia) ? j.proofMedia.length : 0,
      createdAt: j.createdAt?.toISOString() ?? null,
    })),
    total: count,
  };
}

// ─── Get single job (scoped to shop) ───

export async function getJobForShop(jobId: string, shopId: string) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.shopId, shopId)))
    .limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }

  // Load status timeline
  const events = await db
    .select()
    .from(jobStatusEvents)
    .where(eq(jobStatusEvents.jobId, jobId))
    .orderBy(jobStatusEvents.createdAt);

  // Load job media
  const media = await db
    .select()
    .from(jobMedia)
    .where(eq(jobMedia.jobId, jobId))
    .orderBy(jobMedia.createdAt);

  const hasVideoProof = media.some((m) => m.type === 'VIDEO');
  const customerInitialVideoUrl =
    job.customerInitialVideoUrl ??
    (
      await db
        .select({ videoUrl: requests.videoUrl })
        .from(requests)
        .where(eq(requests.id, job.requestId))
        .limit(1)
    )[0]?.videoUrl ??
    null;
  const shopCompletionVideoUrl =
    job.shopCompletionVideoUrl ??
    media.find((m) => m.type === 'VIDEO')?.url ??
    null;

  return {
    jobId: job.id,
    requestId: job.requestId,
    offerId: job.offerId,
    shopId: job.shopId,
    deviceBrand: job.deviceBrand,
    deviceModel: job.deviceModel,
    device: `${job.deviceBrand} ${job.deviceModel}`,
    issueDescription: job.issueDescription,
    customerName: job.customerName,
    priceCents: job.priceCents,
    etaMinutes: job.etaMinutes,
    warrantyDays: job.warrantyDays,
    partsQuality: job.partsQuality,
    status: job.status,
    paymentStatus: job.paymentStatus,
    scheduledAt: job.scheduledAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    proofMedia: job.proofMedia ?? [],
    customerInitialVideoUrl,
    shopCompletionVideoUrl,
    hasVideoProof,
    media: media.map((m) => ({
      id: m.id,
      type: m.type,
      url: m.url,
      thumbUrl: m.thumbUrl,
      durationMs: m.durationMs,
      createdAt: m.createdAt?.toISOString() ?? null,
    })),
    disputeReason: job.disputeReason,
    paymentError: job.paymentError,
    createdAt: job.createdAt?.toISOString() ?? null,
    timeline: events.map((e) => ({
      id: e.id,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      note: e.note,
      createdAt: e.createdAt?.toISOString() ?? null,
    })),
  };
}

// ─── Update job status ───

export async function updateJobStatus(
  jobId: string,
  shopId: string,
  newStatus: JobStatus,
  note?: string,
) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.shopId, shopId)))
    .limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }

  // Validate transition
  const allowed = ALLOWED_TRANSITIONS[job.status];
  if (!allowed || !allowed.includes(newStatus)) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Cannot transition from ${job.status} to ${newStatus}`,
    );
  }

  // Require at least one VIDEO proof before marking as READY
  if (newStatus === 'READY') {
    const [videoProof] = await db
      .select({ id: jobMedia.id })
      .from(jobMedia)
      .where(and(eq(jobMedia.jobId, jobId), eq(jobMedia.type, 'VIDEO')))
      .limit(1);

    if (!videoProof) {
      throw new AppError(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Video proof is required before marking a job as ready. Please upload a proof video first.',
      );
    }
  }

  const updateData: Record<string, any> = {
    status: newStatus,
    updatedAt: new Date(),
  };

  if (newStatus === 'COMPLETED') {
    updateData.completedAt = new Date();
  }

  // Update job
  const [updated] = await db
    .update(jobs)
    .set(updateData)
    .where(eq(jobs.id, jobId))
    .returning();

  // Write audit event
  await db.insert(jobStatusEvents).values({
    jobId,
    fromStatus: job.status,
    toStatus: newStatus,
    note: note ?? null,
  });

  // Auto-adjust inventory on CANCELLED: restore stock
  if (newStatus === 'CANCELLED') {
    try {
      const [offer] = await db
        .select({ reserveInventoryItemId: offers.reserveInventoryItemId })
        .from(offers)
        .where(eq(offers.id, job.offerId))
        .limit(1);

      if (offer?.reserveInventoryItemId) {
        await db
          .update(inventoryItems)
          .set({
            quantity: sql`${inventoryItems.quantity} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(inventoryItems.id, offer.reserveInventoryItemId));

        await db.insert(inventoryMovements).values({
          inventoryItemId: offer.reserveInventoryItemId,
          type: 'RELEASED',
          quantity: 1,
          referenceId: jobId,
          note: `Restored – job cancelled`,
        });
      }
    } catch (err) {
      console.error('Failed to restore inventory on cancel:', err);
    }

    // Auto-refund Stripe payment on cancellation
    if (job.stripePaymentIntentId && !job.stripePaymentIntentId.startsWith('pi_mock_') && env.STRIPE_SECRET_KEY) {
      try {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(env.STRIPE_SECRET_KEY);

        if (job.paymentStatus === 'HELD') {
          // Release the hold by cancelling the uncaptured PaymentIntent
          await stripe.paymentIntents.cancel(job.stripePaymentIntentId);
          console.log(`💸 PaymentIntent cancelled (hold released): ${job.stripePaymentIntentId}`);
        } else if (job.paymentStatus === 'CAPTURED') {
          // Full refund for captured payment
          const refund = await stripe.refunds.create({ payment_intent: job.stripePaymentIntentId });
          console.log(`💸 Refund created: ${refund.id} for PI ${job.stripePaymentIntentId}`);
        }

        await db.update(jobs).set({ paymentStatus: 'REFUNDED' }).where(eq(jobs.id, jobId));
      } catch (err: any) {
        console.error('⚠️ Stripe refund/cancel failed:', err.message);
      }
    } else if (job.stripePaymentIntentId?.startsWith('pi_mock_')) {
      // Mock refund for testing
      await db.update(jobs).set({ paymentStatus: 'REFUNDED' }).where(eq(jobs.id, jobId));
    } else {
      // No Stripe payment intent (test/dev) — still mark as REFUNDED so earnings don't show held
      await db.update(jobs).set({ paymentStatus: 'REFUNDED' }).where(eq(jobs.id, jobId));
    }
  }

  // If READY, capture the Stripe PaymentIntent (charge customer's card).
  // Money stays in platform balance until customer confirms & releases.
  if (newStatus === 'READY') {
    if (job.stripePaymentIntentId && !job.stripePaymentIntentId.startsWith('pi_mock_') && env.STRIPE_SECRET_KEY) {
      try {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(env.STRIPE_SECRET_KEY);
        const captured = await stripe.paymentIntents.capture(job.stripePaymentIntentId);
        console.log(`💰 PaymentIntent captured at READY: ${captured.id} — $${(captured.amount / 100).toFixed(2)}`);

        await db.update(jobs).set({ paymentStatus: 'CAPTURED', paymentError: null }).where(eq(jobs.id, jobId));
      } catch (err: any) {
        console.error('⚠️ Stripe capture failed at READY:', err.message);

        // Map Stripe error to user-friendly message
        let errorMessage = 'Payment capture failed';
        const stripeCode = err.code ?? err.decline_code ?? '';
        if (stripeCode === 'card_declined' || err.decline_code) {
          errorMessage = 'Card declined';
        } else if (stripeCode === 'insufficient_funds') {
          errorMessage = 'Insufficient funds';
        } else if (stripeCode === 'expired_card') {
          errorMessage = 'Card expired';
        } else if (err.message) {
          errorMessage = err.message;
        }

        // Revert job to IN_PROGRESS with PAYMENT_FAILED status
        await db.update(jobs).set({
          status: 'IN_PROGRESS',
          paymentStatus: 'PAYMENT_FAILED',
          paymentError: errorMessage,
          updatedAt: new Date(),
        }).where(eq(jobs.id, jobId));

        // Revert the status event we already wrote
        await db.insert(jobStatusEvents).values({
          jobId,
          fromStatus: 'READY',
          toStatus: 'IN_PROGRESS',
          note: `Payment capture failed: ${errorMessage}. Reverted to In Progress.`,
        });

        // Notify store: charge failed
        try {
          const io = getIO();
          await notifyShop({
            shopId,
            event: 'job:payment_failed',
            payload: { jobId, error: errorMessage, message: `Customer's card could not be charged: ${errorMessage}. Please ask the customer to update their card details.` },
            push: { title: 'Payment Failed', body: `Customer's card could not be charged for this job.`, data: { screen: 'job-details', jobId } },
            persist: {
              category: 'payout',
              title: 'Payment Failed',
              body: `Customer's card could not be charged for this job.`,
              data: { screen: 'job-details', jobId },
            },
          });
          io.to(`job:${jobId}`).emit('job:payment_failed', {
            jobId,
            error: errorMessage,
          });
          // Notify customer to update card
          await notifyCustomer({
            customerId: job.customerId,
            event: 'job:card_update_required',
            payload: { jobId, error: errorMessage, message: `Your card could not be charged: ${errorMessage}. Please update your card details to proceed with this repair.` },
            push: { title: 'Card Update Required', body: 'Your card could not be charged. Please update your payment method.', data: { screen: 'job-detail', jobId } },
            persist: {
              category: 'payout',
              title: 'Card Update Required',
              body: 'Your card could not be charged. Please update your payment method.',
              data: { screen: 'job-detail', jobId },
            },
          });
          // Also emit to job room so job-detail screen refreshes
          io.to(`job:${jobId}`).emit('job:card_update_required', {
            jobId,
            error: errorMessage,
          });
        } catch {}

        throw new AppError(
          402,
          ErrorCode.VALIDATION_ERROR,
          `Customer's card could not be charged: ${errorMessage}. Please tell the customer to update their card details.`,
        );
      }
    } else if (job.stripePaymentIntentId?.startsWith('pi_mock_')) {
      // Mock capture for testing without Stripe
      await db.update(jobs).set({ paymentStatus: 'CAPTURED', paymentError: null }).where(eq(jobs.id, jobId));
    }
  }

  // Emit Socket.IO events
  try {
    const io = getIO();
    const payload = {
      jobId,
      fromStatus: job.status,
      toStatus: newStatus,
      updatedAt: updated.updatedAt?.toISOString(),
    };
    await notifyShop({
      shopId,
      event: 'job:status',
      payload,
      push: { title: 'Job Status Updated', body: `Job moved to ${newStatus}`, data: { screen: 'job-details', jobId } },
      persist: {
        category: 'order',
        title: 'Job Status Updated',
        body: `Job moved to ${newStatus}`,
        data: { screen: 'job-details', jobId },
      },
    });

    // Notify the CUSTOMER about job status change
    const statusLabels: Record<string, string> = {
      CHECKED_IN: 'Your device has been checked in',
      IN_PROGRESS: 'Your repair is now in progress',
      READY: 'Your repair is ready for pickup!',
      CANCELLED: 'Your repair job has been cancelled',
    };
    const statusBody = statusLabels[newStatus] ?? `Job status changed to ${newStatus}`;
    await notifyCustomer({
      customerId: job.customerId,
      event: 'job:status',
      payload,
      push: { title: 'Repair Update', body: statusBody, data: { screen: 'job-detail', jobId } },
      persist: {
        category: 'order',
        title: 'Repair Update',
        body: statusBody,
        data: { screen: 'job-detail', jobId },
      },
    });

    io.to(`job:${jobId}`).emit('job:status', payload);

    // Emit payment event so UI can update payment badge
    if (newStatus === 'CANCELLED' || newStatus === 'READY') {
      await notifyShop({ shopId, event: 'job:payment', payload: { jobId } });
      io.to(`job:${jobId}`).emit('job:payment', { jobId });
    }
  } catch {}

  return {
    jobId: updated.id,
    status: updated.status,
    previousStatus: job.status,
    updatedAt: updated.updatedAt?.toISOString() ?? null,
  };
}
