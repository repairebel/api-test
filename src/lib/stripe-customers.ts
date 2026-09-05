import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { AppError, ErrorCode } from '../plugins/error-handler.plugin.js';

function isMissingStripeCustomerError(error: any) {
  const message = String(error?.message ?? '');
  return error?.code === 'resource_missing' && message.includes('No such customer');
}

export async function ensureStripeCustomerForUser(stripe: any, userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      stripeCustomerId: users.stripeCustomerId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');
  }

  if (user.stripeCustomerId) {
    try {
      const customer = await stripe.customers.retrieve(user.stripeCustomerId);
      if (!customer.deleted) {
        return customer.id;
      }
    } catch (error: any) {
      if (!isMissingStripeCustomerError(error)) {
        throw error;
      }
    }
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.fullName ?? undefined,
    metadata: { userId },
  });

  await db
    .update(users)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(users.id, userId));

  return customer.id;
}
