import { redis } from './redis.js';

const PRESENCE_TTL = 60; // seconds

/** Mark a shop as online. Called on every heartbeat. */
export async function setShopOnline(shopId: string): Promise<void> {
  await redis.set(`presence:shop:${shopId}`, 'online', 'EX', PRESENCE_TTL);
}

/** Mark a customer as online. */
export async function setCustomerOnline(customerId: string): Promise<void> {
  await redis.set(`presence:customer:${customerId}`, 'online', 'EX', PRESENCE_TTL);
}

/** Check if a shop is currently online (has a live socket connection). */
export async function isShopOnline(shopId: string): Promise<boolean> {
  const val = await redis.get(`presence:shop:${shopId}`);
  return val === 'online';
}

/** Check if a customer is currently online. */
export async function isCustomerOnline(customerId: string): Promise<boolean> {
  const val = await redis.get(`presence:customer:${customerId}`);
  return val === 'online';
}

/** Remove presence (e.g. on explicit disconnect). */
export async function removeShopPresence(shopId: string): Promise<void> {
  await redis.del(`presence:shop:${shopId}`);
}

export async function removeCustomerPresence(customerId: string): Promise<void> {
  await redis.del(`presence:customer:${customerId}`);
}
