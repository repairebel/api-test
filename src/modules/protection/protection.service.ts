import { eq, and, sql, gte, desc, count as drizzleCount, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  protectionPlans,
  protectionSubscribers,
  protectionClaims,
  payouts,
} from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { getIO } from '../../lib/socket.js';
import { notifyShop } from '../../lib/notify.js';

// ─────────────────────────────────────────────
//  PLANS
// ─────────────────────────────────────────────

export interface CreatePlanInput {
  name: string;
  billingType: 'ONE_TIME' | 'MONTHLY';
  priceCents: number;
  coverageDays: number;
  coveredPartTypes: string[];
  maxClaimsPerPeriod: number;
  maxPayoutPerClaimCents: number;
  deductibleCents: number;
  termsText?: string;
  exclusionsText?: string;
  status: 'ACTIVE' | 'PAUSED';
}

export async function createPlan(shopId: string, input: CreatePlanInput) {
  // If MONTHLY, create Stripe product+price (stubbed — no real Stripe SDK in project)
  let stripeProductId: string | undefined;
  let stripePriceId: string | undefined;

  if (input.billingType === 'MONTHLY') {
    // In production: const product = await stripe.products.create(...)
    // const price = await stripe.prices.create(...)
    stripeProductId = `prod_stub_${Date.now()}`;
    stripePriceId = `price_stub_${Date.now()}`;
  }

  const [plan] = await db
    .insert(protectionPlans)
    .values({
      shopId,
      name: input.name,
      billingType: input.billingType,
      priceCents: input.priceCents,
      coverageDays: input.coverageDays,
      coveredPartTypes: input.coveredPartTypes,
      maxClaimsPerPeriod: input.maxClaimsPerPeriod,
      maxPayoutPerClaimCents: input.maxPayoutPerClaimCents,
      deductibleCents: input.deductibleCents,
      termsText: input.termsText ?? null,
      exclusionsText: input.exclusionsText ?? null,
      status: input.status,
      stripeProductId: stripeProductId ?? null,
      stripePriceId: stripePriceId ?? null,
    })
    .returning();

  return plan;
}

export async function listPlans(shopId: string) {
  const plans = await db
    .select()
    .from(protectionPlans)
    .where(eq(protectionPlans.shopId, shopId))
    .orderBy(desc(protectionPlans.createdAt));

  // Enrich with subscriber count, revenue, claim rate
  const enriched = await Promise.all(
    plans.map(async (plan) => {
      const [subsRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(protectionSubscribers)
        .where(eq(protectionSubscribers.planId, plan.id));

      const [revenueRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(total_paid_cents), 0)::int` })
        .from(protectionSubscribers)
        .where(eq(protectionSubscribers.planId, plan.id));

      const [claimsRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(protectionClaims)
        .where(eq(protectionClaims.planId, plan.id));

      const subscribersCount = subsRow?.count ?? 0;
      const revenueCents = revenueRow?.total ?? 0;
      const claimsCount = claimsRow?.count ?? 0;
      const claimRate = subscribersCount > 0
        ? Math.round((claimsCount / subscribersCount) * 100)
        : 0;

      return {
        ...plan,
        subscribersCount,
        revenueCents,
        claimRate,
      };
    }),
  );

  return enriched;
}

export async function getPlanById(planId: string) {
  const [plan] = await db
    .select()
    .from(protectionPlans)
    .where(eq(protectionPlans.id, planId))
    .limit(1);

  if (!plan) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Plan not found');
  }

  // Enrich
  const [subsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(protectionSubscribers)
    .where(eq(protectionSubscribers.planId, plan.id));

  const [revenueRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(total_paid_cents), 0)::int` })
    .from(protectionSubscribers)
    .where(eq(protectionSubscribers.planId, plan.id));

  const [claimsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(protectionClaims)
    .where(eq(protectionClaims.planId, plan.id));

  const subscribersCount = subsRow?.count ?? 0;
  const claimRate = subscribersCount > 0
    ? Math.round(((claimsRow?.count ?? 0) / subscribersCount) * 100)
    : 0;

  return {
    ...plan,
    subscribersCount,
    revenueCents: revenueRow?.total ?? 0,
    claimRate,
  };
}

export interface UpdatePlanInput {
  name?: string;
  priceCents?: number;
  coverageDays?: number;
  coveredPartTypes?: string[];
  maxClaimsPerPeriod?: number;
  maxPayoutPerClaimCents?: number;
  deductibleCents?: number;
  termsText?: string;
  exclusionsText?: string;
  status?: 'ACTIVE' | 'PAUSED';
}

export async function updatePlan(planId: string, shopId: string, input: UpdatePlanInput) {
  const [plan] = await db
    .select()
    .from(protectionPlans)
    .where(and(eq(protectionPlans.id, planId), eq(protectionPlans.shopId, shopId)))
    .limit(1);

  if (!plan) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Plan not found');
  }

  // If plan has subscribers, restrict certain retroactive changes
  const [subsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(protectionSubscribers)
    .where(
      and(
        eq(protectionSubscribers.planId, planId),
        eq(protectionSubscribers.status, 'ACTIVE'),
      ),
    );

  const hasActiveSubscribers = (subsRow?.count ?? 0) > 0;

  if (hasActiveSubscribers) {
    // Prevent retroactive rule changes — only allow status, terms, exclusions changes
    if (
      input.priceCents !== undefined ||
      input.coveredPartTypes !== undefined ||
      input.maxClaimsPerPeriod !== undefined ||
      input.maxPayoutPerClaimCents !== undefined ||
      input.deductibleCents !== undefined ||
      input.coverageDays !== undefined
    ) {
      throw new AppError(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Cannot change coverage rules while plan has active subscribers. Pause the plan and create a new version.',
      );
    }
  }

  const updateData: Record<string, any> = { updatedAt: new Date() };
  if (input.name !== undefined) updateData.name = input.name;
  if (input.priceCents !== undefined) updateData.priceCents = input.priceCents;
  if (input.coverageDays !== undefined) updateData.coverageDays = input.coverageDays;
  if (input.coveredPartTypes !== undefined) updateData.coveredPartTypes = input.coveredPartTypes;
  if (input.maxClaimsPerPeriod !== undefined) updateData.maxClaimsPerPeriod = input.maxClaimsPerPeriod;
  if (input.maxPayoutPerClaimCents !== undefined) updateData.maxPayoutPerClaimCents = input.maxPayoutPerClaimCents;
  if (input.deductibleCents !== undefined) updateData.deductibleCents = input.deductibleCents;
  if (input.termsText !== undefined) updateData.termsText = input.termsText;
  if (input.exclusionsText !== undefined) updateData.exclusionsText = input.exclusionsText;
  if (input.status !== undefined) updateData.status = input.status;

  const [updated] = await db
    .update(protectionPlans)
    .set(updateData)
    .where(eq(protectionPlans.id, planId))
    .returning();

  return updated;
}

// ─────────────────────────────────────────────
//  SUBSCRIBERS
// ─────────────────────────────────────────────

export async function listSubscribers(
  planId: string,
  shopId: string,
  page: number,
  pageSize: number,
  statusFilter?: string,
) {
  // Verify plan belongs to shop
  const [plan] = await db
    .select({ id: protectionPlans.id })
    .from(protectionPlans)
    .where(and(eq(protectionPlans.id, planId), eq(protectionPlans.shopId, shopId)))
    .limit(1);

  if (!plan) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Plan not found');
  }

  const conditions = [eq(protectionSubscribers.planId, planId)];
  if (statusFilter && ['ACTIVE', 'PAST_DUE', 'CANCELED'].includes(statusFilter)) {
    conditions.push(eq(protectionSubscribers.status, statusFilter as any));
  }

  const where = and(...conditions);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(protectionSubscribers)
    .where(where);

  const data = await db
    .select()
    .from(protectionSubscribers)
    .where(where)
    .orderBy(desc(protectionSubscribers.startedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  // Enrich with plan name
  const enriched = data.map((s) => ({
    ...s,
    planName: '', // Will be filled below
  }));

  // Get plan name
  const [planData] = await db
    .select({ name: protectionPlans.name })
    .from(protectionPlans)
    .where(eq(protectionPlans.id, planId))
    .limit(1);

  for (const s of enriched) {
    s.planName = planData?.name ?? '';
  }

  return { data: enriched, total: countRow?.count ?? 0 };
}

export async function cancelSubscription(subscriptionId: string, shopId: string) {
  const [sub] = await db
    .select()
    .from(protectionSubscribers)
    .where(
      and(
        eq(protectionSubscribers.id, subscriptionId),
        eq(protectionSubscribers.shopId, shopId),
      ),
    )
    .limit(1);

  if (!sub) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Subscription not found');
  }

  if (sub.status === 'CANCELED') {
    return { ...sub, message: 'Already canceled' };
  }

  // In production: await stripe.subscriptions.cancel(sub.stripeSubscriptionId)

  const [updated] = await db
    .update(protectionSubscribers)
    .set({
      status: 'CANCELED',
      canceledAt: new Date(),
    })
    .where(eq(protectionSubscribers.id, subscriptionId))
    .returning();

  return { ...updated, message: 'Subscription canceled' };
}

// ─────────────────────────────────────────────
//  CLAIMS
// ─────────────────────────────────────────────

export async function listClaims(
  shopId: string,
  page: number,
  pageSize: number,
  statusFilter?: string,
) {
  const conditions = [eq(protectionClaims.shopId, shopId)];
  if (
    statusFilter &&
    ['OPEN', 'UNDER_REVIEW', 'APPROVED', 'DENIED', 'COMPLETED'].includes(statusFilter)
  ) {
    conditions.push(eq(protectionClaims.status, statusFilter as any));
  }

  const where = and(...conditions);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(protectionClaims)
    .where(where);

  const data = await db
    .select()
    .from(protectionClaims)
    .where(where)
    .orderBy(desc(protectionClaims.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  // Enrich with plan name
  if (data.length > 0) {
    const planIds = [...new Set(data.map((c) => c.planId))];
    const plans = await db
      .select({ id: protectionPlans.id, name: protectionPlans.name })
      .from(protectionPlans)
      .where(inArray(protectionPlans.id, planIds));

    const planMap = new Map(plans.map((p) => [p.id, p.name]));

    return {
      data: data.map((c) => ({ ...c, planName: planMap.get(c.planId) ?? '' })),
      total: countRow?.count ?? 0,
    };
  }

  return { data: [], total: 0 };
}

export async function getClaimById(claimId: string) {
  const [claim] = await db
    .select()
    .from(protectionClaims)
    .where(eq(protectionClaims.id, claimId))
    .limit(1);

  if (!claim) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Claim not found');
  }

  // Enrich with plan name
  const [plan] = await db
    .select({ name: protectionPlans.name })
    .from(protectionPlans)
    .where(eq(protectionPlans.id, claim.planId))
    .limit(1);

  return { ...claim, planName: plan?.name ?? '' };
}

export interface ReviewClaimInput {
  decision: 'APPROVE' | 'DENY' | 'MORE_INFO';
  payoutAmountCents?: number;
  notes?: string;
}

export async function reviewClaim(
  claimId: string,
  shopId: string,
  input: ReviewClaimInput,
) {
  const [claim] = await db
    .select()
    .from(protectionClaims)
    .where(
      and(
        eq(protectionClaims.id, claimId),
        eq(protectionClaims.shopId, shopId),
      ),
    )
    .limit(1);

  if (!claim) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Claim not found');
  }

  if (claim.status === 'COMPLETED' || claim.status === 'DENIED') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Claim has already been resolved');
  }

  const updateData: Record<string, any> = {
    updatedAt: new Date(),
    reviewedAt: new Date(),
  };

  if (input.decision === 'APPROVE') {
    updateData.status = 'APPROVED';
    updateData.decisionNotes = input.notes ?? 'Approved';
    updateData.payoutAmountCents = input.payoutAmountCents ?? 0;

    // If approved with payout, create a payout record
    if (input.payoutAmountCents && input.payoutAmountCents > 0) {
      await db.insert(payouts).values({
        shopId: claim.shopId,
        jobId: claim.jobId!, // May be null but that's fine for claim payouts
        amountCents: input.payoutAmountCents,
        status: 'COMPLETED',
        completedAt: new Date(),
      });
    }
  } else if (input.decision === 'DENY') {
    updateData.status = 'DENIED';
    updateData.decisionNotes = input.notes ?? 'Denied';
  } else {
    // MORE_INFO → keep UNDER_REVIEW
    updateData.status = 'UNDER_REVIEW';
    updateData.decisionNotes = input.notes ?? 'Additional information requested';
  }

  const [updated] = await db
    .update(protectionClaims)
    .set(updateData)
    .where(eq(protectionClaims.id, claimId))
    .returning();

  // Emit socket event
  try {
    await notifyShop({
      shopId,
      event: 'claim:updated',
      payload: { claimId: updated.id, status: updated.status, decision: input.decision },
      push: { title: 'Claim Update', body: `Your protection claim has been ${input.decision.toLowerCase()}.`, data: { screen: 'protection', claimId: updated.id } },
    });
  } catch {}

  // Enrich with plan name
  const [plan] = await db
    .select({ name: protectionPlans.name })
    .from(protectionPlans)
    .where(eq(protectionPlans.id, updated.planId))
    .limit(1);

  return { ...updated, planName: plan?.name ?? '' };
}

// ─────────────────────────────────────────────
//  ANALYTICS
// ─────────────────────────────────────────────

export async function getProtectionAnalytics(shopId: string, range: string) {
  let days = 30;
  if (range === '7d') days = 7;
  else if (range === '30d') days = 30;
  else if (range === '90d') days = 90;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  // Active subscribers
  const [activeSubsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(protectionSubscribers)
    .where(
      and(
        eq(protectionSubscribers.shopId, shopId),
        eq(protectionSubscribers.status, 'ACTIVE'),
      ),
    );

  // Total revenue from all subscribers
  const [totalRevenueRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(total_paid_cents), 0)::int` })
    .from(protectionSubscribers)
    .where(eq(protectionSubscribers.shopId, shopId));

  // Revenue by plan
  const revenueByPlan = await db.execute(sql`
    SELECT
      pp.id AS plan_id,
      pp.name AS plan_name,
      COALESCE(SUM(ps.total_paid_cents), 0)::int AS revenue_cents
    FROM protection_plans pp
    LEFT JOIN protection_subscribers ps ON ps.plan_id = pp.id
    WHERE pp.shop_id = ${shopId}
    GROUP BY pp.id, pp.name
    ORDER BY revenue_cents DESC
  `);

  // Claims by plan
  const claimsByPlan = await db.execute(sql`
    SELECT
      pp.id AS plan_id,
      pp.name AS plan_name,
      count(pc.id)::int AS claims_count
    FROM protection_plans pp
    LEFT JOIN protection_claims pc ON pc.plan_id = pp.id
    WHERE pp.shop_id = ${shopId}
    GROUP BY pp.id, pp.name
    ORDER BY claims_count DESC
  `);

  // Total claims + approved + denied
  const [claimsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(protectionClaims)
    .where(eq(protectionClaims.shopId, shopId));

  const [approvedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(protectionClaims)
    .where(
      and(eq(protectionClaims.shopId, shopId), eq(protectionClaims.status, 'APPROVED')),
    );

  const [deniedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(protectionClaims)
    .where(
      and(eq(protectionClaims.shopId, shopId), eq(protectionClaims.status, 'DENIED')),
    );

  // Payout totals (from approved claims)
  const [payoutTotalRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(payout_amount_cents), 0)::int` })
    .from(protectionClaims)
    .where(
      and(
        eq(protectionClaims.shopId, shopId),
        eq(protectionClaims.status, 'APPROVED'),
      ),
    );

  // Churn: canceled / total subscribers
  const [totalSubsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(protectionSubscribers)
    .where(eq(protectionSubscribers.shopId, shopId));

  const [canceledSubsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(protectionSubscribers)
    .where(
      and(
        eq(protectionSubscribers.shopId, shopId),
        eq(protectionSubscribers.status, 'CANCELED'),
      ),
    );

  const totalSubs = totalSubsRow?.count ?? 0;
  const canceledSubs = canceledSubsRow?.count ?? 0;
  const churn = totalSubs > 0 ? Math.round((canceledSubs / totalSubs) * 1000) / 10 : 0;

  // Time-series: revenue by day for the range
  const timeSeriesRows = await db.execute(sql`
    SELECT
      DATE(ps.started_at) AS day,
      COALESCE(SUM(ps.total_paid_cents), 0)::int AS revenue_cents,
      count(*)::int AS new_subs
    FROM protection_subscribers ps
    WHERE ps.shop_id = ${shopId}
      AND ps.started_at >= ${cutoff}
    GROUP BY DATE(ps.started_at)
    ORDER BY day ASC
  `);

  const activeSubscribers = activeSubsRow?.count ?? 0;
  const totalRevenueCents = totalRevenueRow?.total ?? 0;
  const totalClaims = claimsRow?.count ?? 0;
  const approvedClaims = approvedRow?.count ?? 0;
  const deniedClaims = deniedRow?.count ?? 0;
  const payoutTotalCents = payoutTotalRow?.total ?? 0;
  const avgPayoutCents =
    approvedClaims > 0 ? Math.round(payoutTotalCents / approvedClaims) : 0;
  const claimRate =
    activeSubscribers > 0
      ? Math.round((totalClaims / activeSubscribers) * 100)
      : 0;

  return {
    activeSubscribers,
    totalRevenueCents,
    payoutTotalCents,
    netProfitCents: totalRevenueCents - payoutTotalCents,
    totalClaims,
    approvedClaims,
    deniedClaims,
    avgPayoutCents,
    churn,
    claimRate,
    revenueByPlan: (revenueByPlan.rows as any[]).map((r) => ({
      planId: r.plan_id,
      planName: r.plan_name,
      revenueCents: r.revenue_cents,
    })),
    claimsByPlan: (claimsByPlan.rows as any[]).map((r) => ({
      planId: r.plan_id,
      planName: r.plan_name,
      claimsCount: r.claims_count,
    })),
    timeSeriesPoints: (timeSeriesRows.rows as any[]).map((r) => ({
      day: r.day,
      revenueCents: r.revenue_cents,
      newSubs: r.new_subs,
    })),
  };
}
