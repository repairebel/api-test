import Expo, { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { db } from '../db/client.js';
import { pushTokens } from '../db/schema/index.js';
import { eq, and, inArray } from 'drizzle-orm';

const expo = new Expo();

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: string | null;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
}

/**
 * Send push notification(s) to a specific user in a specific app.
 * Automatically cleans up invalid tokens.
 */
export async function sendPushToUser(
  userId: string,
  appType: 'STORE' | 'CUSTOMER',
  payload: PushPayload,
): Promise<void> {
  // Fetch all tokens for this user + app
  const tokens = await db
    .select({ id: pushTokens.id, token: pushTokens.token })
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), eq(pushTokens.appType, appType)));

  if (tokens.length === 0) return;

  // Build messages
  const messages: ExpoPushMessage[] = [];
  const validTokenIds: string[] = [];

  for (const t of tokens) {
    if (!Expo.isExpoPushToken(t.token)) {
      console.warn(`⚠️ Invalid Expo push token: ${t.token} — removing`);
      continue;
    }
    validTokenIds.push(t.id);
    messages.push({
      to: t.token,
      sound: payload.sound ?? 'default',
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
      channelId: payload.channelId ?? 'default',
      priority: payload.priority ?? 'high',
    });
  }

  // Remove any invalid tokens we found
  const invalidIds = tokens
    .filter((t) => !validTokenIds.includes(t.id))
    .map((t) => t.id);
  if (invalidIds.length > 0) {
    await db.delete(pushTokens).where(inArray(pushTokens.id, invalidIds));
  }

  if (messages.length === 0) return;

  // Chunk and send
  const chunks = expo.chunkPushNotifications(messages);
  const ticketIdsToClean: string[] = [];

  for (const chunk of chunks) {
    try {
      const tickets: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk);
      // Check for DeviceNotRegistered errors and mark tokens for removal
      tickets.forEach((ticket, idx) => {
        if (ticket.status === 'error') {
          const token = (chunk[idx] as ExpoPushMessage).to as string;
          console.error('❌ Expo push ticket error:', {
            token,
            message: ticket.message,
            details: ticket.details,
          });
        }
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          const badToken = (chunk[idx] as ExpoPushMessage).to as string;
          const match = tokens.find((t) => t.token === badToken);
          if (match) ticketIdsToClean.push(match.id);
        }
      });
    } catch (err) {
      console.error('❌ Error sending push notification chunk:', err);
    }
  }

  // Clean up DeviceNotRegistered tokens
  if (ticketIdsToClean.length > 0) {
    await db.delete(pushTokens).where(inArray(pushTokens.id, ticketIdsToClean));
  }
}
