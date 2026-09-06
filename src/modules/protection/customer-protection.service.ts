import { eq, and, desc, sql, exists } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  protectionPlans,
  protectionSubscribers,
  protectionClaims,
  payouts,
  users,
  systemSettings,
  shops,
  memberships,
  jobs,
} from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { env } from '../../config/env.js';
import { sendProtectionNewSubscriberEmail } from '../../lib/email.js';
import { ensureStripeCustomerForUser } from '../../lib/stripe-customers.js';

// ─────────────────────────────────────────────
//  Stripe helpers (same pattern as customer-settings)
// ─────────────────────────────────────────────

const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

async function getStripe() {
  const stripeKey = env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    throw new AppError(503, ErrorCode.INTERNAL_ERROR, 'Stripe is not configured');
  }
  const Stripe = (await import('stripe')).default;
  return new Stripe(stripeKey);
}

async function getOrCreateStripeCustomer(userId: string) {
  const stripe = await getStripe();
  return ensureStripeCustomerForUser(stripe, userId);
}

async function getInsurancePercent(): Promise<number> {
  const [settings] = await db
    .select({ insurancePercent: systemSettings.insurancePercent })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID))
    .limit(1);
  const percent = settings?.insurancePercent ?? 5;
  return Math.max(0, Math.min(100, percent));
}

async function getShopConnectedAccountId(shopId: string): Promise<string | null> {
  const [shop] = await db
    .select({ stripeAccountId: shops.stripeAccountId, stripeConnected: shops.stripeConnected })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop?.stripeAccountId) return null;
  if (shop.stripeAccountId.startsWith('acct_mock_')) return null;
  if (!shop.stripeConnected) return null;
  return shop.stripeAccountId;
}

async function ensureSubscriptionConnectSplit(
  stripe: any,
  stripeSubscriptionId: string,
  connectedAccountId: string,
  insurancePercent: number,
  useOnBehalfOf: boolean,
) {
  try {
    const transferPercent = Math.max(0, Math.min(100, Number((100 - insurancePercent).toFixed(2))));
    const sub: any = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const currentDest = sub?.transfer_data?.destination ?? null;
    const currentTransferPercent = sub?.transfer_data?.amount_percent ?? null;
    const currentObo = sub?.on_behalf_of ?? null;

    const needsUpdate =
      currentDest !== connectedAccountId ||
      Number(currentTransferPercent ?? -1) !== Number(transferPercent) ||
      (useOnBehalfOf ? currentObo !== connectedAccountId : false);

    if (!needsUpdate) return;

    const updatePayload: any = {
      transfer_data: {
        destination: connectedAccountId,
        amount_percent: transferPercent,
      },
      metadata: {
        ...(sub?.metadata ?? {}),
        insurancePercent: String(insurancePercent),
        transferPercent: String(transferPercent),
      },
    };

    if (useOnBehalfOf) {
      updatePayload.on_behalf_of = connectedAccountId;
    }

    await stripe.subscriptions.update(stripeSubscriptionId, updatePayload);

    console.log(
      `✅ Protection subscription ${stripeSubscriptionId} synced to destination ${connectedAccountId} with transfer ${transferPercent}% (platform fee ${insurancePercent}%)`,
    );
  } catch (err: any) {
    console.error(
      `⚠️ Failed to sync subscription split for ${stripeSubscriptionId}:`,
      err?.message ?? err,
    );
  }
}

async function canUseOnBehalfOf(stripe: any, connectedAccountId: string): Promise<boolean> {
  try {
    const account: any = await stripe.accounts.retrieve(connectedAccountId);
    return account?.capabilities?.card_payments === 'active';
  } catch (err: any) {
    console.error(
      `⚠️ Failed to fetch connected account capabilities for ${connectedAccountId}:`,
      err?.message ?? err,
    );
    return false;
  }
}

async function ensureProtectionPayoutRecorded(
  subscriptionId: string,
  shopId: string,
  amountCents: number,
  platformFeeCents: number,
) {
  const payoutKey = `protection_sub_${subscriptionId}`;

  const [existing] = await db
    .select({ id: payouts.id })
    .from(payouts)
    .where(eq(payouts.stripeTransferId, payoutKey))
    .limit(1);

  if (existing) return;

  await db.insert(payouts).values({
    shopId,
    jobId: null,
    amountCents,
    platformFeeCents,
    netAmountCents: Math.max(0, amountCents - platformFeeCents),
    stripeTransferId: payoutKey,
    status: 'COMPLETED',
    completedAt: new Date(),
  });
}

async function notifyShopOwnersAboutNewSubscriber(data: {
  shopId: string;
  customerName: string;
  planName: string;
  billingType: 'MONTHLY' | 'ONE_TIME';
  priceCents: number;
  status: 'ACTIVE' | 'PAST_DUE';
}) {
  const [shopRow] = await db
    .select({ name: shops.name })
    .from(shops)
    .where(eq(shops.id, data.shopId))
    .limit(1);

  const owners = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.shopId, data.shopId), eq(memberships.role, 'OWNER')));

  await Promise.allSettled(
    owners
      .filter((owner) => !!owner.email)
      .map((owner) =>
        sendProtectionNewSubscriberEmail(owner.email, {
          shopName: shopRow?.name ?? 'Your shop',
          planName: data.planName,
          customerName: data.customerName,
          billingType: data.billingType,
          priceCents: data.priceCents,
          status: data.status,
        }),
      ),
  );
}

async function getCustomerDefaultPaymentMethod(stripe: any, stripeCustomerId: string): Promise<string> {
  const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId);
  if (stripeCustomer.deleted) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR,
      'Your payment profile was removed. Please add a card in Settings → Payment Methods.');
  }
  const defaultPmId = (stripeCustomer as any).invoice_settings?.default_payment_method ?? null;
  if (defaultPmId) return defaultPmId as string;

  // Fallback: pick the first saved card
  const pms = await stripe.paymentMethods.list({
    customer: stripeCustomerId,
    type: 'card',
    limit: 1,
  });
  if (!pms.data.length) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR,
      'No payment method on file. Please add a card in Settings → Payment Methods before subscribing.');
  }
  return pms.data[0].id;
}

/** Check if a Stripe ID is a stub placeholder from the old system. */
function isStubId(id: string | null | undefined): boolean {
  if (!id) return true;
  return id.startsWith('prod_stub_') || id.startsWith('price_stub_') || id.startsWith('sub_stub_');
}

function isMissingStripeResourceError(error: any, resource: 'price' | 'product'): boolean {
  const message = String(error?.message ?? '').toLowerCase();
  return error?.code === 'resource_missing' && message.includes(`no such ${resource}`);
}

function isCompatibleStripePriceForPlan(price: any, plan: any): boolean {
  const expectsRecurring = plan.billingType === 'MONTHLY';
  const isRecurring = Boolean(price?.recurring);
  const intervalMatches = expectsRecurring ? price?.recurring?.interval === 'month' : !isRecurring;

  return (
    price?.active !== false &&
    price?.currency === 'usd' &&
    price?.unit_amount === plan.priceCents &&
    isRecurring === expectsRecurring &&
    intervalMatches
  );
}

function isAwaitingInitialSubscriptionConfirmation(status: unknown): boolean {
  const normalized = String(status ?? '');
  return normalized === 'incomplete' || normalized === 'inactive';
}

/** Ensure the protection plan has a Stripe Product + Price; create on-the-fly if missing. */
async function ensureStripePriceForPlan(stripe: any, plan: any): Promise<string> {
  let productId: string | null = null;
  let priceId: string | null = null;

  if (plan.stripePriceId && !isStubId(plan.stripePriceId)) {
    try {
      const existingPrice = await stripe.prices.retrieve(plan.stripePriceId);
      productId =
        typeof existingPrice.product === 'string'
          ? existingPrice.product
          : existingPrice.product?.id ?? null;

      if (isCompatibleStripePriceForPlan(existingPrice, plan)) {
        priceId = existingPrice.id;
      } else {
        console.log(
          `Refreshing Stripe price for protection plan ${plan.id}: existing price ${existingPrice.id} no longer matches current plan settings`,
        );
      }
    } catch (error: any) {
      if (!isMissingStripeResourceError(error, 'price')) {
        throw error;
      }
      console.log(
        `Refreshing missing Stripe price for protection plan ${plan.id}: ${plan.stripePriceId}`,
      );
    }
  }

  if (!productId && plan.stripeProductId && !isStubId(plan.stripeProductId)) {
    try {
      const existingProduct = await stripe.products.retrieve(plan.stripeProductId);
      if (!(existingProduct as any).deleted) {
        productId = existingProduct.id;
      }
    } catch (error: any) {
      if (!isMissingStripeResourceError(error, 'product')) {
        throw error;
      }
      console.log(
        `Refreshing missing Stripe product for protection plan ${plan.id}: ${plan.stripeProductId}`,
      );
    }
  }

  if (priceId && productId) {
    if (plan.stripePriceId !== priceId || plan.stripeProductId !== productId) {
      await db
        .update(protectionPlans)
        .set({
          stripeProductId: productId,
          stripePriceId: priceId,
          updatedAt: new Date(),
        })
        .where(eq(protectionPlans.id, plan.id));
    }

    return priceId;
  }

  if (!productId) {
    const product = await stripe.products.create({
      name: `Protection Plan: ${plan.name}`,
      metadata: { protectionPlanId: plan.id, shopId: plan.shopId },
    });
    productId = product.id;
  }

  // Create a Stripe Price
  const priceParams: any = {
    product: productId,
    currency: 'usd',
    unit_amount: plan.priceCents,
    metadata: { protectionPlanId: plan.id },
  };
  if (plan.billingType === 'MONTHLY') {
    priceParams.recurring = { interval: 'month' };
  }
  const price = await stripe.prices.create(priceParams);
  priceId = price.id;

  // Persist Stripe IDs back so we don't recreate next time
  await db
    .update(protectionPlans)
    .set({
      stripeProductId: productId,
      stripePriceId: priceId,
      updatedAt: new Date(),
    })
    .where(eq(protectionPlans.id, plan.id));

  return price.id;
}

// ─────────────────────────────────────────────
//  LIST AVAILABLE PLANS (for customers to browse)
// ─────────────────────────────────────────────

export function completedRepairCondition(customerId: string) {
  return exists(db.select({ id: jobs.id }).from(jobs).where(and(
    eq(jobs.customerId, customerId), eq(jobs.shopId, shops.id),
    eq(jobs.status, 'COMPLETED'), eq(jobs.paymentStatus, 'RELEASED'),
  )));
}

export async function listAvailablePlans(customerId: string, shopId?: string) {
  const conditions = [
    eq(protectionPlans.status, 'ACTIVE'),
    eq(shops.protectionEnabled, true),
    eq(shops.onboardingStatus, 'APPROVED'),
    completedRepairCondition(customerId),
  ];
  if (shopId) {
    conditions.push(eq(protectionPlans.shopId, shopId));
  }

  const plans = await db
    .select({
      id: protectionPlans.id,
      shopId: protectionPlans.shopId,
      shopName: shops.name,
      shopLogoUrl: shops.logoUrl,
      name: protectionPlans.name,
      billingType: protectionPlans.billingType,
      priceCents: protectionPlans.priceCents,
      coverageDays: protectionPlans.coverageDays,
      coveredPartTypes: protectionPlans.coveredPartTypes,
      maxClaimsPerPeriod: protectionPlans.maxClaimsPerPeriod,
      maxPayoutPerClaimCents: protectionPlans.maxPayoutPerClaimCents,
      deductibleCents: protectionPlans.deductibleCents,
      termsText: protectionPlans.termsText,
      exclusionsText: protectionPlans.exclusionsText,
      createdAt: protectionPlans.createdAt,
    })
    .from(protectionPlans)
    .innerJoin(shops, eq(shops.id, protectionPlans.shopId))
    .where(and(...conditions))
    .orderBy(desc(protectionPlans.createdAt));

  return plans.map((p) => ({
    ...p,
    createdAt: p.createdAt?.toISOString(),
  }));
}

// ─────────────────────────────────────────────
//  SUBSCRIBE TO A PLAN
// ─────────────────────────────────────────────

export interface SubscribeInput {
  planId: string;
  customerName: string;
}

export async function subscribeToPlan(customerId: string, input: SubscribeInput) {
  // Get the plan
  const [plan] = await db
    .select()
    .from(protectionPlans)
    .where(and(eq(protectionPlans.id, input.planId), eq(protectionPlans.status, 'ACTIVE')))
    .limit(1);

  if (!plan) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Protection plan not found or inactive');
  }

  // Enforce eligibility before any Stripe calls, including direct subscriptions.
  const eligible = plan.shopId ? await listAvailablePlans(customerId, plan.shopId) : [];
  if (!eligible.some(candidate => candidate.id === plan.id)) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Complete a repair and release payment at this store before subscribing to its protection plans.');
  }

  // Check if customer already has an active subscription to this plan
  const [existing] = await db
    .select()
    .from(protectionSubscribers)
    .where(
      and(
        eq(protectionSubscribers.customerId, customerId),
        eq(protectionSubscribers.planId, input.planId),
        eq(protectionSubscribers.status, 'ACTIVE'),
      ),
    )
    .limit(1);

  if (existing) {
    throw new AppError(409, ErrorCode.CONFLICT, 'You already have an active subscription to this plan');
  }

  // ── Stripe charging ──
  const stripe = await getStripe();
  const stripeCustomerId = await getOrCreateStripeCustomer(customerId);
  const paymentMethodId = await getCustomerDefaultPaymentMethod(stripe, stripeCustomerId);
  const insurancePercent = await getInsurancePercent();

  // ── Clean up orphaned / incomplete Stripe subscriptions for this customer ──
  // This prevents orphaned active subs from piling up when 3DS retries occur
  try {
    const existingStripeSubs = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      limit: 50,
    });
    for (const oldSub of existingStripeSubs.data) {
      // Check if there's a PAST_DUE DB record that maps to an active Stripe sub — activate it
      if (oldSub.status === 'active') {
        const [pendingRecord] = await db
          .select()
          .from(protectionSubscribers)
          .where(
            and(
              eq(protectionSubscribers.stripeSubscriptionId, oldSub.id),
              eq(protectionSubscribers.customerId, customerId),
            ),
          )
          .limit(1);

        if (pendingRecord && pendingRecord.status !== 'ACTIVE' && pendingRecord.status !== 'CANCELED') {
          const connectedForRecord = await getShopConnectedAccountId(pendingRecord.shopId);
          if (connectedForRecord && oldSub.id.startsWith('sub_')) {
            const canUseOboForRecord = await canUseOnBehalfOf(stripe, connectedForRecord);
            await ensureSubscriptionConnectSplit(
              stripe,
              oldSub.id,
              connectedForRecord,
              insurancePercent,
              canUseOboForRecord,
            );
          }

          // Activate the existing DB record instead of creating a new subscription
          const [planForRecord] = await db.select().from(protectionPlans).where(eq(protectionPlans.id, pendingRecord.planId)).limit(1);
          const feeForRecord = Math.round((planForRecord?.priceCents ?? 0) * (insurancePercent / 100));

          await db
            .update(protectionSubscribers)
            .set({ status: 'ACTIVE', totalPaidCents: planForRecord?.priceCents ?? 0 })
            .where(eq(protectionSubscribers.id, pendingRecord.id));

          await ensureProtectionPayoutRecorded(
            pendingRecord.id,
            pendingRecord.shopId,
            planForRecord?.priceCents ?? 0,
            feeForRecord,
          );

          const updatedRecord = await db.select().from(protectionSubscribers).where(eq(protectionSubscribers.id, pendingRecord.id)).limit(1);
          return {
            ...updatedRecord[0],
            planName: planForRecord?.name ?? plan.name,
            planBillingType: planForRecord?.billingType ?? plan.billingType,
            planPriceCents: planForRecord?.priceCents ?? plan.priceCents,
            startedAt: updatedRecord[0]?.startedAt?.toISOString(),
            nextBillAt: updatedRecord[0]?.nextBillAt?.toISOString() ?? null,
            createdAt: updatedRecord[0]?.createdAt?.toISOString(),
            clientSecret: null,
            requiresAction: false,
          };
        }

        // No DB record — this is a fully orphaned active Stripe sub. Cancel it.
        if (!pendingRecord) {
          console.log(`Cleaning up orphaned active Stripe subscription ${oldSub.id}`);
          await stripe.subscriptions.cancel(oldSub.id).catch(() => {});
        }
      }

      // Cancel any incomplete Stripe subs to avoid clutter
      if (oldSub.status === 'incomplete' || oldSub.status === 'incomplete_expired') {
        await stripe.subscriptions.cancel(oldSub.id).catch(() => {});
      }
    }
  } catch (cleanupErr: any) {
    console.error('Subscribe: Failed to clean up old Stripe subscriptions:', cleanupErr.message);
  }
  const connectedAccountId = await getShopConnectedAccountId(plan.shopId);

  if (!connectedAccountId) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      'This store is not connected for insurance payouts yet. Please try another store.',
    );
  }

  const useOnBehalfOf = await canUseOnBehalfOf(stripe, connectedAccountId);

  let stripeSubscriptionId: string | null = null;
  let stripePaymentIntentId: string | null = null;
  let clientSecret: string | null = null;
  let requiresAction = false;
  let nextBillAt: Date | null = null;

  try {
    if (plan.billingType === 'MONTHLY') {
      // ── Monthly recurring subscription via Stripe Billing ──
      // For default_incomplete subscriptions, Stripe creates the first invoice PaymentIntent
      // and expects the client to confirm it on-session.
      const stripePriceId = await ensureStripePriceForPlan(stripe, plan);

      // Set customer's default PM for invoices (used for future recurring charges)
      await stripe.customers.update(stripeCustomerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });

      const subscriptionParams: any = {
        customer: stripeCustomerId,
        items: [{ price: stripePriceId }],
        collection_method: 'charge_automatically',
        payment_behavior: 'default_incomplete',
        default_payment_method: paymentMethodId,
        payment_settings: {
          payment_method_types: ['card'],
          save_default_payment_method: 'on_subscription',
        },
        metadata: {
          protectionPlanId: plan.id,
          customerId,
          shopId: plan.shopId,
          insurancePercent: String(insurancePercent),
        },
      };
      subscriptionParams.expand = ['latest_invoice.confirmation_secret', 'latest_invoice.payment_intent'];

      // Destination charge split:
      // - Store receives amount minus insurance fee
      // - Platform keeps insurance percentage configured by admin
      if (connectedAccountId) {
        const transferPercent = Math.max(0, Math.min(100, Number((100 - insurancePercent).toFixed(2))));
        subscriptionParams.transfer_data = {
          destination: connectedAccountId,
          amount_percent: transferPercent,
        };
        if (useOnBehalfOf) {
          subscriptionParams.on_behalf_of = connectedAccountId;
        }
      }

      const subscription = await stripe.subscriptions.create(subscriptionParams);

      console.log('🛡️ Protection monthly subscription created:', {
        subscriptionId: subscription.id,
        status: subscription.status,
        customerId,
        shopId: plan.shopId,
        connectedAccountId,
        insurancePercent,
        transferPercent: Math.max(0, Math.min(100, Number((100 - insurancePercent).toFixed(2)))),
        useOnBehalfOf,
      });

      if (connectedAccountId) {
        await ensureSubscriptionConnectSplit(
          stripe,
          subscription.id,
          connectedAccountId,
          insurancePercent,
          useOnBehalfOf,
        );
      }

      stripeSubscriptionId = subscription.id;
      let invoice: any = subscription.latest_invoice as any;
      if (typeof invoice === 'string') {
        invoice = await stripe.invoices.retrieve(invoice, {
          expand: ['confirmation_secret', 'payment_intent'],
        });
      } else if (invoice?.id && !invoice?.payment_intent) {
        invoice = await stripe.invoices.retrieve(invoice.id, {
          expand: ['confirmation_secret', 'payment_intent'],
        });
      }

      let pi = invoice?.payment_intent;
      const invoiceConfirmationSecret = invoice?.confirmation_secret?.client_secret ?? null;
      const isAwaitingConfirmation = isAwaitingInitialSubscriptionConfirmation(subscription.status);
      if (pi) stripePaymentIntentId = pi.id;

      console.log('🛡️ Protection first invoice:', {
        subscriptionId: subscription.id,
        invoiceId: invoice?.id ?? null,
        invoiceStatus: invoice?.status ?? null,
        amountDue: invoice?.amount_due ?? null,
        amountPaid: invoice?.amount_paid ?? null,
        attemptCount: invoice?.attempt_count ?? null,
        hasConfirmationSecret: Boolean(invoiceConfirmationSecret),
      });

      console.log('🛡️ Protection first invoice PI:', {
        subscriptionId: subscription.id,
        paymentIntentId: pi?.id ?? null,
        paymentIntentStatus: pi?.status ?? null,
        lastPaymentError: pi?.last_payment_error?.message ?? null,
      });

      if (
        subscription.status === 'active' ||
        invoice?.status === 'paid' ||
        pi?.status === 'succeeded' ||
        pi?.status === 'processing'
      ) {
        // Payment succeeded immediately — card charged!
      } else if (
        isAwaitingConfirmation &&
        (invoiceConfirmationSecret ||
          pi?.status === 'requires_confirmation' ||
          pi?.status === 'requires_action')
      ) {
        clientSecret = invoiceConfirmationSecret ?? pi?.client_secret ?? null;
        requiresAction = true;
      } else if (
        isAwaitingConfirmation &&
        pi?.status === 'requires_payment_method'
      ) {
        const declineMsg =
          pi?.last_payment_error?.message ||
          'Your card could not be charged. Please update your payment method and try again.';
        throw new AppError(402, ErrorCode.VALIDATION_ERROR, declineMsg);
      } else if (
        isAwaitingConfirmation &&
        (invoiceConfirmationSecret || pi?.client_secret)
      ) {
        clientSecret = invoiceConfirmationSecret ?? pi?.client_secret ?? null;
        requiresAction = true;
      } else if (
        subscription.status === 'past_due' ||
        subscription.status === 'trialing'
      ) {
        // Shouldn't happen for a new sub, but handle gracefully
      } else if (isAwaitingConfirmation) {
        throw new AppError(
          402,
          ErrorCode.VALIDATION_ERROR,
          'Subscription payment is pending. Please retry verification.',
        );
      }

      const periodEnd = (subscription as any).current_period_end;
      nextBillAt = periodEnd ? new Date(periodEnd * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    } else {
      // ── One-time payment via PaymentIntent ──
      const platformFeeCents = Math.round(plan.priceCents * (insurancePercent / 100));
      const piMetadata = {
        protectionPlanId: plan.id,
        customerId,
        shopId: plan.shopId,
        insurancePercent: String(insurancePercent),
        platformFeeCents: String(platformFeeCents),
        type: 'protection_one_time',
      };

      const splitFields: any = connectedAccountId
        ? {
            application_fee_amount: platformFeeCents,
            transfer_data: { destination: connectedAccountId },
          }
        : {};

      // Try off-session first (no 3DS challenge)
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: plan.priceCents,
          currency: 'usd',
          customer: stripeCustomerId,
          payment_method: paymentMethodId,
          off_session: true,
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: piMetadata,
          ...splitFields,
        });
        stripePaymentIntentId = paymentIntent.id;
      } catch (piErr: any) {
        if (piErr.code === 'authentication_required') {
          // Card requires 3DS — create on-session PaymentIntent
          const onSessionPi = await stripe.paymentIntents.create({
            amount: plan.priceCents,
            currency: 'usd',
            customer: stripeCustomerId,
            payment_method: paymentMethodId,
            confirm: true,
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
            metadata: piMetadata,
            ...splitFields,
          });
          stripePaymentIntentId = onSessionPi.id;
          clientSecret = onSessionPi.client_secret;
          requiresAction = onSessionPi.status === 'requires_action';
        } else {
          throw piErr;
        }
      }
    }
  } catch (err: any) {
    if (err instanceof AppError) throw err;

    let userMessage = 'Payment failed. Please try again.';
    const stripeCode = err.code ?? err.decline_code ?? '';
    if (stripeCode === 'card_declined' || err.decline_code) {
      userMessage = 'Your card was declined. Please update your payment method and try again.';
    } else if (stripeCode === 'insufficient_funds') {
      userMessage = 'Insufficient funds on your card. Please use a different card.';
    } else if (stripeCode === 'expired_card') {
      userMessage = 'Your card has expired. Please update your payment method.';
    } else if (stripeCode === 'incorrect_cvc') {
      userMessage = 'Incorrect CVC. Please check your card details.';
    } else if (stripeCode === 'processing_error') {
      userMessage = 'Payment processing error. Please try again in a moment.';
    }
    console.error('Stripe protection payment failed:', err.message);
    throw new AppError(402, ErrorCode.VALIDATION_ERROR, userMessage);
  }

  const [subscription] = await db
    .insert(protectionSubscribers)
    .values({
      planId: plan.id,
      shopId: plan.shopId,
      customerId,
      customerName: input.customerName,
      status: requiresAction ? 'PAST_DUE' : 'ACTIVE',
      stripeSubscriptionId: stripeSubscriptionId ?? stripePaymentIntentId,
      autopayEnabled: plan.billingType === 'MONTHLY',
      totalPaidCents: requiresAction ? 0 : plan.priceCents,
      claimsCount: 0,
      nextBillAt,
    })
    .returning();

  if (!requiresAction) {
    const platformFeeCents = Math.round(plan.priceCents * (insurancePercent / 100));
    await ensureProtectionPayoutRecorded(subscription.id, plan.shopId, plan.priceCents, platformFeeCents);
  }

  notifyShopOwnersAboutNewSubscriber({
    shopId: plan.shopId,
    customerName: input.customerName,
    planName: plan.name,
    billingType: plan.billingType,
    priceCents: plan.priceCents,
    status: requiresAction ? 'PAST_DUE' : 'ACTIVE',
  }).catch((err) => console.error('Failed to send protection subscriber email:', err));

  return {
    ...subscription,
    planName: plan.name,
    planBillingType: plan.billingType,
    planPriceCents: plan.priceCents,
    startedAt: subscription.startedAt?.toISOString(),
    nextBillAt: subscription.nextBillAt?.toISOString() ?? null,
    createdAt: subscription.createdAt?.toISOString(),
    // Pass back to client for 3DS handling
    clientSecret,
    requiresAction,
    publishableKey: requiresAction ? (env.STRIPE_PUBLISHABLE_KEY ?? undefined) : undefined,
  };
}

// ─────────────────────────────────────────────
//  CONFIRM SUBSCRIPTION PAYMENT (after 3DS)
// ─────────────────────────────────────────────

export async function confirmSubscriptionPayment(customerId: string, subscriptionId: string) {
  const [sub] = await db
    .select()
    .from(protectionSubscribers)
    .where(
      and(
        eq(protectionSubscribers.id, subscriptionId),
        eq(protectionSubscribers.customerId, customerId),
      ),
    )
    .limit(1);

  if (!sub) throw new AppError(404, ErrorCode.NOT_FOUND, 'Subscription not found');
  if (sub.status === 'ACTIVE') return { status: 'succeeded', subscriptionId: sub.id };

  const stripe = await getStripe();
  const stripeRefId = sub.stripeSubscriptionId;

  if (!stripeRefId) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'No Stripe payment record for this subscription');
  }

  const activateSubscriptionRecord = async () => {
    const [plan] = await db
      .select()
      .from(protectionPlans)
      .where(eq(protectionPlans.id, sub.planId))
      .limit(1);
    const insurancePercent = await getInsurancePercent();
    const platformFeeCents = Math.round((plan?.priceCents ?? 0) * (insurancePercent / 100));

    await db
      .update(protectionSubscribers)
      .set({ status: 'ACTIVE', totalPaidCents: plan?.priceCents ?? 0 })
      .where(eq(protectionSubscribers.id, subscriptionId));

    await ensureProtectionPayoutRecorded(
      subscriptionId,
      sub.shopId,
      plan?.priceCents ?? 0,
      platformFeeCents,
    );

    return { status: 'succeeded', subscriptionId: sub.id };
  };

  if (stripeRefId.startsWith('pi_')) {
    const pi = await stripe.paymentIntents.retrieve(stripeRefId);

    if (pi.status === 'succeeded' || pi.status === 'processing') {
      return activateSubscriptionRecord();
    }

    if (pi.status === 'requires_action') {
      return {
        status: 'requires_action',
        clientSecret: pi.client_secret,
        publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '',
      };
    }

    if (pi.status === 'requires_confirmation') {
      const confirmed = await stripe.paymentIntents.confirm(pi.id);
      if (confirmed.status === 'succeeded' || confirmed.status === 'processing') {
        return activateSubscriptionRecord();
      }
      if (confirmed.status === 'requires_action') {
        return {
          status: 'requires_action',
          clientSecret: confirmed.client_secret,
          publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '',
        };
      }
    }

    throw new AppError(
      402,
      ErrorCode.VALIDATION_ERROR,
      'Payment could not be completed. Please try again.',
    );
  }

  if (!stripeRefId.startsWith('sub_')) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'No Stripe subscription for this record');
  }

  const stripeSub = await stripe.subscriptions.retrieve(stripeRefId, {
    expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payment_intent'],
  });

  // If Stripe already moved the sub to active (PI succeeded via 3DS), activate our record
  if (stripeSub.status === 'active') {
    return activateSubscriptionRecord();
  }

  const invoice = stripeSub.latest_invoice as any;
  const pi = invoice?.payment_intent;
  const invoiceConfirmationSecret = invoice?.confirmation_secret?.client_secret ?? null;
  const isAwaitingConfirmation = isAwaitingInitialSubscriptionConfirmation(stripeSub.status);

  if (invoice?.status === 'paid') {
    return activateSubscriptionRecord();
  }

  if (pi?.status === 'succeeded' || pi?.status === 'processing') {
    return activateSubscriptionRecord();
  }

  if (pi?.status === 'requires_action' || pi?.status === 'requires_confirmation') {
    return {
      status: 'requires_action',
      clientSecret: invoiceConfirmationSecret ?? pi.client_secret,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '',
    };
  }

  if (isAwaitingConfirmation && invoiceConfirmationSecret) {
    return {
      status: 'requires_action',
      clientSecret: invoiceConfirmationSecret,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '',
    };
  }

  if (pi?.status === 'requires_payment_method') {
    throw new AppError(
      402,
      ErrorCode.VALIDATION_ERROR,
      pi.last_payment_error?.message ?? 'Payment could not be completed. Please update your card and try again.',
    );
  }

  if (!pi && !invoiceConfirmationSecret) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'No payment intent found for this subscription');
  }

  // Payment failed
  throw new AppError(402, ErrorCode.VALIDATION_ERROR, 'Payment could not be completed. Please try again.');
}

// ─────────────────────────────────────────────
//  MY SUBSCRIPTIONS
// ─────────────────────────────────────────────

export async function getMySubscriptions(customerId: string) {
  const subs = await db
    .select({
      id: protectionSubscribers.id,
      planId: protectionSubscribers.planId,
      shopId: protectionSubscribers.shopId,
      status: protectionSubscribers.status,
      autopayEnabled: protectionSubscribers.autopayEnabled,
      totalPaidCents: protectionSubscribers.totalPaidCents,
      claimsCount: protectionSubscribers.claimsCount,
      startedAt: protectionSubscribers.startedAt,
      nextBillAt: protectionSubscribers.nextBillAt,
      canceledAt: protectionSubscribers.canceledAt,
      createdAt: protectionSubscribers.createdAt,
      planName: protectionPlans.name,
      planBillingType: protectionPlans.billingType,
      planPriceCents: protectionPlans.priceCents,
      planCoverageDays: protectionPlans.coverageDays,
      planMaxClaims: protectionPlans.maxClaimsPerPeriod,
    })
    .from(protectionSubscribers)
    .innerJoin(protectionPlans, eq(protectionSubscribers.planId, protectionPlans.id))
    .where(eq(protectionSubscribers.customerId, customerId))
    .orderBy(desc(protectionSubscribers.createdAt));

  return subs.map((s) => ({
    ...s,
    startedAt: s.startedAt?.toISOString(),
    nextBillAt: s.nextBillAt?.toISOString() ?? null,
    canceledAt: s.canceledAt?.toISOString() ?? null,
    createdAt: s.createdAt?.toISOString(),
  }));
}

// ─────────────────────────────────────────────
//  TOGGLE AUTOPAY
// ─────────────────────────────────────────────

export async function toggleAutopay(customerId: string, subscriptionId: string, enabled: boolean) {
  const [sub] = await db
    .select()
    .from(protectionSubscribers)
    .where(
      and(
        eq(protectionSubscribers.id, subscriptionId),
        eq(protectionSubscribers.customerId, customerId),
      ),
    )
    .limit(1);

  if (!sub) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Subscription not found');
  }

  if (sub.status !== 'ACTIVE') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Can only toggle autopay on active subscriptions');
  }

  // Update Stripe subscription: cancel_at_period_end = true means autopay off
  if (sub.stripeSubscriptionId && sub.stripeSubscriptionId.startsWith('sub_')) {
    try {
      const stripe = await getStripe();
      await stripe.subscriptions.update(sub.stripeSubscriptionId, {
        cancel_at_period_end: !enabled,
      });
    } catch (err: any) {
      console.error('Stripe autopay toggle failed:', err.message);
      throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'Failed to update subscription autopay with Stripe');
    }
  }

  const [updated] = await db
    .update(protectionSubscribers)
    .set({ autopayEnabled: enabled })
    .where(eq(protectionSubscribers.id, subscriptionId))
    .returning();

  return {
    id: updated.id,
    autopayEnabled: updated.autopayEnabled,
    status: updated.status,
  };
}

// ─────────────────────────────────────────────
//  CANCEL SUBSCRIPTION
// ─────────────────────────────────────────────

export async function cancelMySubscription(customerId: string, subscriptionId: string) {
  const [sub] = await db
    .select()
    .from(protectionSubscribers)
    .where(
      and(
        eq(protectionSubscribers.id, subscriptionId),
        eq(protectionSubscribers.customerId, customerId),
      ),
    )
    .limit(1);

  if (!sub) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Subscription not found');
  }

  if (sub.status === 'CANCELED') {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Subscription is already canceled');
  }

  // Cancel the Stripe subscription
  if (sub.stripeSubscriptionId && sub.stripeSubscriptionId.startsWith('sub_')) {
    try {
      const stripe = await getStripe();
      await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
    } catch (err: any) {
      console.error('Stripe subscription cancellation failed:', err.message);
      // Still proceed to cancel locally even if Stripe fails
    }
  }

  const [updated] = await db
    .update(protectionSubscribers)
    .set({
      status: 'CANCELED',
      autopayEnabled: false,
      canceledAt: new Date(),
    })
    .where(eq(protectionSubscribers.id, subscriptionId))
    .returning();

  return {
    id: updated.id,
    status: updated.status,
    canceledAt: updated.canceledAt?.toISOString(),
  };
}

// ─────────────────────────────────────────────
//  SUBMIT CLAIM
// ─────────────────────────────────────────────

export interface SubmitClaimInput {
  subscriptionId: string;
  deviceModel: string;
  reason: string;
  evidenceUrls?: string[];
  urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
  jobId?: string;
}

export async function submitClaim(customerId: string, customerName: string, input: SubmitClaimInput) {
  // Verify the subscription belongs to customer and is active
  const [sub] = await db
    .select()
    .from(protectionSubscribers)
    .where(
      and(
        eq(protectionSubscribers.id, input.subscriptionId),
        eq(protectionSubscribers.customerId, customerId),
        eq(protectionSubscribers.status, 'ACTIVE'),
      ),
    )
    .limit(1);

  if (!sub) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Active subscription not found');
  }

  // Check claims limit
  const [plan] = await db
    .select()
    .from(protectionPlans)
    .where(eq(protectionPlans.id, sub.planId))
    .limit(1);

  if (plan && sub.claimsCount >= plan.maxClaimsPerPeriod) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Maximum claims limit reached for this subscription');
  }

  const [claim] = await db
    .insert(protectionClaims)
    .values({
      planId: sub.planId,
      subscriptionId: sub.id,
      shopId: sub.shopId,
      customerId,
      customerName,
      jobId: input.jobId ?? null,
      deviceModel: input.deviceModel,
      reason: input.reason,
      evidenceUrls: input.evidenceUrls ?? [],
      status: 'OPEN',
      urgency: input.urgency ?? 'LOW',
    })
    .returning();

  // Increment claims count on subscription
  await db
    .update(protectionSubscribers)
    .set({ claimsCount: sql`${protectionSubscribers.claimsCount} + 1` })
    .where(eq(protectionSubscribers.id, sub.id));

  return {
    ...claim,
    createdAt: claim.createdAt?.toISOString(),
    updatedAt: claim.updatedAt?.toISOString(),
  };
}

// ─────────────────────────────────────────────
//  MY CLAIMS
// ─────────────────────────────────────────────

export async function getMyClaims(customerId: string) {
  const claims = await db
    .select({
      id: protectionClaims.id,
      planId: protectionClaims.planId,
      subscriptionId: protectionClaims.subscriptionId,
      shopId: protectionClaims.shopId,
      deviceModel: protectionClaims.deviceModel,
      reason: protectionClaims.reason,
      evidenceUrls: protectionClaims.evidenceUrls,
      status: protectionClaims.status,
      urgency: protectionClaims.urgency,
      decisionNotes: protectionClaims.decisionNotes,
      payoutAmountCents: protectionClaims.payoutAmountCents,
      reviewedAt: protectionClaims.reviewedAt,
      createdAt: protectionClaims.createdAt,
      planName: protectionPlans.name,
    })
    .from(protectionClaims)
    .innerJoin(protectionPlans, eq(protectionClaims.planId, protectionPlans.id))
    .where(eq(protectionClaims.customerId, customerId))
    .orderBy(desc(protectionClaims.createdAt));

  return claims.map((c) => ({
    ...c,
    reviewedAt: c.reviewedAt?.toISOString() ?? null,
    createdAt: c.createdAt?.toISOString(),
  }));
}
