import { db } from '../db/client.js';
import { memberships } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';

/**
 * Get the owner userId for a shop (via memberships table, role = OWNER).
 */
export async function getShopOwnerUserId(shopId: string): Promise<string | null> {
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.shopId, shopId), eq(memberships.role, 'OWNER')))
    .limit(1);
  return rows[0]?.userId ?? null;
}
