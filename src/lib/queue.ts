import { Queue, Worker } from 'bullmq';
import { env } from '../config/env.js';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { offers, inventoryItems, inventoryMovements, jobs, payouts, jobStatusEvents } from '../db/schema/index.js';
import { getRedisConnectionOptions } from './redis-config.js';

const connection = getRedisConnectionOptions(env.REDIS_URL);

// ── Offer-expiry queue ──

export const offerExpiryQueue = new Queue('offer-expiry', { connection });

export async function scheduleOfferExpiry(offerId: string, delayMs: number) {
  await offerExpiryQueue.add(
    'expire-offer',
    { offerId },
    { delay: delayMs, removeOnComplete: true, removeOnFail: 100 },
  );
}

// ── Worker (processes expiry jobs) ──

export function startOfferExpiryWorker() {
  const worker = new Worker(
    'offer-expiry',
    async (job) => {
      const { offerId } = job.data as { offerId: string };

      // Only expire if still PENDING
      const [offer] = await db
        .select()
        .from(offers)
        .where(and(eq(offers.id, offerId), eq(offers.status, 'PENDING')))
        .limit(1);

      if (!offer) return; // already resolved

      // Expire the offer
      await db
        .update(offers)
        .set({ status: 'EXPIRED', updatedAt: new Date() })
        .where(eq(offers.id, offerId));

      // Release reserved inventory if any
      if (offer.reserveInventoryItemId) {
        await db
          .update(inventoryItems)
          .set({
            quantityReserved: await db
              .select({ qr: inventoryItems.quantityReserved })
              .from(inventoryItems)
              .where(eq(inventoryItems.id, offer.reserveInventoryItemId))
              .then((rows) => Math.max(0, (rows[0]?.qr ?? 1) - 1)),
            updatedAt: new Date(),
          })
          .where(eq(inventoryItems.id, offer.reserveInventoryItemId));

        await db.insert(inventoryMovements).values({
          inventoryItemId: offer.reserveInventoryItemId,
          type: 'RELEASED',
          quantity: 1,
          referenceId: offer.id,
        });
      }

      // Notify customer that the offer expired
      try {
        const { getIO } = await import('./socket.js');
        const io = getIO();
        io.to(`request:${offer.requestId}`).emit('offer:expired', {
          offerId,
          requestId: offer.requestId,
          shopId: offer.shopId,
        });
      } catch { /* socket not critical */ }

      console.log(`⏰ Offer ${offerId} expired by worker`);
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    console.error(`Offer expiry job ${job?.id} failed:`, err.message);
  });

  console.log('✅ Offer expiry worker started');
  return worker;
}

// ── Dispatch-timeout queue ──

export const dispatchTimeoutQueue = new Queue('dispatch-timeout', { connection });

export async function scheduleDispatchTimeout(
  dispatchId: string,
  requestId: string,
  delayMs: number,
) {
  await dispatchTimeoutQueue.add(
    'timeout-dispatch',
    { dispatchId, requestId },
    { delay: delayMs, removeOnComplete: true, removeOnFail: 100 },
  );
}

export function startDispatchTimeoutWorker() {
  // Dynamic import to avoid circular deps
  const worker = new Worker(
    'dispatch-timeout',
    async (job) => {
      const { dispatchId, requestId } = job.data as {
        dispatchId: string;
        requestId: string;
      };
      // Lazy import to break circular reference
      const { timeoutDispatch } = await import(
        '../modules/dispatch/dispatch.service.js'
      );
      await timeoutDispatch(dispatchId, requestId);
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    console.error(`Dispatch timeout job ${job?.id} failed:`, err.message);
  });

  console.log('✅ Dispatch timeout worker started');
  return worker;
}

// ── Payout-release queue ──

export const payoutReleaseQueue = new Queue('payout-release', { connection });

export async function schedulePayoutRelease(jobId: string, delayMs: number) {
  await payoutReleaseQueue.add(
    'release-payout',
    { jobId },
    { delay: delayMs, removeOnComplete: true, removeOnFail: 100 },
  );
}

export function startPayoutReleaseWorker() {
  const worker = new Worker(
    'payout-release',
    async (job) => {
      const { jobId } = job.data as { jobId: string };

      // Only release if still COMPLETED and HELD or CAPTURED
      const [j] = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'COMPLETED'), inArray(jobs.paymentStatus, ['HELD', 'CAPTURED'])))
        .limit(1);

      if (!j) return; // disputed or already released

      const netAmount = j.priceCents - (j.platformFeeCents ?? 0);

      // ── Transfer funds from platform to Connected account ──
      let stripeTransferId: string | null = null;
      try {
        const { shops } = await import('../db/schema/index.js');
        const [shop] = await db
          .select({ stripeAccountId: shops.stripeAccountId })
          .from(shops)
          .where(eq(shops.id, j.shopId))
          .limit(1);

        const acct = shop?.stripeAccountId;
        const { env } = await import('../config/env.js');
        if (acct && !acct.startsWith('acct_mock_') && env.STRIPE_SECRET_KEY && j.stripePaymentIntentId && !j.stripePaymentIntentId.startsWith('pi_mock_')) {
          const Stripe = (await import('stripe')).default;
          const stripe = new Stripe(env.STRIPE_SECRET_KEY);

          // Get charge ID for source_transaction → instant availability
          const pi = await stripe.paymentIntents.retrieve(j.stripePaymentIntentId);
          const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge as any)?.id;

          const transferParams: any = {
            amount: netAmount,
            currency: 'usd',
            destination: acct,
            transfer_group: j.id,
            metadata: { jobId: j.id, shopId: j.shopId },
          };
          if (chargeId) {
            transferParams.source_transaction = chargeId;
          }

          const transfer = await stripe.transfers.create(transferParams);
          stripeTransferId = transfer.id;
          console.log(`💸 Auto-release transfer ${transfer.id} — $${(netAmount / 100).toFixed(2)} → ${acct} (source: ${chargeId ?? 'none'})`);
        }
      } catch (err: any) {
        console.error('⚠️ Auto-release Stripe Transfer failed:', err.message);
      }

      await db
        .update(jobs)
        .set({ paymentStatus: 'RELEASED', updatedAt: new Date() })
        .where(eq(jobs.id, jobId));

      // Create payout record for auto-release
      await db.insert(payouts).values({
        shopId: j.shopId,
        jobId: j.id,
        amountCents: j.priceCents,
        platformFeeCents: j.platformFeeCents ?? 0,
        netAmountCents: netAmount,
        stripeTransferId,
        status: 'COMPLETED',
        completedAt: new Date(),
      });

      // Create audit event
      await db.insert(jobStatusEvents).values({
        jobId,
        fromStatus: 'COMPLETED',
        toStatus: 'COMPLETED',
        note: 'Payment auto-released & transferred after 24h hold period',
      });

      console.log(`💰 Payout released for job ${jobId}`);
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    console.error(`Payout release job ${job?.id} failed:`, err.message);
  });

  console.log('✅ Payout release worker started');
  return worker;
}
