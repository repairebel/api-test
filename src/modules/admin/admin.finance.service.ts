import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { jobs, payouts } from '../../db/schema/index.js';

export async function getFinanceSummary() {
  const [[jobStats], [payoutStats]] = await Promise.all([
    db
      .select({
        totalRevenueCents: sql<number>`COALESCE(SUM(${jobs.priceCents}), 0)`,
        totalPlatformFeesCents: sql<number>`COALESCE(SUM(${jobs.platformFeeCents}), 0)`,
        totalJobsCompleted: sql<number>`COUNT(*) FILTER (WHERE ${jobs.status} = 'COMPLETED')`,
        totalRefundedCents: sql<number>`COALESCE(SUM(CASE WHEN ${jobs.paymentStatus} = 'REFUNDED' THEN ${jobs.priceCents} ELSE 0 END), 0)`,
      })
      .from(jobs),
    db
      .select({
        totalPayoutsCents: sql<number>`COALESCE(SUM(${payouts.amountCents}), 0)`,
        pendingPayoutsCents: sql<number>`COALESCE(SUM(CASE WHEN ${payouts.status} = 'PENDING' THEN ${payouts.amountCents} ELSE 0 END), 0)`,
        completedPayoutsCents: sql<number>`COALESCE(SUM(CASE WHEN ${payouts.status} = 'COMPLETED' THEN ${payouts.amountCents} ELSE 0 END), 0)`,
      })
      .from(payouts),
  ]);

  return { ...jobStats, ...payoutStats };
}

export async function getMonthlyRevenue() {
  const rows = await db.execute(sql`
    SELECT
      TO_CHAR(DATE_TRUNC('month', ${jobs.createdAt}), 'YYYY-MM') AS month,
      COALESCE(SUM(${jobs.priceCents}), 0)::int AS "revenueCents",
      COALESCE(SUM(${jobs.platformFeeCents}), 0)::int AS "platformFeeCents",
      COUNT(*)::int AS "jobCount"
    FROM ${jobs}
    WHERE ${jobs.createdAt} >= NOW() - INTERVAL '12 months'
    GROUP BY DATE_TRUNC('month', ${jobs.createdAt})
    ORDER BY DATE_TRUNC('month', ${jobs.createdAt}) ASC
  `);
  return rows.rows;
}

export async function getRefundTrend() {
  const rows = await db.execute(sql`
    SELECT
      TO_CHAR(DATE_TRUNC('month', ${jobs.updatedAt}), 'YYYY-MM') AS month,
      COUNT(*)::int AS "refundCount",
      COALESCE(SUM(${jobs.priceCents}), 0)::int AS "refundedCents"
    FROM ${jobs}
    WHERE ${jobs.paymentStatus} = 'REFUNDED'
      AND ${jobs.updatedAt} >= NOW() - INTERVAL '12 months'
    GROUP BY DATE_TRUNC('month', ${jobs.updatedAt})
    ORDER BY DATE_TRUNC('month', ${jobs.updatedAt}) ASC
  `);
  return rows.rows;
}
