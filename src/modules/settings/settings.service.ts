import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { shops } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { env } from '../../config/env.js';
import {
  buildTaxDocuments,
  createExpressDashboardLoginLink,
  getStripeClient,
  mapStripeTaxProfile,
} from '../../lib/stripe-connect-tax.js';
import { syncStripePayoutStatusForShop } from '../../lib/payout-freeze.js';
import type {
  StartStripeConnectBody,
  UpdateWarrantyBody,
  UpdateVacationBody,
  UpdateNotificationsBody,
  UpdateLocationExtBody,
} from './settings.schema.js';

// ──────────────────────────────────────────────────────────
// GET FULL SHOP PROFILE
// ──────────────────────────────────────────────────────────

export async function getShopProfile(shopId: string) {
  const [shop] = await db
    .select({
      id: shops.id,
      name: shops.name,
      phone: shops.phone,
      website: shops.website,
      description: shops.description,
      categories: shops.categories,
      logoUrl: shops.logoUrl,
      address: shops.address,
      city: shops.city,
      state: shops.state,
      zipCode: shops.zipCode,
      country: shops.country,
      latitude: shops.latitude,
      longitude: shops.longitude,
      serviceRadius: shops.serviceRadius,
      placeId: shops.placeId,
      businessHours: shops.businessHours,
      vacationMode: shops.vacationMode,
      warrantyEnabled: shops.warrantyEnabled,
      defaultWarrantyDays: shops.defaultWarrantyDays,
      perPartWarrantyOverrides: shops.perPartWarrantyOverrides,
      warrantyPolicyText: shops.warrantyPolicyText,
      notificationSound: shops.notificationSound,
      notificationVibration: shops.notificationVibration,
      quietHoursStart: shops.quietHoursStart,
      quietHoursEnd: shops.quietHoursEnd,
      stripeConnected: shops.stripeConnected,
      stripeChargesEnabled: shops.stripeChargesEnabled,
      stripePayoutsEnabled: shops.stripePayoutsEnabled,
      stripeAccountId: shops.stripeAccountId,
      onboardingStatus: shops.onboardingStatus,
      protectionEnabled: shops.protectionEnabled,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  return shop;
}

// ──────────────────────────────────────────────────────────
// UPDATE WARRANTY SETTINGS
// ──────────────────────────────────────────────────────────

export async function updateWarranty(shopId: string, data: UpdateWarrantyBody) {
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.warrantyEnabled !== undefined) updateData.warrantyEnabled = data.warrantyEnabled;
  if (data.defaultWarrantyDays !== undefined) updateData.defaultWarrantyDays = data.defaultWarrantyDays;
  if (data.perPartWarrantyOverrides !== undefined) updateData.perPartWarrantyOverrides = data.perPartWarrantyOverrides;
  if (data.warrantyPolicyText !== undefined) updateData.warrantyPolicyText = data.warrantyPolicyText || null;

  const [updated] = await db
    .update(shops)
    .set(updateData)
    .where(eq(shops.id, shopId))
    .returning({
      id: shops.id,
      warrantyEnabled: shops.warrantyEnabled,
      defaultWarrantyDays: shops.defaultWarrantyDays,
      perPartWarrantyOverrides: shops.perPartWarrantyOverrides,
      warrantyPolicyText: shops.warrantyPolicyText,
    });

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  return updated;
}

// ──────────────────────────────────────────────────────────
// UPDATE VACATION MODE
// ──────────────────────────────────────────────────────────

export async function updateVacation(shopId: string, data: UpdateVacationBody) {
  const [updated] = await db
    .update(shops)
    .set({
      vacationMode: data.vacationMode,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning({
      id: shops.id,
      vacationMode: shops.vacationMode,
    });

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  return updated;
}

// ──────────────────────────────────────────────────────────
// UPDATE NOTIFICATION PREFERENCES
// ──────────────────────────────────────────────────────────

export async function updateNotifications(shopId: string, data: UpdateNotificationsBody) {
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.notificationSound !== undefined) updateData.notificationSound = data.notificationSound;
  if (data.notificationVibration !== undefined) updateData.notificationVibration = data.notificationVibration;
  if (data.quietHoursStart !== undefined) updateData.quietHoursStart = data.quietHoursStart;
  if (data.quietHoursEnd !== undefined) updateData.quietHoursEnd = data.quietHoursEnd;

  const [updated] = await db
    .update(shops)
    .set(updateData)
    .where(eq(shops.id, shopId))
    .returning({
      id: shops.id,
      notificationSound: shops.notificationSound,
      notificationVibration: shops.notificationVibration,
      quietHoursStart: shops.quietHoursStart,
      quietHoursEnd: shops.quietHoursEnd,
    });

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  return updated;
}

// ──────────────────────────────────────────────────────────
// UPDATE LOCATION (extended with city/state/zip/country)
// ──────────────────────────────────────────────────────────

export async function updateLocationExt(shopId: string, data: UpdateLocationExtBody) {
  const [updated] = await db
    .update(shops)
    .set({
      address: data.address,
      city: data.city || null,
      state: data.state || null,
      zipCode: data.zipCode || null,
      country: data.country || null,
      latitude: data.latitude,
      longitude: data.longitude,
      placeId: data.placeId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning({
      id: shops.id,
      address: shops.address,
      city: shops.city,
      state: shops.state,
      zipCode: shops.zipCode,
      country: shops.country,
      latitude: shops.latitude,
      longitude: shops.longitude,
      placeId: shops.placeId,
    });

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  return updated;
}

// ──────────────────────────────────────────────────────────
// STRIPE CONNECT — START ONBOARDING
// ──────────────────────────────────────────────────────────

export async function startStripeConnect(
  shopId: string,
  options: StartStripeConnectBody = {},
) {
  const stripeKey = env.STRIPE_SECRET_KEY;

  // If Stripe is not configured, return a mock onboarding URL  
  if (!stripeKey) {
    // Update the shop to simulate connection start
    await db
      .update(shops)
      .set({ updatedAt: new Date() })
      .where(eq(shops.id, shopId));

    return {
      url: null,
      message: 'Stripe is not configured. In production, this would redirect to Stripe Connect onboarding.',
      mock: true,
    };
  }

  // Dynamic import to avoid crash if stripe isn't installed
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(stripeKey);

  // Check if shop already has a Stripe account
  const [shop] = await db
    .select({ stripeAccountId: shops.stripeAccountId })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');

  let accountId = shop.stripeAccountId;

  if (!accountId) {
    try {
      // Create a new Stripe Express account
      const account = await stripe.accounts.create({ type: 'express' });
      accountId = account.id;

      await db
        .update(shops)
        .set({ stripeAccountId: accountId, updatedAt: new Date() })
        .where(eq(shops.id, shopId));
    } catch (err: any) {
      // Handle "Connect not enabled" error gracefully
      const msg = err?.message ?? '';
      if (msg.includes('Connect') || msg.includes('connect')) {
        // Stripe Connect not enabled — simulate for testing
        const mockAccountId = `acct_mock_${shopId.slice(0, 8)}`;
        await db
          .update(shops)
          .set({
            stripeAccountId: mockAccountId,
            stripeConnected: true,
            stripeChargesEnabled: true,
            stripePayoutsEnabled: true,
            updatedAt: new Date(),
          })
          .where(eq(shops.id, shopId));

        return {
          url: null,
          message: 'Stripe Connect not enabled on your account. Simulated connection for testing. Enable at https://dashboard.stripe.com/connect/overview',
          mock: true,
          accountId: mockAccountId,
        };
      }
      throw new AppError(500, ErrorCode.INTERNAL_ERROR, msg || 'Failed to create Stripe account');
    }
  }

  try {
    const publicBridgeBase =
      env.NODE_ENV === 'production'
        ? 'https://api.claude.lt'
        : `http://localhost:${env.PORT}`;
    const refreshUrl = options.refreshUrl || `${publicBridgeBase}/stripe/refresh?app=store`;
    const returnUrl = options.returnUrl || `${publicBridgeBase}/stripe/return?app=store`;

    // Create an account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    return {
      url: accountLink.url,
      message: 'Redirect user to this URL to complete Stripe onboarding.',
      mock: false,
    };
  } catch (err: any) {
    throw new AppError(500, ErrorCode.INTERNAL_ERROR, err?.message || 'Failed to create account link');
  }
}

// ──────────────────────────────────────────────────────────
// STRIPE CONNECT — GET STATUS
// ──────────────────────────────────────────────────────────

export async function getStripeStatus(shopId: string) {
  const [shop] = await db
    .select({
      stripeAccountId: shops.stripeAccountId,
      stripeConnected: shops.stripeConnected,
      stripeChargesEnabled: shops.stripeChargesEnabled,
      stripePayoutsEnabled: shops.stripePayoutsEnabled,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');

  // If no account ID, not connected
  if (!shop.stripeAccountId) {
    return {
      status: 'not_connected' as const,
      chargesEnabled: false,
      payoutsEnabled: false,
      accountId: null,
    };
  }

  const stripeKey = env.STRIPE_SECRET_KEY;

  // If Stripe is configured and account is real (not mock), fetch live status
  if (stripeKey && !shop.stripeAccountId.startsWith('acct_mock_')) {
    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(stripeKey);
      const account = await stripe.accounts.retrieve(shop.stripeAccountId);

      const syncedStripe = await syncStripePayoutStatusForShop(shopId, account);
      const chargesEnabled = syncedStripe.stripeChargesEnabled;
      const payoutsEnabled = syncedStripe.stripePayoutsEnabled;
      const detailsSubmitted = account.details_submitted ?? false;

      let status: 'connected' | 'pending' | 'requires_action' | 'not_connected';
      if (chargesEnabled && payoutsEnabled) {
        status = 'connected';
      } else if (detailsSubmitted) {
        status = 'pending';
      } else {
        status = 'requires_action';
      }

      return {
        status,
        chargesEnabled,
        payoutsEnabled,
        accountId: shop.stripeAccountId,
      };
    } catch {
      // Stripe API error — fall through to DB values
    }
  }

  // Fallback to stored values
  let status: 'connected' | 'pending' | 'requires_action' | 'not_connected';
  if (shop.stripeConnected) {
    status = 'connected';
  } else if (shop.stripeAccountId) {
    status = 'pending';
  } else {
    status = 'not_connected';
  }

  return {
    status,
    chargesEnabled: shop.stripeChargesEnabled,
    payoutsEnabled: shop.stripePayoutsEnabled,
    accountId: shop.stripeAccountId,
  };
}

// ──────────────────────────────────────────────────────────
// TAX DOCUMENTS
// ──────────────────────────────────────────────────────────

export async function getShopTaxDocuments(shopId: string) {
  const [shop] = await db
    .select({
      id: shops.id,
      name: shops.name,
      stripeAccountId: shops.stripeAccountId,
      stripeConnected: shops.stripeConnected,
      stripePayoutsEnabled: shops.stripePayoutsEnabled,
      country: shops.country,
      createdAt: shops.createdAt,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  }

  if (!shop.stripeAccountId) {
    return {
      shopId: shop.id,
      shopName: shop.name,
      stripeAccountId: null,
      connected: false,
      payoutsEnabled: false,
      accessMode: 'not_connected' as const,
      accessMessage: 'Connect Stripe first to receive and review tax documents.',
      taxProfile: null,
      documents: [],
    };
  }

  if (shop.stripeAccountId.startsWith('acct_mock_') || !env.STRIPE_SECRET_KEY) {
    return {
      shopId: shop.id,
      shopName: shop.name,
      stripeAccountId: shop.stripeAccountId,
      connected: shop.stripeConnected,
      payoutsEnabled: shop.stripePayoutsEnabled,
      accessMode: 'mock' as const,
      accessMessage: 'Stripe tax documents are unavailable in this environment until a live Stripe account is connected.',
      taxProfile: null,
      documents: buildTaxDocuments({
        country: shop.country,
        startDate: shop.createdAt,
      }),
    };
  }

  try {
    const stripe = await getStripeClient();
    const account = await stripe.accounts.retrieve(shop.stripeAccountId);

    return {
      shopId: shop.id,
      shopName: shop.name,
      stripeAccountId: shop.stripeAccountId,
      connected: shop.stripeConnected,
      payoutsEnabled: shop.stripePayoutsEnabled,
      accessMode: 'stripe_express_dashboard' as const,
      accessMessage: 'Stripe hosts filed tax documents in the connected account dashboard.',
      taxProfile: mapStripeTaxProfile(account),
      documents: buildTaxDocuments({
        country: account.country ?? shop.country,
        startDate: account.created ? new Date(account.created * 1000) : shop.createdAt,
      }),
    };
  } catch (err: any) {
    throw new AppError(502, ErrorCode.INTERNAL_ERROR, `Stripe tax documents error: ${err.message}`);
  }
}

export async function createShopTaxDocumentsAccessLink(shopId: string) {
  const [shop] = await db
    .select({
      id: shops.id,
      stripeAccountId: shops.stripeAccountId,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  }

  if (!shop.stripeAccountId) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Connect Stripe first to access tax documents');
  }

  if (shop.stripeAccountId.startsWith('acct_mock_') || !env.STRIPE_SECRET_KEY) {
    return {
      url: null,
      accessMode: 'mock' as const,
      message: 'Stripe tax documents are unavailable in this environment until a live Stripe account is connected.',
    };
  }

  try {
    const url = await createExpressDashboardLoginLink(shop.stripeAccountId);
    return {
      url,
      accessMode: 'stripe_express_dashboard' as const,
      message: 'Open this link to review tax documents in Stripe.',
    };
  } catch (err: any) {
    throw new AppError(502, ErrorCode.INTERNAL_ERROR, `Stripe login link error: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────
// STRIPE CONNECT — DISCONNECT ACCOUNT
// ──────────────────────────────────────────────────────────

export async function disconnectStripe(shopId: string) {
  const [shop] = await db
    .select({ stripeAccountId: shops.stripeAccountId })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  if (!shop.stripeAccountId) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'No Stripe account connected');
  }

  const stripeKey = env.STRIPE_SECRET_KEY;

  // If it's a real (non-mock) account and Stripe is configured, delete on Stripe side
  if (stripeKey && !shop.stripeAccountId.startsWith('acct_mock_')) {
    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(stripeKey);
      await stripe.accounts.del(shop.stripeAccountId);
    } catch (err: any) {
      // Log but don't block — we still clear our DB
      console.warn('[Stripe] Failed to delete account on Stripe:', err?.message);
    }
  }

  // Clear all Stripe fields in our DB
  await db
    .update(shops)
    .set({
      stripeAccountId: null,
      stripeConnected: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId));

  return { disconnected: true };
}

// ──────────────────────────────────────────────────────────
// UPDATE PROTECTION ENABLED
// ──────────────────────────────────────────────────────────

export async function updateProtectionEnabled(shopId: string, enabled: boolean) {
  const [updated] = await db
    .update(shops)
    .set({
      protectionEnabled: enabled,
      updatedAt: new Date(),
    })
    .where(eq(shops.id, shopId))
    .returning({
      id: shops.id,
      protectionEnabled: shops.protectionEnabled,
    });

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shop not found');
  return updated;
}
