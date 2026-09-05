import { eq, and, or, ilike, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  protectionPlans,
  protectionSubscribers,
  protectionClaims,
  payouts,
  shops,
  systemSettings,
  users,
} from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { env } from '../../config/env.js';

// ─── Stripe helper (lazy import) ───

async function getStripe() {
  const stripeKey = env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    throw new AppError(503, ErrorCode.INTERNAL_ERROR, 'Stripe is not configured');
  }
  const Stripe = (await import('stripe')).default;
  return new Stripe(stripeKey);
}

// ─── Plans ───

export async function listPlans(query: { page?: number; limit?: number; shopId?: string; status?: string }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.shopId) conditions.push(eq(protectionPlans.shopId, query.shopId));
  if (query.status) conditions.push(eq(protectionPlans.status, query.status as any));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: protectionPlans.id,
        shopId: protectionPlans.shopId,
        shopName: shops.name,
        name: protectionPlans.name,
        billingType: protectionPlans.billingType,
        priceCents: protectionPlans.priceCents,
        coverageDays: protectionPlans.coverageDays,
        maxClaimsPerPeriod: protectionPlans.maxClaimsPerPeriod,
        maxPayoutPerClaimCents: protectionPlans.maxPayoutPerClaimCents,
        deductibleCents: protectionPlans.deductibleCents,
        status: protectionPlans.status,
        createdAt: protectionPlans.createdAt,
      })
      .from(protectionPlans)
      .leftJoin(shops, eq(shops.id, protectionPlans.shopId))
      .where(where)
      .orderBy(desc(protectionPlans.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(protectionPlans).where(where),
  ]);

  return {
    data: rows.map((r) => ({ ...r, createdAt: r.createdAt?.toISOString() ?? null })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

// ─── Subscribers ───

export async function listSubscribers(query: { page?: number; limit?: number; planId?: string; status?: string }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.planId) conditions.push(eq(protectionSubscribers.planId, query.planId));
  if (query.status) conditions.push(eq(protectionSubscribers.status, query.status as any));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: protectionSubscribers.id,
        planId: protectionSubscribers.planId,
        planName: protectionPlans.name,
        shopId: protectionSubscribers.shopId,
        shopName: shops.name,
        customerId: protectionSubscribers.customerId,
        customerName: protectionSubscribers.customerName,
        status: protectionSubscribers.status,
        autopayEnabled: protectionSubscribers.autopayEnabled,
        totalPaidCents: protectionSubscribers.totalPaidCents,
        stripeSubscriptionId: protectionSubscribers.stripeSubscriptionId,
        claimsCount: protectionSubscribers.claimsCount,
        startedAt: protectionSubscribers.startedAt,
        nextBillAt: protectionSubscribers.nextBillAt,
        canceledAt: protectionSubscribers.canceledAt,
        createdAt: protectionSubscribers.createdAt,
      })
      .from(protectionSubscribers)
      .leftJoin(protectionPlans, eq(protectionPlans.id, protectionSubscribers.planId))
      .leftJoin(shops, eq(shops.id, protectionSubscribers.shopId))
      .where(where)
      .orderBy(desc(protectionSubscribers.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(protectionSubscribers).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      startedAt: r.startedAt?.toISOString() ?? null,
      nextBillAt: r.nextBillAt?.toISOString() ?? null,
      canceledAt: r.canceledAt?.toISOString() ?? null,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

// ─── Admin Subscription Management ───

/**
 * Look up the customer's Stripe customer ID and find ALL their active/incomplete
 * Stripe subscriptions (not just the one linked in our DB record).
 * Returns { stripe, stripeCustomerId, activeSubs }.
 */
async function findAllStripeSubscriptions(customerId: string) {
  const stripe = await getStripe();

  // Get the customer's Stripe customer ID from the users table
  const [customer] = await db
    .select({ stripeCustomerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.id, customerId))
    .limit(1);

  const stripeCustomerId = customer?.stripeCustomerId;
  if (!stripeCustomerId) return { stripe, stripeCustomerId: null, activeSubs: [] };

  const stripeSubs = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    limit: 100,
  });

  return {
    stripe,
    stripeCustomerId,
    activeSubs: stripeSubs.data.filter(
      (s: any) => s.status === 'active' || s.status === 'past_due' || s.status === 'incomplete',
    ),
  };
}

const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

async function getInsurancePercent(): Promise<number> {
  const [settings] = await db
    .select({ insurancePercent: systemSettings.insurancePercent })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID))
    .limit(1);
  const percent = settings?.insurancePercent ?? 5;
  return Math.max(0, Math.min(100, percent));
}

async function canUseOnBehalfOf(stripe: any, connectedAccountId: string): Promise<boolean> {
  try {
    const account: any = await stripe.accounts.retrieve(connectedAccountId);
    return account?.capabilities?.card_payments === 'active';
  } catch (err: any) {
    console.error(
      `⚠️ Admin sync: failed to fetch capabilities for ${connectedAccountId}:`,
      err?.message ?? err,
    );
    return false;
  }
}

export async function syncProtectionSubscriptionConnectSplits() {
  const stripe = await getStripe();
  const insurancePercent = await getInsurancePercent();

  const activeSubs = await db
    .select({
      id: protectionSubscribers.id,
      stripeSubscriptionId: protectionSubscribers.stripeSubscriptionId,
      shopId: protectionSubscribers.shopId,
      status: protectionSubscribers.status,
      shopStripeAccountId: shops.stripeAccountId,
      shopStripeConnected: shops.stripeConnected,
    })
    .from(protectionSubscribers)
    .leftJoin(shops, eq(shops.id, protectionSubscribers.shopId))
    .where(
      and(
        sql`${protectionSubscribers.status} IN ('ACTIVE', 'PAST_DUE')`,
        sql`${protectionSubscribers.stripeSubscriptionId} LIKE 'sub_%'`,
      ),
    );

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of activeSubs) {
    const subId = row.stripeSubscriptionId;
    const acct = row.shopStripeAccountId;

    if (!subId || !acct || acct.startsWith('acct_mock_') || !row.shopStripeConnected) {
      skipped += 1;
      continue;
    }

    try {
      const sub: any = await stripe.subscriptions.retrieve(subId);
      const useOnBehalfOf = await canUseOnBehalfOf(stripe, acct);
      const transferPercent = Math.max(0, Math.min(100, Number((100 - insurancePercent).toFixed(2))));
      const currentDest = sub?.transfer_data?.destination ?? null;
      const currentTransferPercent = sub?.transfer_data?.amount_percent ?? null;
      const currentObo = sub?.on_behalf_of ?? null;

      const needsUpdate =
        currentDest !== acct ||
        Number(currentTransferPercent ?? -1) !== Number(transferPercent) ||
        (useOnBehalfOf ? currentObo !== acct : false);

      if (!needsUpdate) {
        skipped += 1;
        continue;
      }

      const updatePayload: any = {
        transfer_data: {
          destination: acct,
          amount_percent: transferPercent,
        },
        metadata: {
          ...(sub?.metadata ?? {}),
          insurancePercent: String(insurancePercent),
          transferPercent: String(transferPercent),
        },
      };

      if (useOnBehalfOf) {
        updatePayload.on_behalf_of = acct;
      }

      await stripe.subscriptions.update(subId, updatePayload);

      updated += 1;
      console.log(`✅ Admin sync: updated subscription ${subId} to destination ${acct}`);
    } catch (err: any) {
      failed += 1;
      console.error(`❌ Admin sync failed for subscription ${subId}:`, err?.message ?? err);
    }
  }

  return {
    message: 'Protection subscription Connect split sync completed',
    insurancePercent,
    total: activeSubs.length,
    updated,
    skipped,
    failed,
  };
}

export async function adminCancelSubscription(subscriptionId: string) {
  const [sub] = await db
    .select({
      id: protectionSubscribers.id,
      status: protectionSubscribers.status,
      customerId: protectionSubscribers.customerId,
      stripeSubscriptionId: protectionSubscribers.stripeSubscriptionId,
    })
    .from(protectionSubscribers)
    .where(eq(protectionSubscribers.id, subscriptionId))
    .limit(1);
  if (!sub) throw new AppError(404, ErrorCode.NOT_FOUND, 'Subscription not found');
  if (sub.status === 'CANCELED') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Subscription is already canceled');
  }

  // Cancel ALL active Stripe subscriptions for this customer (not just the DB-linked one)
  try {
    const { stripe, activeSubs } = await findAllStripeSubscriptions(sub.customerId);
    for (const stripeSub of activeSubs) {
      try {
        await stripe.subscriptions.cancel(stripeSub.id);
        console.log(`Admin cancel: canceled Stripe sub ${stripeSub.id} (status was ${stripeSub.status})`);
      } catch (err: any) {
        console.error(`Admin cancel: failed to cancel Stripe sub ${stripeSub.id}:`, err.message);
      }
    }
    // Also cancel the DB-linked one explicitly if it wasn't in the active list
    if (sub.stripeSubscriptionId && sub.stripeSubscriptionId.startsWith('sub_')) {
      const alreadyCanceled = activeSubs.some((s: any) => s.id === sub.stripeSubscriptionId);
      if (!alreadyCanceled) {
        await stripe.subscriptions.cancel(sub.stripeSubscriptionId).catch(() => {});
      }
    }
  } catch (err: any) {
    console.error('Admin cancel: Stripe cleanup failed:', err.message);
    // Still proceed to cancel locally
  }

  await db
    .update(protectionSubscribers)
    .set({
      status: 'CANCELED',
      autopayEnabled: false,
      canceledAt: new Date(),
    })
    .where(eq(protectionSubscribers.id, subscriptionId));

  return { message: 'Subscription canceled by admin', subscriptionId };
}

export async function adminRefundSubscription(subscriptionId: string, amountCents?: number) {
  const [sub] = await db
    .select({
      id: protectionSubscribers.id,
      status: protectionSubscribers.status,
      totalPaidCents: protectionSubscribers.totalPaidCents,
      planId: protectionSubscribers.planId,
      customerId: protectionSubscribers.customerId,
      customerName: protectionSubscribers.customerName,
      stripeSubscriptionId: protectionSubscribers.stripeSubscriptionId,
    })
    .from(protectionSubscribers)
    .where(eq(protectionSubscribers.id, subscriptionId))
    .limit(1);
  if (!sub) throw new AppError(404, ErrorCode.NOT_FOUND, 'Subscription not found');

  // Get the plan price to help identify protection charges
  const [planRow] = await db
    .select({ priceCents: protectionPlans.priceCents })
    .from(protectionPlans)
    .where(eq(protectionPlans.id, sub.planId))
    .limit(1);

  const stripe = await getStripe();

  // ── Collect ALL Stripe subscriptions for this customer (not just DB-linked) ──
  const { activeSubs, stripeCustomerId } = await findAllStripeSubscriptions(sub.customerId);

  // ── Find all refundable charges for this customer ──
  // In Stripe SDK v20+, invoice.payment_intent is removed, so we use charges directly.
  // We collect ALL non-refunded succeeded charges for the customer that match
  // the protection plan amount (to avoid accidentally refunding job payments).
  const refundableCharges: Array<{ chargeId: string; piId: string | null; amount: number; amountRefunded: number }> = [];
  let totalPaidAcrossAll = 0;

  if (stripeCustomerId) {
    try {
      const charges = await stripe.charges.list({ customer: stripeCustomerId, limit: 100 });
      for (const ch of charges.data) {
        if (!ch.paid || ch.refunded) continue;
        // Only include charges that match the protection plan price
        const matchesPlanPrice = planRow && ch.amount === planRow.priceCents;
        const isSubscriptionCharge = (ch as any).description === 'Subscription creation'
          || (ch as any).statement_descriptor?.includes('PROTECTION');
        if (!matchesPlanPrice && !isSubscriptionCharge) continue;

        const remaining = ch.amount - (ch.amount_refunded ?? 0);
        if (remaining <= 0) continue;

        refundableCharges.push({
          chargeId: ch.id,
          piId: typeof ch.payment_intent === 'string' ? ch.payment_intent : null,
          amount: ch.amount,
          amountRefunded: ch.amount_refunded ?? 0,
        });
        totalPaidAcrossAll += remaining;
      }
    } catch (err: any) {
      console.error('Admin refund: error listing charges:', err.message);
    }
  }

  // Also use local record if it has a positive value and charges returned 0
  let actualPaidCents = totalPaidAcrossAll > 0 ? totalPaidAcrossAll : sub.totalPaidCents;

  // Sync local record with Stripe if needed
  if (actualPaidCents > 0 && sub.totalPaidCents === 0) {
    await db.update(protectionSubscribers)
      .set({ totalPaidCents: actualPaidCents })
      .where(eq(protectionSubscribers.id, subscriptionId));
  }

  const refundAmount = amountCents ?? actualPaidCents;
  if (refundAmount <= 0) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'No payments found to refund');
  }
  if (refundAmount > actualPaidCents && actualPaidCents > 0) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Refund amount exceeds total paid ($${(actualPaidCents / 100).toFixed(2)})`);
  }

  // ── Issue Stripe refunds via charge IDs (works in SDK v20+) ──
  let totalRefunded = 0;
  try {
    let remaining = refundAmount;
    for (const ch of refundableCharges) {
      if (remaining <= 0) break;
      const refundable = ch.amount - ch.amountRefunded;
      const refundForCharge = Math.min(remaining, refundable);
      if (refundForCharge <= 0) continue;

      try {
        await stripe.refunds.create({
          charge: ch.chargeId,
          amount: refundForCharge,
          reason: 'requested_by_customer',
          reverse_transfer: true,
          refund_application_fee: true,
          metadata: {
            source: 'admin_protection_refund',
            subscriptionId,
          },
        });
      } catch (err: any) {
        // Fallback for legacy/non-destination charges where reverse_transfer is invalid
        console.warn(`Admin refund: reverse_transfer not applied for charge ${ch.chargeId}: ${err?.message ?? err}`);
        await stripe.refunds.create({
          charge: ch.chargeId,
          amount: refundForCharge,
          reason: 'requested_by_customer',
          metadata: {
            source: 'admin_protection_refund',
            subscriptionId,
          },
        });
      }
      console.log(`Admin refund: refunded ${refundForCharge} cents from charge ${ch.chargeId}`);
      remaining -= refundForCharge;
      totalRefunded += refundForCharge;
    }
  } catch (err: any) {
    console.error('Admin: Stripe refund failed:', err.message);
    throw new AppError(500, ErrorCode.INTERNAL_ERROR, `Stripe refund failed: ${err.message}`);
  }

  // ── Cancel ALL Stripe subscriptions for this customer ──
  for (const stripeSub of activeSubs) {
    try {
      await stripe.subscriptions.cancel(stripeSub.id);
      console.log(`Admin refund: canceled Stripe sub ${stripeSub.id}`);
    } catch {
      // Already canceled
    }
  }
  // Also cancel the DB-linked one explicitly if it wasn't in the active list
  const dbLinkedSubId = sub.stripeSubscriptionId;
  if (dbLinkedSubId && dbLinkedSubId.startsWith('sub_')) {
    const alreadyCanceled = activeSubs.some((s: any) => s.id === dbLinkedSubId);
    if (!alreadyCanceled) {
      await stripe.subscriptions.cancel(dbLinkedSubId).catch(() => {});
    }
  }

  // Cancel subscription, mark as refunded, deduct refund from totalPaidCents
  const newPaid = Math.max(0, actualPaidCents - refundAmount);
  await db
    .update(protectionSubscribers)
    .set({
      status: 'CANCELED',
      autopayEnabled: false,
      canceledAt: sub.status === 'CANCELED' ? undefined : new Date(),
      totalPaidCents: newPaid,
    })
    .where(eq(protectionSubscribers.id, subscriptionId));

  // Mark the subscription payout entry as failed/refunded so shop earnings UI does not count it.
  await db
    .update(payouts)
    .set({ status: 'FAILED' })
    .where(eq(payouts.stripeTransferId, `protection_sub_${subscriptionId}`));

  return { message: 'Subscription refunded by admin', subscriptionId, refundAmountCents: refundAmount };
}

export async function adminToggleAutopay(subscriptionId: string, enabled: boolean) {
  const [sub] = await db
    .select({ id: protectionSubscribers.id, status: protectionSubscribers.status })
    .from(protectionSubscribers)
    .where(eq(protectionSubscribers.id, subscriptionId))
    .limit(1);
  if (!sub) throw new AppError(404, ErrorCode.NOT_FOUND, 'Subscription not found');
  if (sub.status === 'CANCELED') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Cannot toggle autopay on canceled subscription');
  }

  await db
    .update(protectionSubscribers)
    .set({ autopayEnabled: enabled })
    .where(eq(protectionSubscribers.id, subscriptionId));

  return { message: `Autopay ${enabled ? 'enabled' : 'disabled'}`, subscriptionId };
}

// ─── Claims ───

export async function listClaims(query: { page?: number; limit?: number; status?: string; urgency?: string }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.status) conditions.push(eq(protectionClaims.status, query.status as any));
  if (query.urgency) conditions.push(eq(protectionClaims.urgency, query.urgency as any));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: protectionClaims.id,
        planId: protectionClaims.planId,
        planName: protectionPlans.name,
        subscriptionId: protectionClaims.subscriptionId,
        shopId: protectionClaims.shopId,
        shopName: shops.name,
        customerId: protectionClaims.customerId,
        customerName: protectionClaims.customerName,
        jobId: protectionClaims.jobId,
        deviceModel: protectionClaims.deviceModel,
        reason: protectionClaims.reason,
        evidenceUrls: protectionClaims.evidenceUrls,
        status: protectionClaims.status,
        urgency: protectionClaims.urgency,
        decisionNotes: protectionClaims.decisionNotes,
        payoutAmountCents: protectionClaims.payoutAmountCents,
        reviewedAt: protectionClaims.reviewedAt,
        createdAt: protectionClaims.createdAt,
      })
      .from(protectionClaims)
      .leftJoin(protectionPlans, eq(protectionPlans.id, protectionClaims.planId))
      .leftJoin(shops, eq(shops.id, protectionClaims.shopId))
      .where(where)
      .orderBy(desc(protectionClaims.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(protectionClaims).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function approveClaim(claimId: string, payoutAmountCents: number, decisionNotes?: string) {
  const [claim] = await db
    .select({ id: protectionClaims.id, status: protectionClaims.status })
    .from(protectionClaims)
    .where(eq(protectionClaims.id, claimId))
    .limit(1);
  if (!claim) throw new AppError(404, ErrorCode.NOT_FOUND, 'Claim not found');
  if (claim.status !== 'OPEN' && claim.status !== 'UNDER_REVIEW') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Claim cannot be approved in its current state');
  }

  await db
    .update(protectionClaims)
    .set({
      status: 'APPROVED',
      payoutAmountCents,
      decisionNotes: decisionNotes ?? null,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(protectionClaims.id, claimId));

  return { message: 'Claim approved', claimId, payoutAmountCents };
}

export async function denyClaim(claimId: string, decisionNotes?: string) {
  const [claim] = await db
    .select({ id: protectionClaims.id, status: protectionClaims.status })
    .from(protectionClaims)
    .where(eq(protectionClaims.id, claimId))
    .limit(1);
  if (!claim) throw new AppError(404, ErrorCode.NOT_FOUND, 'Claim not found');
  if (claim.status !== 'OPEN' && claim.status !== 'UNDER_REVIEW') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Claim cannot be denied in its current state');
  }

  await db
    .update(protectionClaims)
    .set({
      status: 'DENIED',
      decisionNotes: decisionNotes ?? null,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(protectionClaims.id, claimId));

  return { message: 'Claim denied', claimId };
}
