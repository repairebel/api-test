import { and, desc, eq, inArray } from 'drizzle-orm';
import Stripe from 'stripe';
import { db } from '../../db/client.js';
import {
  jobs,
  orderAdjustments,
  orderTips,
  payouts,
  shops,
} from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { ensureStripeCustomerForUser } from '../../lib/stripe-customers.js';
import { notifyCustomer, notifyShop } from '../../lib/notify.js';
import { getIO } from '../../lib/socket.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { getShopFeeRates } from '../../lib/shop-fees.js';

async function savedPaymentMethod(stripe: Stripe, customerId: string) {
  const stripeCustomerId = await ensureStripeCustomerForUser(stripe, customerId);
  const customer = await stripe.customers.retrieve(stripeCustomerId);
  if (customer.deleted) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Your payment profile is unavailable. Please add a card in Payment Methods.');
  }
  const defaultPaymentMethod = customer.invoice_settings.default_payment_method;
  if (typeof defaultPaymentMethod === 'string') return { stripeCustomerId, paymentMethodId: defaultPaymentMethod };
  if (defaultPaymentMethod?.id) return { stripeCustomerId, paymentMethodId: defaultPaymentMethod.id };
  const methods = await stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card', limit: 1 });
  if (!methods.data[0]) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'No saved card was found. Please add a card in Payment Methods.');
  }
  return { stripeCustomerId, paymentMethodId: methods.data[0].id };
}

function stripeMessage(error: any) {
  const code = error?.decline_code ?? error?.code ?? '';
  if (code === 'insufficient_funds') return 'Insufficient funds. Please use a different card.';
  if (code === 'expired_card') return 'Your saved card has expired. Please use a different card.';
  if (code === 'incorrect_cvc') return 'The saved card could not be verified. Please update it and try again.';
  if (code === 'card_declined') return 'Your card was declined. Please use a different card.';
  return error?.message || 'The payment could not be authorized. Please try again.';
}

export function serializeAdjustment(row: typeof orderAdjustments.$inferSelect | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.jobId,
    previousPriceCents: row.previousPriceCents,
    adjustmentCents: row.adjustmentCents,
    newTotalCents: row.newTotalCents,
    status: row.status,
    paymentError: row.paymentError,
    createdAt: row.createdAt.toISOString(),
    respondedAt: row.respondedAt?.toISOString() ?? null,
  };
}

export function serializeTip(row: typeof orderTips.$inferSelect | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.jobId,
    amountCents: row.amountCents,
    platformFeeCents: row.platformFeeCents,
    status: row.status,
    paymentError: row.paymentError,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export async function getLatestAdjustment(jobId: string) {
  return (await db.select().from(orderAdjustments).where(eq(orderAdjustments.jobId, jobId)).orderBy(desc(orderAdjustments.createdAt)).limit(1))[0];
}

export async function getJobTip(jobId: string) {
  return (await db.select().from(orderTips).where(eq(orderTips.jobId, jobId)).limit(1))[0];
}

export async function requestAdjustment(jobId: string, shopId: string, adjustmentCents: number) {
  const [job] = await db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.shopId, shopId))).limit(1);
  if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  if (!['BOOKED', 'CHECKED_IN', 'IN_PROGRESS'].includes(job.status)) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Price adjustments can only be requested before the repair is marked ready.');
  }
  const pending = await db.select({ id: orderAdjustments.id }).from(orderAdjustments).where(and(eq(orderAdjustments.jobId, jobId), eq(orderAdjustments.status, 'REQUESTED'))).limit(1);
  if (pending[0]) throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'This order already has an adjustment waiting for the customer.');

  const [created] = await db.insert(orderAdjustments).values({
    jobId,
    shopId,
    customerId: job.customerId,
    previousPriceCents: job.priceCents,
    adjustmentCents,
    newTotalCents: job.priceCents + adjustmentCents,
  }).returning();

  const payload = { jobId, adjustment: serializeAdjustment(created) };
  await notifyCustomer({
    customerId: job.customerId,
    event: 'job:adjustment_requested',
    payload,
    push: { title: 'Price adjustment requested', body: `The store found additional work and requested $${(adjustmentCents / 100).toFixed(2)} more.`, data: { screen: 'job-detail', jobId } },
    persist: { category: 'order', title: 'Price adjustment requested', body: `Review an additional charge of $${(adjustmentCents / 100).toFixed(2)} for your repair.`, data: { screen: 'job-detail', jobId } },
  });
  getIO().to(`job:${jobId}`).emit('job:adjustment', payload);
  return serializeAdjustment(created);
}

async function finalizeAuthorizedAdjustment(adjustmentId: string, customerId: string, stripePaymentIntentId: string) {
  const [adjustment] = await db.select().from(orderAdjustments).where(and(eq(orderAdjustments.id, adjustmentId), eq(orderAdjustments.customerId, customerId))).limit(1);
  if (!adjustment) throw new AppError(404, ErrorCode.NOT_FOUND, 'Adjustment request not found');
  if (adjustment.status === 'AUTHORIZED' || adjustment.status === 'CAPTURED') return serializeAdjustment(adjustment);
  if (adjustment.status !== 'REQUESTED') throw new AppError(400, ErrorCode.VALIDATION_ERROR, `This adjustment is ${adjustment.status.toLowerCase()}.`);

  if (env.STRIPE_SECRET_KEY && !stripePaymentIntentId.startsWith('pi_mock_')) {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
    const expectedCustomer = await ensureStripeCustomerForUser(stripe, customerId);
    const piCustomer = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id;
    if (pi.status === 'requires_action') {
      return { requiresAction: true, adjustmentId, stripePaymentIntentId, paymentClientSecret: pi.client_secret, publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '' };
    }
    if (pi.status !== 'requires_capture' || pi.amount !== adjustment.adjustmentCents || pi.currency !== 'usd' || pi.capture_method !== 'manual' || piCustomer !== expectedCustomer || pi.metadata.adjustmentId !== adjustmentId || pi.metadata.jobId !== adjustment.jobId) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'Payment authorization does not match this adjustment.');
    }
  }

  const feePercent = (await getShopFeeRates(adjustment.shopId)).commissionPercent;
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx.update(orderAdjustments).set({ status: 'AUTHORIZED', stripePaymentIntentId, respondedAt: new Date(), updatedAt: new Date(), paymentError: null }).where(and(eq(orderAdjustments.id, adjustmentId), eq(orderAdjustments.status, 'REQUESTED'))).returning();
    if (!rows[0]) return [];
    await tx.update(jobs).set({ priceCents: adjustment.newTotalCents, platformFeeCents: Math.round(adjustment.newTotalCents * feePercent / 100), updatedAt: new Date() }).where(eq(jobs.id, adjustment.jobId));
    return rows;
  });
  if (!updated) return serializeAdjustment(await getLatestAdjustment(adjustment.jobId));

  const payload = { jobId: adjustment.jobId, adjustment: serializeAdjustment(updated) };
  await notifyShop({
    shopId: adjustment.shopId,
    event: 'job:adjustment_approved',
    payload,
    push: { title: 'Adjustment approved', body: `The customer approved the additional $${(adjustment.adjustmentCents / 100).toFixed(2)}.`, data: { screen: 'job-details', jobId: adjustment.jobId } },
    persist: { category: 'order', title: 'Adjustment approved', body: `The customer approved the additional $${(adjustment.adjustmentCents / 100).toFixed(2)}.`, data: { screen: 'job-details', jobId: adjustment.jobId } },
  });
  getIO().to(`job:${adjustment.jobId}`).emit('job:adjustment', payload);
  return serializeAdjustment(updated);
}

export async function approveAdjustment(adjustmentId: string, customerId: string) {
  const [adjustment] = await db.select().from(orderAdjustments).where(and(eq(orderAdjustments.id, adjustmentId), eq(orderAdjustments.customerId, customerId))).limit(1);
  if (!adjustment) throw new AppError(404, ErrorCode.NOT_FOUND, 'Adjustment request not found');
  if (adjustment.status !== 'REQUESTED') throw new AppError(400, ErrorCode.VALIDATION_ERROR, `This adjustment is ${adjustment.status.toLowerCase()}.`);

  if (adjustment.stripePaymentIntentId) {
    return finalizeAuthorizedAdjustment(adjustmentId, customerId, adjustment.stripePaymentIntentId);
  }

  if (!env.STRIPE_SECRET_KEY) return finalizeAuthorizedAdjustment(adjustmentId, customerId, `pi_mock_adjustment_${adjustmentId}`);
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const { stripeCustomerId, paymentMethodId } = await savedPaymentMethod(stripe, customerId);
  const metadata = { type: 'order_adjustment', adjustmentId, jobId: adjustment.jobId, shopId: adjustment.shopId, customerId };
  try {
    let pi: Stripe.PaymentIntent;
    try {
      pi = await stripe.paymentIntents.create({ amount: adjustment.adjustmentCents, currency: 'usd', capture_method: 'manual', customer: stripeCustomerId, payment_method: paymentMethodId, off_session: true, confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: 'never' }, metadata }, { idempotencyKey: `adjustment-${adjustmentId}-authorization` });
    } catch (error: any) {
      if (error.code !== 'authentication_required') throw error;
      pi = await stripe.paymentIntents.create({ amount: adjustment.adjustmentCents, currency: 'usd', capture_method: 'manual', customer: stripeCustomerId, payment_method: paymentMethodId, confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: 'never' }, metadata }, { idempotencyKey: `adjustment-${adjustmentId}-authentication` });
    }
    await db.update(orderAdjustments).set({ stripePaymentIntentId: pi.id, updatedAt: new Date() }).where(eq(orderAdjustments.id, adjustmentId));
    if (pi.status === 'requires_action') return { requiresAction: true, adjustmentId, stripePaymentIntentId: pi.id, paymentClientSecret: pi.client_secret, publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '' };
    return finalizeAuthorizedAdjustment(adjustmentId, customerId, pi.id);
  } catch (error: any) {
    throw new AppError(402, ErrorCode.VALIDATION_ERROR, stripeMessage(error));
  }
}

export async function confirmAdjustment(adjustmentId: string, customerId: string, stripePaymentIntentId: string) {
  return finalizeAuthorizedAdjustment(adjustmentId, customerId, stripePaymentIntentId);
}

export async function declineAdjustment(adjustmentId: string, customerId: string) {
  const [updated] = await db.update(orderAdjustments).set({ status: 'DECLINED', respondedAt: new Date(), updatedAt: new Date() }).where(and(eq(orderAdjustments.id, adjustmentId), eq(orderAdjustments.customerId, customerId), eq(orderAdjustments.status, 'REQUESTED'))).returning();
  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Pending adjustment request not found');
  const payload = { jobId: updated.jobId, adjustment: serializeAdjustment(updated) };
  await notifyShop({ shopId: updated.shopId, event: 'job:adjustment_declined', payload, push: { title: 'Adjustment declined', body: 'The customer declined the price adjustment.', data: { screen: 'job-details', jobId: updated.jobId } }, persist: { category: 'order', title: 'Adjustment declined', body: 'The customer declined the price adjustment.', data: { screen: 'job-details', jobId: updated.jobId } } });
  getIO().to(`job:${updated.jobId}`).emit('job:adjustment', payload);
  return serializeAdjustment(updated);
}

async function finalizeTip(tipId: string, customerId: string, stripePaymentIntentId: string) {
  const [tip] = await db.select().from(orderTips).where(and(eq(orderTips.id, tipId), eq(orderTips.customerId, customerId))).limit(1);
  if (!tip) throw new AppError(404, ErrorCode.NOT_FOUND, 'Tip not found');
  if (tip.status === 'COMPLETED') return serializeTip(tip);
  let transferId: string | null = null;
  if (env.STRIPE_SECRET_KEY && !stripePaymentIntentId.startsWith('pi_mock_')) {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
    if (pi.status === 'requires_action') return { requiresAction: true, tipId, stripePaymentIntentId, paymentClientSecret: pi.client_secret, publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '' };
    const expectedCustomer = await ensureStripeCustomerForUser(stripe, customerId);
    const piCustomer = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id;
    if (pi.status !== 'succeeded' || pi.amount !== tip.amountCents || pi.currency !== 'usd' || piCustomer !== expectedCustomer || pi.metadata.tipId !== tipId || pi.metadata.jobId !== tip.jobId || pi.metadata.customerId !== customerId) throw new AppError(403, ErrorCode.FORBIDDEN, 'Tip payment could not be verified.');
    const [shop] = await db.select({ stripeAccountId: shops.stripeAccountId }).from(shops).where(eq(shops.id, tip.shopId)).limit(1);
    if (!shop?.stripeAccountId) throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'The store cannot receive tips yet.');
    if (shop.stripeAccountId.startsWith('acct_mock_')) {
      transferId = `tr_mock_tip_${tipId}`;
    } else {
      const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
      const transfer = await stripe.transfers.create({ amount: tip.amountCents, currency: 'usd', destination: shop.stripeAccountId, ...(chargeId ? { source_transaction: chargeId } : {}), transfer_group: tip.jobId, metadata: { type: 'tip', tipId, jobId: tip.jobId, platformFeeCents: '0' } }, { idempotencyKey: `tip-${tipId}-transfer` });
      transferId = transfer.id;
    }
  }
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx.update(orderTips).set({ status: 'COMPLETED', stripePaymentIntentId, stripeTransferId: transferId, completedAt: new Date(), updatedAt: new Date(), paymentError: null }).where(and(eq(orderTips.id, tipId), eq(orderTips.status, 'PENDING'))).returning();
    if (!rows[0]) return [];
    await tx.insert(payouts).values({ shopId: tip.shopId, jobId: null, amountCents: tip.amountCents, platformFeeCents: 0, netAmountCents: tip.amountCents, payoutMethod: 'tip', stripeTransferId: transferId, status: 'COMPLETED', completedAt: new Date() });
    return rows;
  });
  if (!updated) return serializeTip(await getJobTip(tip.jobId));
  const payload = { jobId: tip.jobId, tip: serializeTip(updated) };
  await notifyShop({ shopId: tip.shopId, event: 'job:tip_received', payload, push: { title: 'You received a tip!', body: `A customer tipped you $${(tip.amountCents / 100).toFixed(2)}. Repairebel charged no platform fee.`, data: { screen: 'job-details', jobId: tip.jobId } }, persist: { category: 'payout', title: 'You received a tip!', body: `$${(tip.amountCents / 100).toFixed(2)} was sent to your store with no platform fee.`, data: { screen: 'job-details', jobId: tip.jobId } } });
  getIO().to(`job:${tip.jobId}`).emit('job:tip', payload);
  return serializeTip(updated);
}

export async function createTip(jobId: string, customerId: string, amountCents: number) {
  const [job] = await db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.customerId, customerId))).limit(1);
  if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  if (job.status !== 'COMPLETED' || job.paymentStatus !== 'RELEASED') throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'You can tip after the repair is completed and payment is released.');
  let existing = await getJobTip(jobId);
  if (existing) {
    if (existing.status === 'COMPLETED') throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'You already tipped this store for this repair.');
    if (existing.status === 'PENDING' && existing.stripePaymentIntentId) return finalizeTip(existing.id, customerId, existing.stripePaymentIntentId);
    [existing] = await db.update(orderTips).set({ amountCents, status: 'PENDING', stripePaymentIntentId: null, stripeTransferId: null, paymentError: null, updatedAt: new Date() }).where(eq(orderTips.id, existing.id)).returning();
  }
  const [tip] = existing ? [existing] : await db.insert(orderTips).values({ jobId, shopId: job.shopId, customerId, amountCents }).returning();
  if (!env.STRIPE_SECRET_KEY) return finalizeTip(tip.id, customerId, `pi_mock_tip_${tip.id}`);
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const { stripeCustomerId, paymentMethodId } = await savedPaymentMethod(stripe, customerId);
  const metadata = { type: 'tip', tipId: tip.id, jobId, shopId: job.shopId, customerId, platformFeeCents: '0' };
  const attemptKey = tip.updatedAt.getTime();
  try {
    let pi: Stripe.PaymentIntent;
    try {
      pi = await stripe.paymentIntents.create({ amount: amountCents, currency: 'usd', customer: stripeCustomerId, payment_method: paymentMethodId, off_session: true, confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: 'never' }, metadata }, { idempotencyKey: `tip-${tip.id}-payment-${attemptKey}` });
    } catch (error: any) {
      if (error.code !== 'authentication_required') throw error;
      pi = await stripe.paymentIntents.create({ amount: amountCents, currency: 'usd', customer: stripeCustomerId, payment_method: paymentMethodId, confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: 'never' }, metadata }, { idempotencyKey: `tip-${tip.id}-authentication-${attemptKey}` });
    }
    await db.update(orderTips).set({ stripePaymentIntentId: pi.id, updatedAt: new Date() }).where(eq(orderTips.id, tip.id));
    if (pi.status === 'requires_action') return { requiresAction: true, tipId: tip.id, stripePaymentIntentId: pi.id, paymentClientSecret: pi.client_secret, publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '' };
    return finalizeTip(tip.id, customerId, pi.id);
  } catch (error: any) {
    await db.update(orderTips).set({ status: 'FAILED', paymentError: stripeMessage(error), updatedAt: new Date() }).where(eq(orderTips.id, tip.id));
    throw new AppError(402, ErrorCode.VALIDATION_ERROR, stripeMessage(error));
  }
}

export async function confirmTip(tipId: string, customerId: string, stripePaymentIntentId: string) {
  return finalizeTip(tipId, customerId, stripePaymentIntentId);
}

export async function getCapturedAdjustments(jobId: string) {
  return db.select().from(orderAdjustments).where(and(eq(orderAdjustments.jobId, jobId), inArray(orderAdjustments.status, ['AUTHORIZED', 'CAPTURED']))).orderBy(orderAdjustments.createdAt);
}

export async function captureAuthorizedAdjustments(jobId: string) {
  const rows = await db.select().from(orderAdjustments).where(and(eq(orderAdjustments.jobId, jobId), eq(orderAdjustments.status, 'AUTHORIZED'))).orderBy(orderAdjustments.createdAt);
  if (!rows.length) return [];
  const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;
  const captured: typeof rows = [];
  for (const row of rows) {
    try {
      if (stripe && row.stripePaymentIntentId && !row.stripePaymentIntentId.startsWith('pi_mock_')) {
        const pi = await stripe.paymentIntents.retrieve(row.stripePaymentIntentId);
        if (pi.status === 'requires_capture') await stripe.paymentIntents.capture(pi.id);
        else if (pi.status !== 'succeeded') throw new Error(`Additional payment is ${pi.status}`);
      }
      const [updated] = await db.update(orderAdjustments).set({ status: 'CAPTURED', updatedAt: new Date(), paymentError: null }).where(eq(orderAdjustments.id, row.id)).returning();
      captured.push(updated);
    } catch (error: any) {
      await db.update(orderAdjustments).set({ status: 'FAILED', paymentError: stripeMessage(error), updatedAt: new Date() }).where(eq(orderAdjustments.id, row.id));
      for (const completed of captured) {
        try {
          if (stripe && completed.stripePaymentIntentId && !completed.stripePaymentIntentId.startsWith('pi_mock_')) {
            await stripe.refunds.create({ payment_intent: completed.stripePaymentIntentId }, { idempotencyKey: `adjustment-${completed.id}-capture-rollback` });
          }
        } catch (rollbackError: any) {
          console.error('Failed to roll back captured adjustment:', rollbackError.message);
        } finally {
          await db.update(orderAdjustments).set({ status: 'FAILED', paymentError: 'Authorization will need to be retried with the order payment.', updatedAt: new Date() }).where(eq(orderAdjustments.id, completed.id));
        }
      }
      throw new AppError(402, ErrorCode.VALIDATION_ERROR, `The additional $${(row.adjustmentCents / 100).toFixed(2)} payment could not be charged: ${stripeMessage(error)}`);
    }
  }
  return captured;
}

export async function cancelJobAdjustments(jobId: string) {
  const rows = await db.select().from(orderAdjustments).where(and(eq(orderAdjustments.jobId, jobId), inArray(orderAdjustments.status, ['REQUESTED', 'AUTHORIZED', 'CAPTURED'])));
  const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;
  for (const row of rows) {
    let status: 'CANCELLED' | 'REFUNDED' = 'CANCELLED';
    let paymentError: string | null = null;
    try {
      if (stripe && row.stripePaymentIntentId && !row.stripePaymentIntentId.startsWith('pi_mock_')) {
        if (row.status === 'CAPTURED') {
          await stripe.refunds.create({ payment_intent: row.stripePaymentIntentId }, { idempotencyKey: `adjustment-${row.id}-refund` });
          status = 'REFUNDED';
        } else if (row.status === 'AUTHORIZED') {
          await stripe.paymentIntents.cancel(row.stripePaymentIntentId);
        }
      }
    } catch (error: any) {
      paymentError = stripeMessage(error);
      console.error('Failed to cancel or refund order adjustment:', error.message);
    } finally {
      await db.update(orderAdjustments).set({ status: paymentError ? 'FAILED' : status, paymentError, updatedAt: new Date() }).where(eq(orderAdjustments.id, row.id));
    }
  }
}
