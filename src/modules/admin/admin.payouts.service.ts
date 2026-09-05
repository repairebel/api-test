import { eq, and, or, ilike, desc, count, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { payouts, shops, jobs, memberships, users } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { sendPayoutCompletedEmail } from '../../lib/email.js';

interface ListPayoutsQuery {
  page?: number;
  limit?: number;
  status?: string;
  shopId?: string;
}

export async function listPayouts(query: ListPayoutsQuery) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (query.status) conditions.push(eq(payouts.status, query.status as any));
  if (query.shopId) conditions.push(eq(payouts.shopId, query.shopId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: payouts.id,
        shopId: payouts.shopId,
        shopName: shops.name,
        jobId: payouts.jobId,
        amountCents: payouts.amountCents,
        platformFeeCents: payouts.platformFeeCents,
        netAmountCents: payouts.netAmountCents,
        stripePayoutId: payouts.stripePayoutId,
        stripeTransferId: payouts.stripeTransferId,
        status: payouts.status,
        createdAt: payouts.createdAt,
        completedAt: payouts.completedAt,
      })
      .from(payouts)
      .leftJoin(shops, eq(shops.id, payouts.shopId))
      .where(where)
      .orderBy(desc(payouts.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(payouts).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function getPayoutById(payoutId: string) {
  const [payout] = await db
    .select({
      id: payouts.id,
      shopId: payouts.shopId,
      shopName: shops.name,
      jobId: payouts.jobId,
      amountCents: payouts.amountCents,
      platformFeeCents: payouts.platformFeeCents,
      netAmountCents: payouts.netAmountCents,
      stripePayoutId: payouts.stripePayoutId,
      stripeTransferId: payouts.stripeTransferId,
      status: payouts.status,
      createdAt: payouts.createdAt,
      completedAt: payouts.completedAt,
    })
    .from(payouts)
    .leftJoin(shops, eq(shops.id, payouts.shopId))
    .where(eq(payouts.id, payoutId))
    .limit(1);

  if (!payout) throw new AppError(404, ErrorCode.NOT_FOUND, 'Payout not found');

  return {
    ...payout,
    createdAt: payout.createdAt?.toISOString() ?? null,
    completedAt: payout.completedAt?.toISOString() ?? null,
  };
}

export async function markPayoutCompleted(payoutId: string) {
  const [payout] = await db
    .select({ id: payouts.id, status: payouts.status, shopId: payouts.shopId, netAmountCents: payouts.netAmountCents, platformFeeCents: payouts.platformFeeCents })
    .from(payouts)
    .where(eq(payouts.id, payoutId))
    .limit(1);

  if (!payout) throw new AppError(404, ErrorCode.NOT_FOUND, 'Payout not found');
  if (payout.status === 'COMPLETED') throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Payout already completed');

  await db
    .update(payouts)
    .set({ status: 'COMPLETED', completedAt: new Date() })
    .where(eq(payouts.id, payoutId));

  const [shopRow] = await db
    .select({ name: shops.name })
    .from(shops)
    .where(eq(shops.id, payout.shopId))
    .limit(1);

  const owners = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.shopId, payout.shopId), eq(memberships.role, 'OWNER')));

  await Promise.allSettled(
    owners
      .filter((owner) => !!owner.email)
      .map((owner) =>
        sendPayoutCompletedEmail(owner.email, {
          shopName: shopRow?.name ?? 'Your shop',
          payoutId: payout.id,
          netAmountCents: payout.netAmountCents,
          platformFeeCents: payout.platformFeeCents,
        }),
      ),
  );

  return { message: 'Payout marked as completed', payoutId };
}
