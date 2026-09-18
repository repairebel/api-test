import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orderTips, shops } from '../../db/schema/index.js';
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
    eq(orderTips.status, 'COMPLETED'),
    gte(orderTips.completedAt, selected.start),
    lte(orderTips.completedAt, selected.end),
  );

  const [[summary], byStore, recent] = await Promise.all([
    db.select({
      totalCents: sql<number>`COALESCE(SUM(${orderTips.amountCents}), 0)::int`,
      tipCount: sql<number>`COUNT(*)::int`,
      averageCents: sql<number>`COALESCE(AVG(${orderTips.amountCents}), 0)::int`,
      storesTipped: sql<number>`COUNT(DISTINCT ${orderTips.shopId})::int`,
    }).from(orderTips).where(where),
    db.select({
      shopId: orderTips.shopId,
      shopName: shops.name,
      totalCents: sql<number>`COALESCE(SUM(${orderTips.amountCents}), 0)::int`,
      tipCount: sql<number>`COUNT(*)::int`,
      averageCents: sql<number>`COALESCE(AVG(${orderTips.amountCents}), 0)::int`,
      lastTipAt: sql<Date>`MAX(${orderTips.completedAt})`,
    }).from(orderTips).innerJoin(shops, eq(shops.id, orderTips.shopId)).where(where)
      .groupBy(orderTips.shopId, shops.name).orderBy(desc(sql`SUM(${orderTips.amountCents})`)),
    db.select({
      id: orderTips.id,
      shopId: orderTips.shopId,
      shopName: shops.name,
      jobId: orderTips.jobId,
      amountCents: orderTips.amountCents,
      completedAt: orderTips.completedAt,
    }).from(orderTips).innerJoin(shops, eq(shops.id, orderTips.shopId)).where(where)
      .orderBy(desc(orderTips.completedAt)).limit(50),
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
    FROM order_tips
    WHERE status = 'COMPLETED'
      AND completed_at >= ${selected.start}
      AND completed_at <= ${selected.end}
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
