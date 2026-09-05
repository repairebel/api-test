import { and, eq, desc, ilike, or, sql, count } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { shops, payouts } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { env } from '../../config/env.js';
import {
  buildTaxDocuments,
  mapStripeTaxProfile,
} from '../../lib/stripe-connect-tax.js';
import {
  computePayoutFreezeState,
  syncStripePayoutStatusForShop,
} from '../../lib/payout-freeze.js';
import { getConnectedPayoutSchedule } from '../../lib/connected-payout-settings.js';

// ─── Helpers ───

function getStripe() {
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'Stripe is not configured');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return import('stripe').then((m) => new m.default(env.STRIPE_SECRET_KEY!));
}

// ─── List Connected Accounts ───

export async function listConnectedAccounts(
  page = 1,
  limit = 20,
  search?: string,
  status?: string,
) {
  const offset = (page - 1) * limit;

  // Build conditions
  const conditions = [];
  // Only shops that have a Stripe account
  conditions.push(sql`${shops.stripeAccountId} IS NOT NULL`);

  if (search) {
    conditions.push(
      or(
        ilike(shops.name, `%${search}%`),
        ilike(shops.stripeAccountId!, `%${search}%`),
      )!,
    );
  }
  if (status === 'active') {
    conditions.push(eq(shops.manualPayoutFreeze, false));
    conditions.push(eq(shops.stripePayoutsEnabled, true));
  } else if (status === 'restricted') {
    conditions.push(
      or(
        eq(shops.manualPayoutFreeze, true),
        eq(shops.stripePayoutsEnabled, false),
      )!,
    );
  }

  const where = and(...conditions)!;

  const [totalResult] = await db
    .select({ count: count() })
    .from(shops)
    .where(where);

  const rows = await db
    .select({
      id: shops.id,
      name: shops.name,
      logoUrl: shops.logoUrl,
      stripeAccountId: shops.stripeAccountId,
      stripeConnected: shops.stripeConnected,
      stripeChargesEnabled: shops.stripeChargesEnabled,
      stripePayoutsEnabled: shops.stripePayoutsEnabled,
      manualPayoutFreeze: shops.manualPayoutFreeze,
      manualPayoutFreezeReason: shops.manualPayoutFreezeReason,
      manualPayoutFrozenAt: shops.manualPayoutFrozenAt,
      stripePayoutFreezeCode: shops.stripePayoutFreezeCode,
      stripePayoutFreezeReason: shops.stripePayoutFreezeReason,
      onboardingStatus: shops.onboardingStatus,
      city: shops.city,
      state: shops.state,
      createdAt: shops.createdAt,
    })
    .from(shops)
    .where(where)
    .orderBy(desc(shops.createdAt))
    .limit(limit)
    .offset(offset);

  return {
    data: rows.map((r) => {
      const payoutFreeze = computePayoutFreezeState({
        manualPayoutFreeze: r.manualPayoutFreeze,
        manualPayoutFreezeReason: r.manualPayoutFreezeReason,
        stripePayoutsEnabled: r.stripePayoutsEnabled,
        stripePayoutFreezeReason: r.stripePayoutFreezeReason,
      });

      return {
        ...r,
        createdAt: r.createdAt?.toISOString() ?? null,
        manualPayoutFrozenAt: r.manualPayoutFrozenAt?.toISOString() ?? null,
        payoutsFrozen: payoutFreeze.payoutsFrozen,
        payoutFreezeSource: payoutFreeze.payoutFreezeSource,
        payoutFreezeReason: payoutFreeze.payoutFreezeReason,
      };
    }),
    pagination: {
      page,
      pageSize: limit,
      total: totalResult.count,
      totalPages: Math.ceil(totalResult.count / limit),
    },
  };
}

// ─── Get Connected Account Detail (from Stripe API) ───

export async function getConnectedAccountDetail(shopId: string) {
  const [shop] = await db
    .select({
      id: shops.id,
      name: shops.name,
      stripeAccountId: shops.stripeAccountId,
      stripeConnected: shops.stripeConnected,
      stripeChargesEnabled: shops.stripeChargesEnabled,
      stripePayoutsEnabled: shops.stripePayoutsEnabled,
      manualPayoutFreeze: shops.manualPayoutFreeze,
      manualPayoutFreezeReason: shops.manualPayoutFreezeReason,
      manualPayoutFrozenAt: shops.manualPayoutFrozenAt,
      manualPayoutFrozenByAdminId: shops.manualPayoutFrozenByAdminId,
      stripePayoutFreezeCode: shops.stripePayoutFreezeCode,
      stripePayoutFreezeReason: shops.stripePayoutFreezeReason,
      stripePayoutStatusSyncedAt: shops.stripePayoutStatusSyncedAt,
      createdAt: shops.createdAt,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  if (!shop.stripeAccountId) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Shop has no Stripe connected account');
  }

  const stripe = await getStripe();
  const acctId = shop.stripeAccountId;

  // 1) Retrieve account details
  let account: any = null;
  try {
    account = await stripe.accounts.retrieve(acctId);
  } catch (err: any) {
    throw new AppError(502, ErrorCode.INTERNAL_ERROR, `Stripe API error: ${err.message}`);
  }

  const syncedStripe = await syncStripePayoutStatusForShop(shop.id, account);
  const payoutFreeze = computePayoutFreezeState({
    manualPayoutFreeze: shop.manualPayoutFreeze,
    manualPayoutFreezeReason: shop.manualPayoutFreezeReason,
    stripePayoutsEnabled: syncedStripe.stripePayoutsEnabled,
    stripePayoutFreezeReason: syncedStripe.stripePayoutFreezeReason,
  });

  // 2) Get balance for this connected account
  let balance: any = null;
  try {
    balance = await stripe.balance.retrieve({ stripeAccount: acctId });
  } catch (err: any) {
    console.error('Balance fetch error:', err.message);
  }

  // 3) Get recent transfers TO this account
  let transfers: any[] = [];
  try {
    const list = await stripe.transfers.list({
      destination: acctId,
      limit: 20,
    });
    transfers = list.data;
  } catch (err: any) {
    console.error('Transfers fetch error:', err.message);
  }

  // 4) Get recent payouts FROM this connected account
  let stripPayouts: any[] = [];
  try {
    const list = await stripe.payouts.list(
      { limit: 20 },
      { stripeAccount: acctId },
    );
    stripPayouts = list.data;
  } catch (err: any) {
    console.error('Payouts fetch error:', err.message);
  }

  const payoutSchedule = await getConnectedPayoutSchedule(stripe, acctId);

  // 5) Get our internal payouts
  const internalPayouts = await db
    .select()
    .from(payouts)
    .where(eq(payouts.shopId, shopId))
    .orderBy(desc(payouts.createdAt))
    .limit(20);

  return {
    shop: {
      id: shop.id,
      name: shop.name,
      stripeAccountId: acctId,
      stripeConnected: syncedStripe.stripeConnected,
      stripeChargesEnabled: syncedStripe.stripeChargesEnabled,
      stripePayoutsEnabled: syncedStripe.stripePayoutsEnabled,
      manualPayoutFreeze: shop.manualPayoutFreeze,
      manualPayoutFreezeReason: shop.manualPayoutFreezeReason,
      manualPayoutFrozenAt: shop.manualPayoutFrozenAt?.toISOString() ?? null,
      manualPayoutFrozenByAdminId: shop.manualPayoutFrozenByAdminId,
      stripePayoutFreezeCode: syncedStripe.stripePayoutFreezeCode,
      stripePayoutFreezeReason: syncedStripe.stripePayoutFreezeReason,
      stripePayoutStatusSyncedAt: syncedStripe.stripePayoutStatusSyncedAt.toISOString(),
    },
    payoutFreeze,
    stripeAccount: {
      id: account.id,
      type: account.type,
      email: account.email,
      businessType: account.business_type,
      chargesEnabled: syncedStripe.stripeChargesEnabled,
      payoutsEnabled: syncedStripe.stripePayoutsEnabled,
      defaultCurrency: account.default_currency,
      country: account.country,
      created: account.created,
      requirements: {
        currentlyDue: account.requirements?.currently_due ?? [],
        pastDue: account.requirements?.past_due ?? [],
        disabledReason: syncedStripe.stripePayoutFreezeCode,
      },
      capabilities: account.capabilities ?? {},
      payoutsSchedule: payoutSchedule,
    },
    taxProfile: mapStripeTaxProfile(account),
    taxDocuments: buildTaxDocuments({
      country: account.country,
      startDate: account.created ? new Date(account.created * 1000) : shop.createdAt,
    }),
    balance: balance
      ? {
          available: balance.available?.map((b: any) => ({ amount: b.amount, currency: b.currency })) ?? [],
          pending: balance.pending?.map((b: any) => ({ amount: b.amount, currency: b.currency })) ?? [],
        }
      : null,
    recentTransfers: transfers.map((t) => ({
      id: t.id,
      amount: t.amount,
      currency: t.currency,
      created: t.created,
      description: t.description,
      metadata: t.metadata,
      reversed: t.reversed,
    })),
    recentPayouts: stripPayouts.map((p) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      arrivalDate: p.arrival_date,
      created: p.created,
      method: p.method,
      type: p.type,
    })),
    internalPayouts: internalPayouts.map((p) => ({
      ...p,
      createdAt: p.createdAt?.toISOString() ?? null,
      completedAt: p.completedAt?.toISOString() ?? null,
    })),
  };
}

// ─── Freeze / Unfreeze payouts in RepairRebel ───
// Manual freezes should not overwrite the seller's Stripe payout schedule.

export async function freezeConnectedAccount(
  shopId: string,
  adminUserId: string,
  reason: string,
) {
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Freeze reason is required');
  }

  const [shop] = await db
    .select({
      stripeAccountId: shops.stripeAccountId,
      name: shops.name,
      stripePayoutsEnabled: shops.stripePayoutsEnabled,
      stripePayoutFreezeReason: shops.stripePayoutFreezeReason,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop?.stripeAccountId) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Shop has no Stripe account');
  }

  await db.update(shops).set({
    manualPayoutFreeze: true,
    manualPayoutFreezeReason: normalizedReason,
    manualPayoutFrozenAt: new Date(),
    manualPayoutFrozenByAdminId: adminUserId,
    updatedAt: new Date(),
  }).where(eq(shops.id, shopId));

  const payoutFreeze = computePayoutFreezeState({
    manualPayoutFreeze: true,
    manualPayoutFreezeReason: normalizedReason,
    stripePayoutsEnabled: shop.stripePayoutsEnabled,
    stripePayoutFreezeReason: shop.stripePayoutFreezeReason,
  });

  console.log(`🔒 Applied manual payout freeze for shop ${shop.name} (${shop.stripeAccountId})`);
  return {
    frozen: true,
    shopId,
    stripeAccountId: shop.stripeAccountId,
    payoutFreeze,
  };
}

export async function unfreezeConnectedAccount(shopId: string) {
  const [shop] = await db
    .select({
      stripeAccountId: shops.stripeAccountId,
      name: shops.name,
      stripePayoutsEnabled: shops.stripePayoutsEnabled,
      stripePayoutFreezeReason: shops.stripePayoutFreezeReason,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop?.stripeAccountId) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Shop has no Stripe account');
  }

  await db.update(shops).set({
    manualPayoutFreeze: false,
    manualPayoutFreezeReason: null,
    manualPayoutFrozenAt: null,
    manualPayoutFrozenByAdminId: null,
    updatedAt: new Date(),
  }).where(eq(shops.id, shopId));

  const payoutFreeze = computePayoutFreezeState({
    manualPayoutFreeze: false,
    manualPayoutFreezeReason: null,
    stripePayoutsEnabled: shop.stripePayoutsEnabled,
    stripePayoutFreezeReason: shop.stripePayoutFreezeReason,
  });

  console.log(`🔓 Removed manual payout freeze for shop ${shop.name} (${shop.stripeAccountId})`);
  return {
    frozen: false,
    shopId,
    stripeAccountId: shop.stripeAccountId,
    payoutFreeze,
  };
}

// ─── Sync account status from Stripe ───

export async function syncConnectedAccountStatus(shopId: string) {
  const [shop] = await db
    .select({ stripeAccountId: shops.stripeAccountId })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop?.stripeAccountId) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Shop has no Stripe account');
  }

  const stripe = await getStripe();
  const account = await stripe.accounts.retrieve(shop.stripeAccountId);

  const synced = await syncStripePayoutStatusForShop(shopId, account);

  return {
    shopId,
    chargesEnabled: synced.stripeChargesEnabled,
    payoutsEnabled: synced.stripePayoutsEnabled,
    stripePayoutFreezeCode: synced.stripePayoutFreezeCode,
    stripePayoutFreezeReason: synced.stripePayoutFreezeReason,
  };
}
