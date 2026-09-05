import { eq } from 'drizzle-orm';

import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { shops } from '../db/schema/index.js';

export type PayoutFreezeSource = 'ADMIN' | 'STRIPE' | 'BOTH';

type ComputePayoutFreezeStateInput = {
  manualPayoutFreeze: boolean;
  manualPayoutFreezeReason: string | null;
  stripePayoutsEnabled: boolean;
  stripePayoutFreezeReason: string | null;
};

const STRIPE_DISABLED_REASON_MESSAGES: Record<string, string> = {
  'requirements.past_due': 'Stripe has paused payouts because required verification information is overdue.',
  'requirements.pending_verification': 'Stripe is still reviewing required verification information before payouts can resume.',
  'listed': 'Stripe has paused payouts while this connected account is under compliance review.',
  'under_review': 'Stripe is reviewing this connected account, so payouts are temporarily paused.',
  'rejected.fraud': 'Stripe has paused payouts because the connected account was flagged for elevated fraud risk.',
  'rejected.listed': 'Stripe has paused payouts because the connected account failed compliance screening.',
  'rejected.other': 'Stripe has paused payouts on this connected account.',
};

function normalizeReason(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function humanizeReasonCode(code: string) {
  return code.replace(/[._]/g, ' ');
}

export function describeStripePayoutFreezeReason(code: string | null | undefined) {
  if (!code) return null;
  return STRIPE_DISABLED_REASON_MESSAGES[code] ?? `Stripe has paused payouts due to account restrictions (${humanizeReasonCode(code)}).`;
}

export function computePayoutFreezeState(input: ComputePayoutFreezeStateInput) {
  const manualReason =
    normalizeReason(input.manualPayoutFreezeReason) ??
    (input.manualPayoutFreeze ? 'RepairRebel has temporarily paused payouts for this account.' : null);

  const stripeReason =
    normalizeReason(input.stripePayoutFreezeReason) ??
    (input.stripePayoutsEnabled ? null : 'Stripe has temporarily paused payouts on this connected account.');

  const adminFrozen = input.manualPayoutFreeze;
  const stripeFrozen = input.stripePayoutsEnabled === false;
  const payoutsFrozen = adminFrozen || stripeFrozen;

  let payoutFreezeSource: PayoutFreezeSource | null = null;
  if (adminFrozen && stripeFrozen) payoutFreezeSource = 'BOTH';
  else if (adminFrozen) payoutFreezeSource = 'ADMIN';
  else if (stripeFrozen) payoutFreezeSource = 'STRIPE';

  let payoutFreezeReason: string | null = null;
  if (payoutFreezeSource === 'BOTH') {
    payoutFreezeReason = manualReason ?? stripeReason;
  } else if (payoutFreezeSource === 'ADMIN') {
    payoutFreezeReason = manualReason;
  } else if (payoutFreezeSource === 'STRIPE') {
    payoutFreezeReason = stripeReason;
  }

  return {
    payoutsFrozen,
    payoutFreezeSource,
    payoutFreezeReason,
    manualPayoutFreezeReason: manualReason,
    stripePayoutFreezeReason: stripeReason,
  };
}

export function extractStripePayoutStatus(account: any) {
  const stripePayoutFreezeCode = account.requirements?.disabled_reason ?? null;

  return {
    stripeChargesEnabled: Boolean(account.charges_enabled),
    stripePayoutsEnabled: Boolean(account.payouts_enabled),
    stripeConnected: Boolean(account.charges_enabled && account.payouts_enabled),
    stripePayoutFreezeCode,
    stripePayoutFreezeReason: describeStripePayoutFreezeReason(stripePayoutFreezeCode),
    stripePayoutStatusSyncedAt: new Date(),
  };
}

export async function syncStripePayoutStatusForShop(shopId: string, account: any) {
  const status = extractStripePayoutStatus(account);

  await db
    .update(shops)
    .set({
      stripeChargesEnabled: status.stripeChargesEnabled,
      stripePayoutsEnabled: status.stripePayoutsEnabled,
      stripeConnected: status.stripeConnected,
      stripePayoutFreezeCode: status.stripePayoutFreezeCode,
      stripePayoutFreezeReason: status.stripePayoutFreezeReason,
      stripePayoutStatusSyncedAt: status.stripePayoutStatusSyncedAt,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId));

  return status;
}

export async function refreshShopPayoutFreezeState(shop: {
  id: string;
  stripeAccountId: string | null;
  manualPayoutFreeze: boolean;
  manualPayoutFreezeReason: string | null;
  stripePayoutsEnabled: boolean;
  stripePayoutFreezeReason: string | null;
}) {
  let stripePayoutsEnabled = shop.stripePayoutsEnabled;
  let stripePayoutFreezeReason = shop.stripePayoutFreezeReason;

  if (
    shop.stripeAccountId &&
    env.STRIPE_SECRET_KEY &&
    !shop.stripeAccountId.startsWith('acct_mock_')
  ) {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const account = await stripe.accounts.retrieve(shop.stripeAccountId);
    const synced = await syncStripePayoutStatusForShop(shop.id, account);
    stripePayoutsEnabled = synced.stripePayoutsEnabled;
    stripePayoutFreezeReason = synced.stripePayoutFreezeReason;
  }

  return {
    ...computePayoutFreezeState({
      manualPayoutFreeze: shop.manualPayoutFreeze,
      manualPayoutFreezeReason: shop.manualPayoutFreezeReason,
      stripePayoutsEnabled,
      stripePayoutFreezeReason,
    }),
    stripePayoutsEnabled,
    stripePayoutFreezeReason,
  };
}
