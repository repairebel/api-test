import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users, shops, memberships, pushTokens } from '../../db/schema/index.js';
import { createNotification } from '../notifications/notifications.service.js';
import { getIO } from '../../lib/socket.js';
import { sendPushToUser } from '../../lib/push.js';
import { sendAdminBroadcastEmail } from '../../lib/email.js';

type TargetAudience = 'all_customers' | 'all_shops' | 'specific_customer' | 'specific_shop';
type EmailTargetAudience =
  | 'all_customers'
  | 'all_shops'
  | 'specific_customer'
  | 'specific_shop'
  | 'specific_user'
  | 'custom_email';

interface SendNotificationInput {
  target: TargetAudience;
  userId?: string;   // required when target is specific_customer
  shopId?: string;    // required when target is specific_shop
  title: string;
  body: string;
  category?: string;
}

interface SendEmailInput {
  target: EmailTargetAudience;
  userId?: string;
  shopId?: string;
  email?: string;
  title: string;
  body: string;
  category?: string;
}

/**
 * Admin: send a custom notification to a specific audience.
 * Creates DB notifications, emits socket events, and sends push notifications.
 */
export async function adminSendNotification(input: SendNotificationInput): Promise<{ sentTo: number }> {
  const { target, title, body, category = 'system' } = input;
  let userIds: string[] = [];
  let targetType: 'CUSTOMER' | 'STORE' = 'CUSTOMER';
  let socketRoom: string | null = null;

  switch (target) {
    case 'all_customers': {
      targetType = 'CUSTOMER';
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.userType, 'CUSTOMER'), eq(users.status, 'ACTIVE')));
      userIds = rows.map((r) => r.id);
      break;
    }

    case 'all_shops': {
      targetType = 'STORE';
      // Get all active shop owners via memberships
      const rows = await db
        .select({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.role, 'OWNER'), eq(users.status, 'ACTIVE')));
      userIds = [...new Set(rows.map((r) => r.userId))];
      break;
    }

    case 'specific_customer': {
      if (!input.userId) throw new Error('userId is required for specific_customer');
      targetType = 'CUSTOMER';
      userIds = [input.userId];
      break;
    }

    case 'specific_shop': {
      if (!input.shopId) throw new Error('shopId is required for specific_shop');
      targetType = 'STORE';
      // Get shop owner user ID
      const rows = await db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.shopId, input.shopId), eq(memberships.role, 'OWNER')))
        .limit(1);
      if (rows.length === 0) throw new Error('Shop not found or has no owner');
      userIds = [rows[0].userId];
      socketRoom = `shop:${input.shopId}`;
      break;
    }
  }

  if (userIds.length === 0) return { sentTo: 0 };

  const io = getIO();
  const appType = targetType === 'STORE' ? 'STORE' : 'CUSTOMER';

  // Process in parallel batches of 100
  const batchSize = 100;
  for (let i = 0; i < userIds.length; i += batchSize) {
    const batch = userIds.slice(i, i + batchSize);

    await Promise.allSettled(
      batch.map(async (uid) => {
        // 1. Persist notification
        try {
          await createNotification({
            userId: uid,
            targetType,
            category: category as any,
            title,
            body,
            data: { fromAdmin: true },
          });
        } catch (err) {
          console.error(`Failed to persist notification for user ${uid}:`, err);
        }

        // 2. Emit socket event
        const room = targetType === 'STORE'
          ? (socketRoom ?? undefined)
          : `customer:${uid}`;
        if (room) {
          io.to(room).emit('notification:new', { category, title, body });
        }

        // 3. Send push notification
        try {
          await sendPushToUser(uid, appType, { title, body, data: { fromAdmin: true } });
        } catch (err) {
          console.error(`Failed to push to user ${uid}:`, err);
        }
      }),
    );
  }

  // For all_shops broadcast via socket to each shop room
  if (target === 'all_shops') {
    // Also get all shop IDs to emit to shop rooms
    const allShops = await db.select({ id: shops.id }).from(shops);
    for (const shop of allShops) {
      io.to(`shop:${shop.id}`).emit('notification:new', { category, title, body });
    }
  }

  return { sentTo: userIds.length };
}

export async function adminSendEmail(input: SendEmailInput): Promise<{ sentTo: number }> {
  const { target, title, body, category } = input;
  let recipientEmails: string[] = [];

  switch (target) {
    case 'all_customers': {
      const rows = await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.userType, 'CUSTOMER'), eq(users.status, 'ACTIVE')));
      recipientEmails = rows.map((r) => r.email);
      break;
    }

    case 'all_shops': {
      const rows = await db
        .select({ email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.role, 'OWNER'), eq(users.status, 'ACTIVE')));
      recipientEmails = [...new Set(rows.map((r) => r.email))];
      break;
    }

    case 'specific_customer': {
      if (!input.userId) throw new Error('userId is required for specific_customer');
      const [row] = await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.id, input.userId), eq(users.userType, 'CUSTOMER')))
        .limit(1);
      if (!row?.email) throw new Error('Customer not found');
      recipientEmails = [row.email];
      break;
    }

    case 'specific_user': {
      if (!input.userId) throw new Error('userId is required for specific_user');
      const [row] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!row?.email) throw new Error('User not found');
      recipientEmails = [row.email];
      break;
    }

    case 'specific_shop': {
      if (!input.shopId) throw new Error('shopId is required for specific_shop');
      const rows = await db
        .select({ email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.shopId, input.shopId), eq(memberships.role, 'OWNER')))
        .limit(5);
      recipientEmails = rows.map((r) => r.email);
      break;
    }

    case 'custom_email': {
      if (!input.email) throw new Error('email is required for custom_email');
      recipientEmails = [input.email.trim()];
      break;
    }
  }

  const uniqueEmails = [...new Set(recipientEmails.filter(Boolean))];
  if (uniqueEmails.length === 0) return { sentTo: 0 };

  await Promise.allSettled(
    uniqueEmails.map((to) =>
      sendAdminBroadcastEmail(to, {
        title,
        body,
        category,
      }),
    ),
  );

  return { sentTo: uniqueEmails.length };
}

/**
 * Search users for the admin notification target picker.
 * Returns a lightweight list of users matching the query.
 */
export async function searchUsersForNotification(
  search: string,
  userType: 'CUSTOMER' | 'SHOP_OWNER',
  limit = 20,
) {
  const { ilike, or } = await import('drizzle-orm');

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
    })
    .from(users)
    .where(
      and(
        eq(users.userType, userType),
        eq(users.status, 'ACTIVE'),
        or(
          ilike(users.email, `%${search}%`),
          ilike(users.fullName, `%${search}%`),
          ilike(users.phone, `%${search}%`),
        ),
      ),
    )
    .limit(limit);

  return rows;
}

/**
 * Search shops for the admin notification target picker.
 */
export async function searchShopsForNotification(search: string, limit = 20) {
  const { ilike, or } = await import('drizzle-orm');

  const rows = await db
    .select({
      id: shops.id,
      name: shops.name,
      city: shops.city,
    })
    .from(shops)
    .leftJoin(memberships, and(eq(memberships.shopId, shops.id), eq(memberships.role, 'OWNER')))
    .leftJoin(users, eq(users.id, memberships.userId))
    .where(
      or(
        ilike(shops.name, `%${search}%`),
        ilike(shops.city, `%${search}%`),
        ilike(users.fullName, `%${search}%`),
        ilike(users.email, `%${search}%`),
      ),
    )
    .groupBy(shops.id, shops.name, shops.city)
    .limit(limit);

  return rows;
}
