import { eq, and, isNull, sql, gte, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { jobs, jobStatusEvents, payouts, shops, systemSettings } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { getIO } from '../../lib/socket.js';
import { notifyShop } from '../../lib/notify.js';
import { env } from '../../config/env.js';
import { refreshShopPayoutFreezeState } from '../../lib/payout-freeze.js';
import { getConnectedPayoutSchedule } from '../../lib/connected-payout-settings.js';

const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

function payoutArrivalDateToIso(arrivalDate: number | null | undefined) {
  return typeof arrivalDate === 'number'
    ? new Date(arrivalDate * 1000).toISOString()
    : null;
}

function buildCashoutMessage(input: {
  amountCents: number;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  payoutMethod: string | null;
  arrivalDate: string | null;
  failureMessage?: string | null;
}) {
  if (input.status === 'COMPLETED') {
    return `$${(input.amountCents / 100).toFixed(2)} sent to your bank${input.payoutMethod === 'instant' ? ' instantly' : ''}!`;
  }

  if (input.status === 'FAILED') {
    return input.failureMessage?.trim() || `Payout of $${(input.amountCents / 100).toFixed(2)} failed.`;
  }

  if (input.arrivalDate) {
    return `Payout is processing. Stripe estimates arrival by ${new Date(input.arrivalDate).toLocaleString()}.`;
  }

  return input.payoutMethod === 'instant'
    ? `Instant cashout of $${(input.amountCents / 100).toFixed(2)} is processing.`
    : `Payout of $${(input.amountCents / 100).toFixed(2)} is processing.`;
}

function serializePayoutRow(p: typeof payouts.$inferSelect) {
  return {
    id: p.id,
    jobId: p.jobId,
    amountCents: p.amountCents,
    stripePayoutId: p.stripePayoutId,
    payoutMethod: p.payoutMethod,
    status: p.status,
    arrivalDate: p.arrivalDate?.toISOString() ?? null,
    failureMessage: p.failureMessage ?? null,
    createdAt: p.createdAt?.toISOString() ?? null,
    completedAt: p.completedAt?.toISOString() ?? null,
  };
}

async function getInstantCashoutSettings() {
  const [settings] = await db
    .select({
      instantCashoutEnabled: systemSettings.instantCashoutEnabled,
      maxInstantCashoutCents: systemSettings.maxInstantCashoutCents,
    })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID))
    .limit(1);

  return {
    instantCashoutEnabled: settings?.instantCashoutEnabled ?? false,
    maxInstantCashoutCents: Math.max(100, settings?.maxInstantCashoutCents ?? 50000),
  };
}

async function emitCashoutStatus(
  shopId: string,
  payload: {
    payoutId?: string;
    stripePayoutId?: string | null;
    amountCents: number;
    status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
    method: string | null;
    arrivalDate: string | null;
    failureMessage?: string | null;
  },
  options: { notify?: boolean } = {},
) {
  const resolvedPayload = {
    ...payload,
    message: buildCashoutMessage({
      amountCents: payload.amountCents,
      status: payload.status,
      payoutMethod: payload.method,
      arrivalDate: payload.arrivalDate,
      failureMessage: payload.failureMessage,
    }),
  };

  try {
    const io = getIO();
    io.to(`shop:${shopId}`).emit('cashout:status', resolvedPayload);
  } catch {}

  if (!options.notify) {
    return resolvedPayload;
  }

  try {
    await notifyShop({
      shopId,
      event: 'cashout:status',
      payload: resolvedPayload,
      push: {
        title:
          payload.status === 'COMPLETED'
            ? 'Cashout Complete!'
            : payload.status === 'FAILED'
            ? 'Cashout Failed'
            : 'Cashout Processing',
        body: resolvedPayload.message,
        data: { screen: 'earnings', payoutId: payload.payoutId },
      },
      persist: {
        category: 'payout',
        title:
          payload.status === 'COMPLETED'
            ? 'Cashout Complete!'
            : payload.status === 'FAILED'
            ? 'Cashout Failed'
            : 'Cashout Processing',
        body: resolvedPayload.message,
        data: { payoutId: payload.payoutId },
      },
    });
  } catch {}

  return resolvedPayload;
}

// ─── Customer confirms receipt → auto-release payment ───

export async function customerConfirmJob(jobId: string) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }

  if (job.status === 'DISPUTED') {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      'Cannot release payment while a dispute is open',
    );
  }

  if (job.status !== 'COMPLETED') {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      'Job must be COMPLETED before customer can confirm',
    );
  }

  if (job.paymentStatus === 'RELEASED') {
    return { jobId: job.id, paymentStatus: 'RELEASED', message: 'Already released' };
  }

  if (job.paymentStatus !== 'HELD' && job.paymentStatus !== 'CAPTURED') {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Cannot release payment with status ${job.paymentStatus}`,
    );
  }

  // ── Transfer funds from platform to Connected account ──
  const netAmount = job.priceCents - (job.platformFeeCents ?? 0);
  let stripeTransferId: string | null = null;

  const [shop] = await db
    .select({ stripeAccountId: shops.stripeAccountId })
    .from(shops)
    .where(eq(shops.id, job.shopId))
    .limit(1);

  const acct = shop?.stripeAccountId;
  if (acct && !acct.startsWith('acct_mock_') && env.STRIPE_SECRET_KEY && job.stripePaymentIntentId && !job.stripePaymentIntentId.startsWith('pi_mock_')) {
    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(env.STRIPE_SECRET_KEY);

      // Get the charge ID from the PaymentIntent to use as source_transaction.
      // source_transaction makes the funds INSTANTLY available on the Connect
      // account, bypassing Stripe's normal pending period.
      const pi = await stripe.paymentIntents.retrieve(job.stripePaymentIntentId);
      const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;

      const transferParams: any = {
        amount: netAmount,
        currency: 'usd',
        destination: acct,
        transfer_group: job.id,
        metadata: { jobId: job.id, shopId: job.shopId },
      };
      if (chargeId) {
        transferParams.source_transaction = chargeId;
      }

      const transfer = await stripe.transfers.create(transferParams);
      stripeTransferId = transfer.id;
      console.log(`💸 Transfer ${transfer.id} — $${(netAmount / 100).toFixed(2)} → ${acct} (source: ${chargeId ?? 'none'})`);
    } catch (err: any) {
      console.error('⚠️ Stripe Transfer failed:', err.message);
    }
  }

  // Release payment
  const [updated] = await db
    .update(jobs)
    .set({ paymentStatus: 'RELEASED', updatedAt: new Date() })
    .where(eq(jobs.id, jobId))
    .returning();

  // Create audit event for customer confirmation
  await db.insert(jobStatusEvents).values({
    jobId,
    fromStatus: 'COMPLETED',
    toStatus: 'COMPLETED',
    note: 'Customer confirmed receipt — payment released & transferred to store',
  });

  // Create payout record
  await db.insert(payouts).values({
    shopId: job.shopId,
    jobId: job.id,
    amountCents: job.priceCents,
    platformFeeCents: job.platformFeeCents ?? 0,
    netAmountCents: netAmount,
    stripeTransferId,
    status: 'COMPLETED',
    completedAt: new Date(),
  });

  // Emit socket events
  try {
    const io = getIO();
    const payload = {
      jobId,
      paymentStatus: 'RELEASED',
      type: 'customer_confirmed',
      stripeTransferId,
    };
    io.to(`job:${jobId}`).emit('job:payment', payload);
    await notifyShop({
      shopId: job.shopId,
      event: 'job:payment',
      payload,
      push: { title: 'Payment Released!', body: `Payment has been released to your account.`, data: { screen: 'earnings' } },
      persist: {
        category: 'payout',
        title: 'Payment Released!',
        body: `Payment has been released to your account.`,
        data: { jobId },
      },
    });
  } catch {}

  return {
    jobId: updated.id,
    paymentStatus: updated.paymentStatus,
    stripeTransferId,
    message: 'Payment released & transferred to store',
  };
}

// ─── Earnings summary ───

export async function getEarningsSummary(shopId: string, range: string) {
  const cashoutSettings = await getInstantCashoutSettings();

  // Determine date cutoff from range
  let days = 30;
  if (range === '7d') days = 7;
  else if (range === '30d') days = 30;
  else if (range === '90d') days = 90;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  // Held: sum of price_cents where payment is captured from customer but not yet released
  // This includes ALL job statuses (BOOKED, IN_PROGRESS, COMPLETED, etc.) with HELD or CAPTURED payment
  const [heldRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(price_cents), 0)::int` })
    .from(jobs)
    .where(and(
      eq(jobs.shopId, shopId),
      sql`${jobs.paymentStatus} IN ('HELD', 'CAPTURED')`,
    ));

  // Available (released): sum within range
  const [releasedRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(price_cents), 0)::int` })
    .from(jobs)
    .where(
      and(
        eq(jobs.shopId, shopId),
        eq(jobs.paymentStatus, 'RELEASED'),
        gte(jobs.completedAt, cutoff),
      ),
    );

  // Protection subscription earnings in range (recorded in payouts with null jobId)
  const [releasedProtectionRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${payouts.netAmountCents}), 0)::int` })
    .from(payouts)
    .where(
      and(
        eq(payouts.shopId, shopId),
        isNull(payouts.jobId),
        eq(payouts.status, 'COMPLETED'),
        gte(payouts.createdAt, cutoff),
      ),
    );

  // Total released all time
  const [releasedAllRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(price_cents), 0)::int` })
    .from(jobs)
    .where(and(eq(jobs.shopId, shopId), eq(jobs.paymentStatus, 'RELEASED')));

  const [releasedProtectionAllRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${payouts.netAmountCents}), 0)::int` })
    .from(payouts)
    .where(
      and(
        eq(payouts.shopId, shopId),
        isNull(payouts.jobId),
        eq(payouts.status, 'COMPLETED'),
      ),
    );

  // Jobs completed count in range
  const [jobsCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(
      and(
        eq(jobs.shopId, shopId),
        eq(jobs.status, 'COMPLETED'),
        gte(jobs.completedAt, cutoff),
      ),
    );

  // Avg job value in range
  const [avgRow] = await db
    .select({ avg: sql<number>`COALESCE(AVG(price_cents), 0)::int` })
    .from(jobs)
    .where(
      and(
        eq(jobs.shopId, shopId),
        eq(jobs.status, 'COMPLETED'),
        gte(jobs.completedAt, cutoff),
      ),
    );

  // Chart points: daily earnings for the range
  const chartRows = await db.execute(sql`
    SELECT
      DATE(completed_at) AS day,
      COALESCE(SUM(price_cents), 0)::int AS total_cents,
      COUNT(*)::int AS job_count
    FROM jobs
    WHERE shop_id = ${shopId}
      AND status = 'COMPLETED'
      AND payment_status = 'RELEASED'
      AND completed_at >= ${cutoff}
    GROUP BY DATE(completed_at)
    ORDER BY day ASC
  `);

  // Total platform fees paid
  const [platformFeeRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(platform_fee_cents), 0)::int` })
    .from(jobs)
    .where(and(eq(jobs.shopId, shopId), eq(jobs.paymentStatus, 'RELEASED')));

  const [platformFeeProtectionRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${payouts.platformFeeCents}), 0)::int` })
    .from(payouts)
    .where(
      and(
        eq(payouts.shopId, shopId),
        isNull(payouts.jobId),
        eq(payouts.status, 'COMPLETED'),
      ),
    );

  // Get Stripe Connect balance
  // Since we use source_transaction on transfers, funds are INSTANTLY available
  // on the Connect account in production. In test mode Stripe forces a 7-day
  // pending period, so we combine available + pending as the true "available"
  // amount (it would all be available in production).
  let stripeAvailableCents = 0;
  let instantAvailableCents = 0;
  let payoutsFrozen = false;
  let payoutsFrozenSource: 'ADMIN' | 'STRIPE' | 'BOTH' | null = null;
  let payoutsFrozenReason: string | null = null;
  let defaultPayoutSchedule: Awaited<ReturnType<typeof getConnectedPayoutSchedule>> = null;
  try {
    const [shop] = await db
      .select({
        id: shops.id,
        stripeAccountId: shops.stripeAccountId,
        stripePayoutsEnabled: shops.stripePayoutsEnabled,
        manualPayoutFreeze: shops.manualPayoutFreeze,
        manualPayoutFreezeReason: shops.manualPayoutFreezeReason,
        stripePayoutFreezeReason: shops.stripePayoutFreezeReason,
      })
      .from(shops)
      .where(eq(shops.id, shopId))
      .limit(1);

    if (shop) {
      const payoutFreeze = await refreshShopPayoutFreezeState(shop);
      payoutsFrozen = payoutFreeze.payoutsFrozen;
      payoutsFrozenSource = payoutFreeze.payoutFreezeSource;
      payoutsFrozenReason = payoutFreeze.payoutFreezeReason;
    }

    if (shop?.stripeAccountId && !shop.stripeAccountId.startsWith('acct_mock_') && env.STRIPE_SECRET_KEY) {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(env.STRIPE_SECRET_KEY);
      const balance = await stripe.balance.retrieve({ stripeAccount: shop.stripeAccountId });
      const available = balance.available.reduce((sum, b) => sum + b.amount, 0);
      const pending = balance.pending.reduce((sum, b) => sum + b.amount, 0);
      const instantAvailable = (balance.instant_available ?? []).reduce((sum, b) => sum + b.amount, 0);
      // In production source_transaction makes pending = 0 and available = full.
      // In test mode pending > 0, so combine both.
      stripeAvailableCents = available + pending;
      instantAvailableCents = instantAvailable > 0 ? instantAvailable : available;
      defaultPayoutSchedule = await getConnectedPayoutSchedule(stripe, shop.stripeAccountId);
    }
  } catch (err: any) {
    console.error('Failed to fetch Stripe balance:', err.message);
  }

  const releasedJobsRange = releasedRow.total;
  const releasedProtectionRange = releasedProtectionRow.total;
  const releasedJobsAll = releasedAllRow.total;
  const releasedProtectionAll = releasedProtectionAllRow.total;
  const totalPlatformFees = (platformFeeRow.total ?? 0) + (platformFeeProtectionRow.total ?? 0);

  return {
    heldCents: heldRow.total,
    availableCents: releasedJobsAll + releasedProtectionAll,
    releasedCents: releasedJobsRange + releasedProtectionRange,
    platformFeeCents: totalPlatformFees,
    jobsCompletedCount: jobsCountRow.count,
    avgJobValueCents: avgRow.avg,
    stripeAvailableCents,
    instantAvailableCents,
    instantCashoutEnabled: cashoutSettings.instantCashoutEnabled,
    maxInstantCashoutCents: cashoutSettings.maxInstantCashoutCents,
    payoutsFrozen,
    payoutsFrozenSource,
    payoutsFrozenReason,
    defaultPayoutSchedule,
    chartPoints: (chartRows.rows as any[]).map((r: any) => ({
      day: r.day,
      totalCents: r.total_cents,
      jobCount: r.job_count,
    })),
  };
}

// ─── List payouts ───

export async function listPayouts(
  shopId: string,
  page: number,
  pageSize: number,
) {
  const offset = (page - 1) * pageSize;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(payouts)
    .where(eq(payouts.shopId, shopId));

  const rows = await db
    .select()
    .from(payouts)
    .where(eq(payouts.shopId, shopId))
    .orderBy(desc(payouts.createdAt))
    .limit(pageSize)
    .offset(offset);

  return {
    data: rows.map(serializePayoutRow),
    total: count,
  };
}

// ─── Cashout: admin-controlled instant payout from Stripe Connect balance to bank ───

export async function cashout(shopId: string, amountCents: number, method: 'instant' = 'instant') {
  if (amountCents < 100) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Minimum cashout is $1.00');
  }

  if (method !== 'instant') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Only instant cashout requests are supported from the app.');
  }

  const cashoutSettings = await getInstantCashoutSettings();
  if (!cashoutSettings.instantCashoutEnabled) {
    throw new AppError(
      403,
      ErrorCode.VALIDATION_ERROR,
      'Instant cashout is currently disabled. Your normal Stripe payout schedule will continue automatically.',
    );
  }

  if (amountCents > cashoutSettings.maxInstantCashoutCents) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Instant cashout is limited to $${(cashoutSettings.maxInstantCashoutCents / 100).toFixed(2)} per request.`,
    );
  }

  // Get shop's Stripe Connect account
  const [shop] = await db
    .select({
      id: shops.id,
      stripeAccountId: shops.stripeAccountId,
      stripePayoutsEnabled: shops.stripePayoutsEnabled,
      manualPayoutFreeze: shops.manualPayoutFreeze,
      manualPayoutFreezeReason: shops.manualPayoutFreezeReason,
      stripePayoutFreezeReason: shops.stripePayoutFreezeReason,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');

  const payoutFreeze = await refreshShopPayoutFreezeState(shop);

  if (payoutFreeze.payoutsFrozen) {
    throw new AppError(
      403,
      ErrorCode.VALIDATION_ERROR,
      payoutFreeze.payoutFreezeReason ?? 'Payouts are temporarily paused for this account.',
    );
  }

  const stripeAccountId = shop.stripeAccountId;

  if (!stripeAccountId) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Stripe Connect account not set up. Go to Settings → Stripe Setup.');
  }

  // Mock account — simulate cashout
  if (stripeAccountId.startsWith('acct_mock_')) {
    const [payout] = await db
      .insert(payouts)
      .values({
        shopId,
        jobId: null,
        amountCents,
        platformFeeCents: 0,
        netAmountCents: amountCents,
        payoutMethod: 'instant',
        stripePayoutId: `po_mock_${Date.now()}`,
        status: 'COMPLETED',
        arrivalDate: new Date(),
        completedAt: new Date(),
      })
      .returning();

    return {
      payoutId: payout.id,
      stripePayoutId: payout.stripePayoutId ?? undefined,
      amountCents,
      status: 'COMPLETED',
      method: 'instant',
      arrivalDate: payout.arrivalDate?.toISOString() ?? null,
      mock: true,
      message: buildCashoutMessage({
        amountCents,
        status: 'COMPLETED',
        payoutMethod: 'instant',
        arrivalDate: payout.arrivalDate?.toISOString() ?? null,
      }),
    };
  }

  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'Stripe not configured');
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  // Check Stripe balance on the Connect account.
  // Since we use source_transaction on transfers, in production available = full amount.
  // In test mode Stripe forces 7-day pending, so we treat available + pending as the
  // true available balance.
  const balance = await stripe.balance.retrieve({ stripeAccount: stripeAccountId });
  const stripeAvailable = balance.available.reduce((sum, b) => sum + b.amount, 0);
  const instantAvailable = (balance.instant_available ?? []).reduce((sum, b) => sum + b.amount, 0);
  const allowedInstantBalance = instantAvailable > 0 ? instantAvailable : stripeAvailable;

  if (amountCents > allowedInstantBalance) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `Insufficient instant-available balance. Available: $${(allowedInstantBalance / 100).toFixed(2)}, Requested: $${(amountCents / 100).toFixed(2)}`,
    );
  }

  await emitCashoutStatus(shopId, {
    amountCents,
    status: 'PROCESSING',
    method: 'instant',
    arrivalDate: null,
  });

  let stripePayout: any = null;

  try {
    stripePayout = await stripe.payouts.create(
      { amount: amountCents, currency: 'usd', method: 'instant' },
      { stripeAccount: stripeAccountId },
    );
  } catch (err: any) {
    console.error('⚠️ Stripe instant payout failed:', err.message);

    if (err.code === 'instant_payouts_unsupported') {
      throw new AppError(
        400,
        ErrorCode.VALIDATION_ERROR,
        'This connected payout account is not eligible for Stripe instant cashout. Your normal payout schedule will still continue automatically.',
      );
    }

    if (err.code === 'balance_insufficient') {
      throw new AppError(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Stripe does not currently have enough instantly available balance for this cashout.',
      );
    }

    throw new AppError(500, ErrorCode.INTERNAL_ERROR, err.message || 'Instant cashout failed');
  }

  // Poll Stripe for actual payout status (instant payouts often move to 'paid' within seconds)
  let finalPayoutStatus = stripePayout.status;
  if (finalPayoutStatus !== 'paid') {
    // Wait 2 seconds and re-check
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const refreshed = await stripe.payouts.retrieve(stripePayout.id, { stripeAccount: stripeAccountId });
      finalPayoutStatus = refreshed.status;
    } catch {}
  }
  // One more poll if still not paid
  if (finalPayoutStatus !== 'paid' && finalPayoutStatus !== 'failed' && finalPayoutStatus !== 'canceled') {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const refreshed2 = await stripe.payouts.retrieve(stripePayout.id, { stripeAccount: stripeAccountId });
      finalPayoutStatus = refreshed2.status;
    } catch {}
  }

  const payoutStatus = finalPayoutStatus === 'paid' ? 'COMPLETED'
    : (finalPayoutStatus === 'failed' || finalPayoutStatus === 'canceled') ? 'FAILED'
    : 'PROCESSING';
  const arrivalDate = payoutArrivalDateToIso(stripePayout.arrival_date);
  const failureMessage = stripePayout.failure_message ?? null;

  // Record in DB
  const [payout] = await db
    .insert(payouts)
    .values({
      shopId,
      jobId: null,
      amountCents,
      platformFeeCents: 0,
      netAmountCents: amountCents,
      payoutMethod: 'instant',
      stripePayoutId: stripePayout.id,
      status: payoutStatus,
      arrivalDate: arrivalDate ? new Date(arrivalDate) : null,
      failureMessage,
      completedAt: payoutStatus === 'COMPLETED' ? new Date() : null,
    })
    .returning();

  await emitCashoutStatus(
    shopId,
    {
      payoutId: payout.id,
      stripePayoutId: stripePayout.id,
      amountCents,
      status: payoutStatus,
      method: 'instant',
      arrivalDate,
      failureMessage,
    },
    { notify: true },
  );

  console.log(`💸 Cashout: ${stripePayout.id} (instant) — $${(amountCents / 100).toFixed(2)} to ${stripeAccountId} [${payoutStatus}]`);

  return {
    payoutId: payout.id,
    stripePayoutId: stripePayout.id,
    amountCents,
    status: payoutStatus,
    method: 'instant',
    arrivalDate,
    failureMessage,
    mock: false,
    message: buildCashoutMessage({
      amountCents,
      status: payoutStatus,
      payoutMethod: 'instant',
      arrivalDate,
      failureMessage,
    }),
  };
}

// ─── Refresh PROCESSING payouts against Stripe ───

export async function refreshPayoutStatuses(shopId: string) {
  const [shop] = await db
    .select({ stripeAccountId: shops.stripeAccountId })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop?.stripeAccountId || shop.stripeAccountId.startsWith('acct_mock_') || !env.STRIPE_SECRET_KEY) {
    return { updated: 0 };
  }

  // Find all PROCESSING payouts with a real stripe payout ID
  const processingRows = await db
    .select()
    .from(payouts)
    .where(and(eq(payouts.shopId, shopId), eq(payouts.status, 'PROCESSING')))
    .orderBy(desc(payouts.createdAt));

  if (processingRows.length === 0) return { updated: 0 };

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  let updated = 0;

  for (const row of processingRows) {
    if (!row.stripePayoutId || row.stripePayoutId.startsWith('po_mock_')) continue;
    try {
      const sp = await stripe.payouts.retrieve(row.stripePayoutId, { stripeAccount: shop.stripeAccountId });
      let newStatus: 'COMPLETED' | 'FAILED' | null = null;
      if (sp.status === 'paid') newStatus = 'COMPLETED';
      else if (sp.status === 'failed' || sp.status === 'canceled') newStatus = 'FAILED';
      const arrivalDate = payoutArrivalDateToIso(sp.arrival_date);
      const failureMessage = sp.failure_message ?? null;
      const nextStatus = newStatus ?? row.status;
      const emittedStatus = (nextStatus === 'PENDING' ? 'PROCESSING' : nextStatus) as 'PROCESSING' | 'COMPLETED' | 'FAILED';
      const metadataChanged =
        arrivalDate !== (row.arrivalDate?.toISOString() ?? null) ||
        failureMessage !== (row.failureMessage ?? null);

      if ((newStatus && newStatus !== row.status) || metadataChanged) {
        await db
          .update(payouts)
          .set({
            status: nextStatus,
            arrivalDate: arrivalDate ? new Date(arrivalDate) : null,
            failureMessage,
            completedAt: nextStatus === 'COMPLETED' ? new Date() : null,
          })
          .where(eq(payouts.id, row.id));
        updated++;

        await emitCashoutStatus(
          shopId,
          {
            payoutId: row.id,
            stripePayoutId: row.stripePayoutId,
            amountCents: row.amountCents,
            status: emittedStatus,
            method: row.payoutMethod ?? null,
            arrivalDate,
            failureMessage,
          },
          { notify: !!newStatus },
        );
      }
    } catch (err: any) {
      console.error(`Failed to refresh payout ${row.id}:`, err.message);
    }
  }

  return { updated };
}
