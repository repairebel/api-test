import { eq, and, desc, sql, isNull, count } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  users,
  customerAddresses,
  customerNotificationPrefs,
  supportConversations,
  supportMessages,
  jobs,
  reviews,
  refreshTokens,
} from '../../db/schema/index.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { sendProfileUpdatedEmail } from '../../lib/email.js';
import { ensureStripeCustomerForUser } from '../../lib/stripe-customers.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { env } from '../../config/env.js';
import type {
  UpdateProfileBody,
  ChangePasswordBody,
  ChangeEmailBody,
  CreateAddressBody,
  UpdateAddressBody,
  UpdateNotificationPrefsBody,
  UpdatePrivacyBody,
  SupportChatBody,
} from './customer-settings.schema.js';

// ══════════════════════════════════════════════════════════
// PROFILE
// ══════════════════════════════════════════════════════════

export async function updateProfile(userId: string, data: UpdateProfileBody) {
  const [before] = await db
    .select({ fullName: users.fullName, phone: users.phone, avatarUrl: users.avatarUrl, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!before) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');

  // If phone provided, check uniqueness among CUSTOMER users
  if (data.phone) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.phone, data.phone), eq(users.userType, 'CUSTOMER')))
      .limit(1);
    if (existing.length > 0 && existing[0].id !== userId) {
      throw new AppError(409, ErrorCode.CONFLICT, 'Phone number already in use');
    }
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.fullName !== undefined) updateData.fullName = data.fullName;
  if (data.phone !== undefined) updateData.phone = data.phone || null;
  if (data.avatarUrl !== undefined) updateData.avatarUrl = data.avatarUrl;

  const [updated] = await db
    .update(users)
    .set(updateData)
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
      avatarUrl: users.avatarUrl,
    });

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');

  const changedFields: string[] = [];
  if (data.fullName !== undefined && data.fullName !== before.fullName) changedFields.push('Full name');
  if (data.phone !== undefined && (data.phone || null) !== before.phone) changedFields.push('Phone');
  if (data.avatarUrl !== undefined && data.avatarUrl !== before.avatarUrl) changedFields.push('Avatar');

  if (changedFields.length > 0) {
    sendProfileUpdatedEmail(updated.email, {
      customerName: updated.fullName,
      changedFields,
    }).catch((err) => console.error('Failed to send profile-updated email:', err));
  }

  return updated;
}

export async function changePassword(userId: string, data: ChangePasswordBody) {
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');

  const valid = await verifyPassword(user.passwordHash, data.currentPassword);
  if (!valid) {
    throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Current password is incorrect');
  }

  const newHash = await hashPassword(data.newPassword);

  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, userId));
    // Revoke all refresh tokens — force re-login on all devices
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  });

  return { message: 'Password changed successfully. Please log in again.' };
}

export async function changeEmail(userId: string, newEmail: string, password: string) {
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Incorrect password');
  }

  // Check uniqueness for CUSTOMER
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, newEmail), eq(users.userType, 'CUSTOMER')))
    .limit(1);
  if (existing.length > 0) {
    throw new AppError(409, ErrorCode.CONFLICT, 'Email already in use');
  }

  await db.transaction(async (tx) => {
    await tx.update(users).set({ email: newEmail, updatedAt: new Date() }).where(eq(users.id, userId));
    // Revoke all refresh tokens
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  });

  return { message: 'Email changed successfully. Please log in with your new email.', newEmail };
}

export async function getCustomerStats(userId: string) {
  // Count completed jobs
  const [repairStats] = await db
    .select({
      repairs: count(),
      totalSpentCents: sql<number>`COALESCE(SUM(${jobs.priceCents}), 0)`.as('total_spent_cents'),
    })
    .from(jobs)
    .where(and(eq(jobs.customerId, userId), eq(jobs.status, 'COMPLETED')));

  // Average rating given by this customer
  const [ratingStats] = await db
    .select({
      avgRating: sql<number>`COALESCE(AVG(${reviews.rating}), 0)`.as('avg_rating'),
    })
    .from(reviews)
    .where(eq(reviews.customerId, userId));

  return {
    repairs: Number(repairStats?.repairs ?? 0),
    totalSpentCents: Number(repairStats?.totalSpentCents ?? 0),
    avgRating: Math.round((Number(ratingStats?.avgRating ?? 0)) * 10) / 10,
  };
}

// ══════════════════════════════════════════════════════════
// ADDRESSES
// ══════════════════════════════════════════════════════════

export async function listAddresses(userId: string) {
  return db
    .select()
    .from(customerAddresses)
    .where(eq(customerAddresses.userId, userId))
    .orderBy(desc(customerAddresses.isDefault), desc(customerAddresses.createdAt));
}

export async function createAddress(userId: string, data: CreateAddressBody) {
  return db.transaction(async (tx) => {
    // If setting as default, unset others first
    if (data.isDefault) {
      await tx
        .update(customerAddresses)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(customerAddresses.userId, userId), eq(customerAddresses.isDefault, true)));
    }

    // Check if this is the first address → make default
    const [countResult] = await tx
      .select({ c: count() })
      .from(customerAddresses)
      .where(eq(customerAddresses.userId, userId));
    const isFirst = Number(countResult?.c ?? 0) === 0;

    const [addr] = await tx
      .insert(customerAddresses)
      .values({
        userId,
        label: data.label,
        address: data.address,
        latitude: data.latitude,
        longitude: data.longitude,
        city: data.city ?? null,
        state: data.state ?? null,
        zipCode: data.zipCode ?? null,
        country: data.country ?? null,
        placeId: data.placeId ?? null,
        isDefault: data.isDefault ?? isFirst,
      })
      .returning();

    return addr;
  });
}

export async function updateAddress(userId: string, addressId: string, data: UpdateAddressBody) {
  // Verify ownership
  const [existing] = await db
    .select({ id: customerAddresses.id })
    .from(customerAddresses)
    .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.userId, userId)))
    .limit(1);

  if (!existing) throw new AppError(404, ErrorCode.NOT_FOUND, 'Address not found');

  return db.transaction(async (tx) => {
    if (data.isDefault === true) {
      await tx
        .update(customerAddresses)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(customerAddresses.userId, userId), eq(customerAddresses.isDefault, true)));
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.label !== undefined) updateData.label = data.label;
    if (data.address !== undefined) updateData.address = data.address;
    if (data.latitude !== undefined) updateData.latitude = data.latitude;
    if (data.longitude !== undefined) updateData.longitude = data.longitude;
    if (data.city !== undefined) updateData.city = data.city;
    if (data.state !== undefined) updateData.state = data.state;
    if (data.zipCode !== undefined) updateData.zipCode = data.zipCode;
    if (data.country !== undefined) updateData.country = data.country;
    if (data.placeId !== undefined) updateData.placeId = data.placeId;
    if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;

    const [updated] = await tx
      .update(customerAddresses)
      .set(updateData)
      .where(eq(customerAddresses.id, addressId))
      .returning();

    return updated;
  });
}

export async function deleteAddress(userId: string, addressId: string) {
  const [existing] = await db
    .select({ id: customerAddresses.id, isDefault: customerAddresses.isDefault })
    .from(customerAddresses)
    .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.userId, userId)))
    .limit(1);

  if (!existing) throw new AppError(404, ErrorCode.NOT_FOUND, 'Address not found');

  await db.delete(customerAddresses).where(eq(customerAddresses.id, addressId));

  // If deleted was default, promote most recent
  if (existing.isDefault) {
    const [next] = await db
      .select({ id: customerAddresses.id })
      .from(customerAddresses)
      .where(eq(customerAddresses.userId, userId))
      .orderBy(desc(customerAddresses.createdAt))
      .limit(1);
    if (next) {
      await db
        .update(customerAddresses)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(customerAddresses.id, next.id));
    }
  }

  return { deleted: true };
}

// ══════════════════════════════════════════════════════════
// PAYMENT METHODS (Stripe)
// ══════════════════════════════════════════════════════════

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

export async function createSetupIntent(userId: string) {
  const customerId = await getOrCreateStripeCustomer(userId);
  const stripe = await getStripe();

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
    usage: 'off_session',
  });

  return {
    clientSecret: setupIntent.client_secret,
    setupIntentId: setupIntent.id,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '',
  };
}

export async function confirmSetupAndSave(userId: string, setupIntentId: string) {
  const stripe = await getStripe();
  const customerId = await getOrCreateStripeCustomer(userId);

  const si = await stripe.setupIntents.retrieve(setupIntentId);

  if (si.customer !== customerId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Setup intent does not belong to this customer');
  }

  if (si.status === 'succeeded') {
    return { status: 'succeeded' as const, paymentMethodId: si.payment_method as string };
  }

  if (si.status === 'requires_action') {
    return {
      status: 'requires_action' as const,
      nextActionUrl: si.next_action?.redirect_to_url?.url ?? null,
      message: '3D Secure verification required',
    };
  }

  if (si.last_setup_error) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR,
      si.last_setup_error.message ?? 'Card was declined');
  }

  return { status: si.status as string, message: 'Setup intent is not yet complete' };
}

export async function confirmSetupWithToken(userId: string, setupIntentId: string, cardToken: string) {
  const stripe = await getStripe();
  const customerId = await getOrCreateStripeCustomer(userId);

  // Verify ownership
  let si = await stripe.setupIntents.retrieve(setupIntentId);
  if (si.customer !== customerId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Setup intent does not belong to this customer');
  }

  // If the setup intent is already consumed (not confirmable), create a fresh one
  if (si.status !== 'requires_payment_method' && si.status !== 'requires_confirmation') {
    si = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
    });
  }

  // Create a payment method from the card token (requires secret key)
  const pm = await stripe.paymentMethods.create({
    type: 'card',
    card: { token: cardToken },
  });

  // Confirm the setup intent with the payment method (requires secret key)
  const confirmed = await stripe.setupIntents.confirm(si.id, {
    payment_method: pm.id,
  });

  if (confirmed.status === 'succeeded') {
    return { status: 'succeeded' as const, paymentMethodId: pm.id };
  }

  if (confirmed.status === 'requires_action') {
    // Build the 3DS URL — could be redirect_to_url or use_stripe_sdk
    let nextActionUrl = confirmed.next_action?.redirect_to_url?.url ?? null;
    if (!nextActionUrl && confirmed.next_action?.type === 'use_stripe_sdk') {
      // For use_stripe_sdk flow, build the Stripe-hosted 3DS auth page URL
      nextActionUrl = `https://hooks.stripe.com/redirect/authenticate/${confirmed.id}?client_secret=${confirmed.client_secret}`;
    }
    return {
      status: 'requires_action' as const,
      nextActionUrl,
      clientSecret: confirmed.client_secret,
      setupIntentId: confirmed.id,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? '',
      message: '3D Secure verification required',
    };
  }

  if (confirmed.last_setup_error) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR,
      confirmed.last_setup_error.message ?? 'Card was declined');
  }

  return { status: confirmed.status as string, message: 'Setup could not be completed' };
}

export async function listPaymentMethods(userId: string) {
  const stripe = await getStripe();
  const customerId = await ensureStripeCustomerForUser(stripe, userId);
  const methods = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
  });

  // Get default payment method
  const customer = await stripe.customers.retrieve(customerId);
  const defaultPm = (customer as any).invoice_settings?.default_payment_method ?? null;

  return {
    methods: methods.data.map((m) => ({
      id: m.id,
      brand: m.card?.brand ?? 'unknown',
      last4: m.card?.last4 ?? '????',
      expMonth: m.card?.exp_month ?? 0,
      expYear: m.card?.exp_year ?? 0,
    })),
    defaultId: defaultPm,
  };
}

export async function deletePaymentMethod(userId: string, pmId: string) {
  const stripe = await getStripe();
  const customerId = await ensureStripeCustomerForUser(stripe, userId);

  // Verify ownership
  const pm = await stripe.paymentMethods.retrieve(pmId);
  if (pm.customer !== customerId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Payment method does not belong to you');
  }

  await stripe.paymentMethods.detach(pmId);
  return { deleted: true };
}

export async function setDefaultPaymentMethod(userId: string, pmId: string) {
  const stripe = await getStripe();
  const customerId = await ensureStripeCustomerForUser(stripe, userId);
  const paymentMethod = await stripe.paymentMethods.retrieve(pmId);
  if (paymentMethod.customer !== customerId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Payment method does not belong to you');
  }
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: pmId },
  });

  return { defaultId: pmId };
}

// ══════════════════════════════════════════════════════════
// NOTIFICATION PREFERENCES
// ══════════════════════════════════════════════════════════

export async function getNotificationPrefs(userId: string) {
  const [prefs] = await db
    .select()
    .from(customerNotificationPrefs)
    .where(eq(customerNotificationPrefs.userId, userId))
    .limit(1);

  if (prefs) return prefs;

  // Create defaults if not exists
  const [created] = await db
    .insert(customerNotificationPrefs)
    .values({ userId })
    .returning();
  return created;
}

export async function updateNotificationPrefs(userId: string, data: UpdateNotificationPrefsBody) {
  // Ensure row exists
  await getNotificationPrefs(userId);

  const updateData: Record<string, unknown> = {};
  if (data.offers !== undefined) updateData.offers = data.offers;
  if (data.messages !== undefined) updateData.messages = data.messages;
  if (data.orderUpdates !== undefined) updateData.orderUpdates = data.orderUpdates;
  if (data.payments !== undefined) updateData.payments = data.payments;
  if (data.reviews !== undefined) updateData.reviews = data.reviews;
  if (data.promotions !== undefined) updateData.promotions = data.promotions;

  const [updated] = await db
    .update(customerNotificationPrefs)
    .set(updateData)
    .where(eq(customerNotificationPrefs.userId, userId))
    .returning();

  return updated;
}

// ══════════════════════════════════════════════════════════
// PRIVACY SETTINGS
// ══════════════════════════════════════════════════════════

export async function getPrivacySettings(userId: string) {
  const [user] = await db
    .select({
      shareUsage: users.privacyShareUsage,
      shareLocation: users.privacyShareLocation,
      shareRepairHistory: users.privacyShareRepairHistory,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');
  return user;
}

export async function updatePrivacySettings(userId: string, data: UpdatePrivacyBody) {
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.shareUsage !== undefined) updateData.privacyShareUsage = data.shareUsage;
  if (data.shareLocation !== undefined) updateData.privacyShareLocation = data.shareLocation;
  if (data.shareRepairHistory !== undefined) updateData.privacyShareRepairHistory = data.shareRepairHistory;

  const [updated] = await db
    .update(users)
    .set(updateData)
    .where(eq(users.id, userId))
    .returning({
      shareUsage: users.privacyShareUsage,
      shareLocation: users.privacyShareLocation,
      shareRepairHistory: users.privacyShareRepairHistory,
    });

  if (!updated) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');
  return updated;
}

export async function deleteAccount(userId: string, password: string) {
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, stripeCustomerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Incorrect password');

  // Delete Stripe customer if exists
  if (user.stripeCustomerId && env.STRIPE_SECRET_KEY) {
    try {
      const stripe = await getStripe();
      await stripe.customers.del(user.stripeCustomerId);
    } catch {
      // Don't block account deletion if Stripe fails
    }
  }

  // Cascade delete will handle addresses, notification prefs, support conversations/messages
  await db.delete(users).where(eq(users.id, userId));

  return { deleted: true };
}

export async function exportUserData(userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');

  const addresses = await db.select().from(customerAddresses).where(eq(customerAddresses.userId, userId));

  const userReviews = await db
    .select({ id: reviews.id, rating: reviews.rating, text: reviews.text, createdAt: reviews.createdAt })
    .from(reviews)
    .where(eq(reviews.customerId, userId));

  const userJobs = await db
    .select({ id: jobs.id, status: jobs.status, priceCents: jobs.priceCents, createdAt: jobs.createdAt })
    .from(jobs)
    .where(eq(jobs.customerId, userId));

  return {
    profile: user,
    addresses,
    reviews: userReviews,
    jobs: userJobs,
    exportedAt: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════
// AI SUPPORT CHAT
// ══════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are the RepairRebel AI Support Assistant. RepairRebel is a mobile repair marketplace where customers post repair requests for their devices (phones, tablets, laptops, etc.) and local repair shops send offers.

Your role:
- Help customers with questions about the platform (how to post requests, accept offers, track repairs, payments, disputes, reviews, etc.)
- Provide clear, friendly, and concise answers
- If you don't know something specific about the user's account, suggest they check the relevant section of the app or contact human support at support@repairrebel.com
- Never make up information about specific orders, prices, or account details
- Be empathetic and solution-oriented
- Keep responses under 200 words unless more detail is needed

Platform features you know about:
- Repair requests: Customers post device + issue + photos + price range
- Offers: Shops send offers with price, ETA, parts quality, warranty
- Jobs: After accepting an offer, the job tracks through stages (Booked → Checked-In → In Progress → Ready → Completed)
- Payments: Escrow system — money held until job is completed
- Reviews: Customers can review shops after completion
- Disputes: Can be filed for issues with repairs
- Saved addresses: Used for pickup/delivery
- Payment methods: Cards saved via Stripe for payments`;

export async function chatWithAI(userId: string, data: SupportChatBody) {
  let conversationId = data.conversationId;

  // Create new conversation if needed
  if (!conversationId) {
    const [conv] = await db
      .insert(supportConversations)
      .values({ userId, title: data.message.slice(0, 100) })
      .returning({ id: supportConversations.id });
    conversationId = conv.id;
  } else {
    // Verify ownership
    const [conv] = await db
      .select({ id: supportConversations.id })
      .from(supportConversations)
      .where(and(eq(supportConversations.id, conversationId), eq(supportConversations.userId, userId)))
      .limit(1);
    if (!conv) throw new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found');
  }

  // Save user message
  await db.insert(supportMessages).values({
    conversationId,
    role: 'user',
    content: data.message,
  });

  // Fetch recent conversation history
  const history = await db
    .select({ role: supportMessages.role, content: supportMessages.content })
    .from(supportMessages)
    .where(eq(supportMessages.conversationId, conversationId))
    .orderBy(supportMessages.createdAt)
    .limit(20);

  // Build messages array for OpenAI
  const openaiMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  let aiReply: string;

  if (!env.OPENAI_API_KEY) {
    // Fallback when OpenAI not configured
    aiReply = getOfflineReply(data.message);
  } else {
    try {
      const OpenAI = (await import('openai')).default;
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: openaiMessages,
        max_tokens: 500,
        temperature: 0.7,
      });

      aiReply = completion.choices[0]?.message?.content ?? 'Sorry, I could not process your request. Please try again.';
    } catch (err: any) {
      console.error('[AI Support] OpenAI error:', err?.message);
      aiReply = 'I apologize, but I\'m experiencing technical difficulties. Please try again in a moment or contact support@repairrebel.com for immediate help.';
    }
  }

  // Save assistant reply
  const [savedReply] = await db
    .insert(supportMessages)
    .values({ conversationId, role: 'assistant', content: aiReply })
    .returning({ id: supportMessages.id, createdAt: supportMessages.createdAt });

  // Update conversation timestamp
  await db
    .update(supportConversations)
    .set({ updatedAt: new Date() })
    .where(eq(supportConversations.id, conversationId));

  return {
    conversationId,
    reply: aiReply,
    messageId: savedReply.id,
    createdAt: savedReply.createdAt,
  };
}

function getOfflineReply(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('payment') || lower.includes('refund') || lower.includes('money')) {
    return 'Regarding payments: RepairRebel uses an escrow system where your payment is held securely until your repair is completed. If you have a specific payment issue, please check the job details in your app or file a dispute. For refund requests, the dispute resolution team will review your case. Need more help? Email support@repairrebel.com.';
  }
  if (lower.includes('repair') || lower.includes('request') || lower.includes('fix')) {
    return 'To get your device repaired: 1) Tap the + button to create a repair request. 2) Select your device and issue. 3) Add photos and set your budget. 4) Local shops will send you offers. 5) Compare offers and accept the best one. 6) Track your repair through the job stages. Is there anything specific about the repair process I can help with?';
  }
  if (lower.includes('dispute') || lower.includes('problem') || lower.includes('issue')) {
    return 'Sorry to hear you\'re having issues! You can file a dispute from your completed job details screen. Our team reviews all disputes within 24-48 hours. Common reasons include: incomplete repair, damage to device, or price disagreement. Would you like me to help with something specific?';
  }
  if (lower.includes('review') || lower.includes('rating')) {
    return 'You can leave a review after your repair is completed. Go to the job details and tap "Leave a Review." Your honest feedback helps other customers and the repair shops improve their service. Reviews include a star rating (1-5) and optional text.';
  }
  return 'Thanks for reaching out to RepairRebel Support! I\'m here to help with questions about repair requests, offers, payments, disputes, and more. Could you provide more details about what you need help with? For urgent account issues, email support@repairrebel.com.';
}

export async function getChatHistory(userId: string, conversationId: string) {
  // Verify ownership
  const [conv] = await db
    .select({ id: supportConversations.id, title: supportConversations.title, createdAt: supportConversations.createdAt })
    .from(supportConversations)
    .where(and(eq(supportConversations.id, conversationId), eq(supportConversations.userId, userId)))
    .limit(1);

  if (!conv) throw new AppError(404, ErrorCode.NOT_FOUND, 'Conversation not found');

  const msgs = await db
    .select({
      id: supportMessages.id,
      role: supportMessages.role,
      content: supportMessages.content,
      createdAt: supportMessages.createdAt,
    })
    .from(supportMessages)
    .where(eq(supportMessages.conversationId, conversationId))
    .orderBy(supportMessages.createdAt);

  return { conversation: conv, messages: msgs };
}

export async function listConversations(userId: string) {
  const convs = await db
    .select({
      id: supportConversations.id,
      title: supportConversations.title,
      createdAt: supportConversations.createdAt,
      updatedAt: supportConversations.updatedAt,
    })
    .from(supportConversations)
    .where(eq(supportConversations.userId, userId))
    .orderBy(desc(supportConversations.updatedAt))
    .limit(50);

  return convs;
}
