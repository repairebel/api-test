import { getIO } from './socket.js';
import { sendPushToUser, PushPayload } from './push.js';
import { getShopOwnerUserId } from './push-helpers.js';
import { createNotification, CreateNotificationInput } from '../modules/notifications/notifications.service.js';
import { db } from '../db/client.js';
import { customerNotificationPrefs } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

type NotificationCategory = CreateNotificationInput['category'];

interface NotifyShopOptions {
  shopId: string;
  event: string;
  payload: Record<string, unknown>;
  push?: PushPayload;
  /** Persist in notification history */
  persist?: {
    category: NotificationCategory;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  };
}

interface NotifyCustomerOptions {
  customerId: string;
  event: string;
  payload: Record<string, unknown>;
  push?: PushPayload;
  /** Persist in notification history */
  persist?: {
    category: NotificationCategory;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  };
}

interface NotifyAdminOptions {
  adminUserId?: string;
  event: string;
  payload: Record<string, unknown>;
  /** Persist in notification history (requires adminUserId) */
  persist?: {
    category: NotificationCategory;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  };
}

// Map notification category to customer prefs column name
const CATEGORY_TO_PREF: Record<string, string> = {
  offer: 'offers',
  chat: 'messages',
  order: 'orderUpdates',
  dispatch: 'orderUpdates',
  payout: 'payments',
  review: 'reviews',
  system: 'promotions',
};

/**
 * Check if the customer has the relevant notification pref enabled.
 * Returns true if pref is enabled or not set (defaults to enabled).
 */
async function isCustomerPrefEnabled(customerId: string, category: string): Promise<boolean> {
  const prefColumn = CATEGORY_TO_PREF[category];
  if (!prefColumn) return true; // no mapping → always send

  try {
    const rows = await db
      .select()
      .from(customerNotificationPrefs)
      .where(eq(customerNotificationPrefs.userId, customerId))
      .limit(1);

    if (rows.length === 0) return true; // no prefs set → defaults apply (all true except promotions/reviews)
    return (rows[0] as any)[prefColumn] !== false;
  } catch {
    return true; // on error, default to sending
  }
}

/**
 * Emit a socket event to a shop room.
 * If the shop is OFFLINE and a push payload is provided, send a push notification instead.
 * Optionally persists the notification in the database.
 */
export async function notifyShop({ shopId, event, payload, push, persist }: NotifyShopOptions): Promise<void> {
  // Always try to emit socket event, but don't let socket issues block push/persistence.
  try {
    getIO().to(`shop:${shopId}`).emit(event, payload);
  } catch (err) {
    console.error('❌ Failed to emit shop socket event:', err);
  }

  // Resolve owner userId for persistence and push
  const userId = await getShopOwnerUserId(shopId);

  // Persist notification in DB
  if (persist && userId) {
    try {
      await createNotification({
        userId,
        targetType: 'STORE',
        category: persist.category,
        title: persist.title,
        body: persist.body,
        data: persist.data ?? payload,
      });
      // Emit unread count update
      try {
        getIO().to(`shop:${shopId}`).emit('notification:new', {
          category: persist.category,
          title: persist.title,
          body: persist.body,
        });
      } catch (err) {
        console.error('❌ Failed to emit shop notification:new event:', err);
      }
    } catch (err) {
      console.error('❌ Failed to persist shop notification:', err);
    }
  }

  // Always send push so the phone rings even in sleep mode / background
  if (push && userId) {
    await sendPushToUser(userId, 'STORE', push);
  }
}

/**
 * Emit a socket event to a customer room.
 * If the customer is OFFLINE and a push payload is provided, send a push notification.
 * Enforces customer notification preferences before sending push.
 * Optionally persists the notification in the database.
 */
export async function notifyCustomer({ customerId, event, payload, push, persist }: NotifyCustomerOptions): Promise<void> {
  // Always try to emit socket event, but don't let socket issues block push/persistence.
  try {
    getIO().to(`customer:${customerId}`).emit(event, payload);
  } catch (err) {
    console.error('❌ Failed to emit customer socket event:', err);
  }

  // Persist notification in DB
  if (persist) {
    try {
      await createNotification({
        userId: customerId,
        targetType: 'CUSTOMER',
        category: persist.category,
        title: persist.title,
        body: persist.body,
        data: persist.data ?? payload,
      });
      // Emit unread count update
      try {
        getIO().to(`customer:${customerId}`).emit('notification:new', {
          category: persist.category,
          title: persist.title,
          body: persist.body,
        });
      } catch (err) {
        console.error('❌ Failed to emit customer notification:new event:', err);
      }
    } catch (err) {
      console.error('❌ Failed to persist customer notification:', err);
    }
  }

  // Always send push so the phone rings even in sleep mode / background
  if (push) {
    const category = persist?.category ?? 'system';
    const prefEnabled = await isCustomerPrefEnabled(customerId, category);
    if (!prefEnabled) return; // respect customer preferences

    await sendPushToUser(customerId, 'CUSTOMER', push);
  }
}

/**
 * Emit a socket event to the admin room.
 * Optionally persists the notification for a specific admin user.
 */
export async function notifyAdmin({ adminUserId, event, payload, persist }: NotifyAdminOptions): Promise<void> {
  // Emit to all admins in the admin room
  getIO().to('admin').emit(event, payload);

  // Persist notification for specific admin user if provided
  if (persist && adminUserId) {
    try {
      await createNotification({
        userId: adminUserId,
        targetType: 'ADMIN',
        category: persist.category,
        title: persist.title,
        body: persist.body,
        data: persist.data ?? payload,
      });
    } catch (err) {
      console.error('❌ Failed to persist admin notification:', err);
    }
  }
}
