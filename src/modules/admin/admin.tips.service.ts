import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { payouts, shops } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

function resolveRange(range = '30d', from?: string, to?: string) {
  const end = range === 'custom' && to ? new Date(`${to}T23:59:59.999Z`) : new Date();
  const start = range === 'custom' && from ? new Date(`${from}T00:00:00.000Z`) : new Date();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Dates must use YYYY-MM-DD');
  }
  if (range !== 'custom') {
    const days = range === '7d' ? 7 : range === '90d' ? 90 : range === '1y' ? 365 : 30;
    start.setDate(start.getDate() - days);
  }
  const days = Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
  if (days < 0 || days > 366) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Tip reports must be between one day and one year');
  }
  return { start, end, interval: days <= 31 ? 'day' : days <= 180 ? 'week' : 'month' } as const;
}

export async function getAdminTipReport(input: { range?: string; from?: string; to?: string }) {
  const selected = resolveRange(input.range, input.from, input.to);
  const where = and(
    eq(payouts.status, 'COMPLETED'),
    eq(payouts.payoutMethod, 'tip'),
    sql`COALESCE(${payouts.completedAt}, ${payouts.createdAt}) >= ${selected.start}`,
    sql`COALESCE(${payouts.completedAt}, ${payouts.createdAt}) <= ${selected.end}`,
  );

  const [[summary], byStore, recent] = await Promise.all([
    db.select({
      totalCents: sql<number>`COALESCE(SUM(${payouts.amountCents}), 0)::int`,
      tipCount: sql<number>`COUNT(*)::int`,
      averageCents: sql<number>`COALESCE(AVG(${payouts.amountCents}), 0)::int`,
      storesTipped: sql<number>`COUNT(DISTINCT ${payouts.shopId})::int`,
    }).from(payouts).where(where),
    db.select({
      shopId: payouts.shopId,
      shopName: shops.name,
      totalCents: sql<number>`COALESCE(SUM(${payouts.amountCents}), 0)::int`,
      tipCount: sql<number>`COUNT(*)::int`,
      averageCents: sql<number>`COALESCE(AVG(${payouts.amountCents}), 0)::int`,
      lastTipAt: sql<Date>`MAX(COALESCE(${payouts.completedAt}, ${payouts.createdAt}))`,
    }).from(payouts).innerJoin(shops, eq(shops.id, payouts.shopId)).where(where)
      .groupBy(payouts.shopId, shops.name).orderBy(desc(sql`SUM(${payouts.amountCents})`)),
    db.select({
      id: payouts.id,
      shopId: payouts.shopId,
      shopName: shops.name,
      amountCents: payouts.amountCents,
      completedAt: payouts.completedAt,
    }).from(payouts).innerJoin(shops, eq(shops.id, payouts.shopId)).where(where)
      .orderBy(desc(payouts.completedAt)).limit(50),
  ]);

  const bucket = selected.interval === 'day'
    ? sql`DATE(completed_at)`
    : selected.interval === 'week'
      ? sql`DATE_TRUNC('week', completed_at)::date`
      : sql`DATE_TRUNC('month', completed_at)::date`;
  const trendResult = await db.execute(sql`
    SELECT ${bucket} AS period,
      COALESCE(SUM(amount_cents), 0)::int AS total_cents,
      COUNT(*)::int AS tip_count
    FROM payouts
    WHERE status = 'COMPLETED'
      AND payout_method = 'tip'
      AND COALESCE(completed_at, created_at) >= ${selected.start}
      AND COALESCE(completed_at, created_at) <= ${selected.end}
    GROUP BY ${bucket}
    ORDER BY period ASC
  `);

  return {
    ...summary,
    rangeStart: selected.start.toISOString(),
    rangeEnd: selected.end.toISOString(),
    interval: selected.interval,
    byStore: byStore.map((row) => ({ ...row, lastTipAt: row.lastTipAt?.toISOString() ?? null })),
    trend: (trendResult.rows as any[]).map((row) => ({
      period: row.period,
      totalCents: row.total_cents,
      tipCount: row.tip_count,
    })),
    recent: recent.map((row) => ({ ...row, completedAt: row.completedAt?.toISOString() ?? null })),
  };
}
