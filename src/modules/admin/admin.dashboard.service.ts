import { eq, sql, and, count, sum } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  users, shops, requests, jobs, disputes, payouts,
  protectionClaims, onboardingSubmissions, jobStatusEvents,
  reviews, reviewReports,
} from '../../db/schema/index.js';

export async function getDashboardStats() {
  const [[userStats], [shopStats], [requestStats], [jobStats], [disputeStats], [payoutStats], [onboardingStats], [claimsStats]] =
    await Promise.all([
      db.select({
        totalUsers: count(),
        totalCustomers: count(sql`CASE WHEN ${users.userType} = 'CUSTOMER' THEN 1 END`),
        totalShopOwners: count(sql`CASE WHEN ${users.userType} = 'SHOP_OWNER' THEN 1 END`),
      }).from(users),
      db.select({
        totalShops: count(),
        approvedShops: count(sql`CASE WHEN ${shops.onboardingStatus} = 'APPROVED' THEN 1 END`),
        pendingShops: count(sql`CASE WHEN ${shops.onboardingStatus} = 'IN_REVIEW' THEN 1 END`),
      }).from(shops),
      db.select({
        totalRequests: count(),
        openRequests: count(sql`CASE WHEN ${requests.status} = 'LIVE' THEN 1 END`),
      }).from(requests),
      db.select({
        activeJobs: count(sql`CASE WHEN ${jobs.status} NOT IN ('COMPLETED', 'CANCELLED') THEN 1 END`),
        completedJobs: count(sql`CASE WHEN ${jobs.status} = 'COMPLETED' THEN 1 END`),
      }).from(jobs),
      db.select({
        openDisputes: count(sql`CASE WHEN ${disputes.status} IN ('OPEN', 'UNDER_REVIEW') THEN 1 END`),
      }).from(disputes),
      db.select({
        totalRevenueCents: sum(payouts.amountCents),
      }).from(payouts),
      db.select({
        pendingOnboarding: count(sql`CASE WHEN ${shops.onboardingStatus} = 'IN_REVIEW' THEN 1 END`),
      }).from(shops),
      db.select({
        openClaims: count(sql`CASE WHEN ${protectionClaims.status} IN ('OPEN', 'UNDER_REVIEW') THEN 1 END`),
      }).from(protectionClaims),
    ]);

  return {
    totalUsers: Number(userStats.totalUsers ?? 0),
    totalCustomers: Number(userStats.totalCustomers ?? 0),
    totalShopOwners: Number(userStats.totalShopOwners ?? 0),
    totalShops: Number(shopStats.totalShops ?? 0),
    approvedShops: Number(shopStats.approvedShops ?? 0),
    pendingShops: Number(shopStats.pendingShops ?? 0),
    totalRequests: Number(requestStats.totalRequests ?? 0),
    openRequests: Number(requestStats.openRequests ?? 0),
    activeJobs: Number(jobStats.activeJobs ?? 0),
    completedJobs: Number(jobStats.completedJobs ?? 0),
    openDisputes: Number(disputeStats.openDisputes ?? 0),
    totalRevenueCents: Number(payoutStats.totalRevenueCents ?? 0),
    pendingOnboarding: Number(onboardingStats.pendingOnboarding ?? 0),
    openClaims: Number(claimsStats.openClaims ?? 0),
  };
}

export async function getWeeklyRevenue() {
  const result = await db.execute(sql`
    SELECT
      to_char(date_trunc('day', created_at), 'Dy') AS day,
      COALESCE(SUM(amount_cents), 0)::int AS revenue
    FROM payouts
    WHERE created_at >= now() - interval '7 days'
    GROUP BY date_trunc('day', created_at), to_char(date_trunc('day', created_at), 'Dy')
    ORDER BY date_trunc('day', created_at)
  `);
  return result.rows;
}

export async function getJobsByCategory() {
  const result = await db.execute(sql`
    SELECT
      COALESCE(r.issue_type, 'Other') AS category,
      COUNT(*)::int AS jobs
    FROM jobs j
    LEFT JOIN requests r ON r.id = j.request_id
    GROUP BY r.issue_type
    ORDER BY jobs DESC
    LIMIT 10
  `);
  return result.rows;
}

export async function getJobStatusChart() {
  const fills: Record<string, string> = {
    COMPLETED: 'hsl(142, 71%, 45%)',
    REPAIRING: 'hsl(217, 91%, 60%)',
    IN_PROGRESS: 'hsl(217, 91%, 60%)',
    BOOKED: 'hsl(38, 92%, 50%)',
    PENDING: 'hsl(38, 92%, 50%)',
    CANCELLED: 'hsl(0, 84%, 60%)',
    EN_ROUTE: 'hsl(262, 83%, 58%)',
    CHECKED_IN: 'hsl(190, 80%, 50%)',
    READY: 'hsl(142, 50%, 55%)',
    DISPUTED: 'hsl(0, 60%, 50%)',
  };
  const result = await db.execute(sql`
    SELECT status AS name, COUNT(*)::int AS value
    FROM jobs
    GROUP BY status
    ORDER BY value DESC
  `);
  return (result.rows as Array<{ name: string; value: number }>).map((r) => ({
    ...r,
    fill: fills[r.name] ?? 'hsl(200, 50%, 50%)',
  }));
}

export async function getActivityFeed() {
  // Union of recent events across tables
  const result = await db.execute(sql`
    (
      SELECT id::text, 'new_request' AS type,
        concat('New request – ', device_brand, ' ', device_model, ' ', issue_type) AS message,
        created_at AS timestamp
      FROM requests ORDER BY created_at DESC LIMIT 3
    )
    UNION ALL
    (
      SELECT id::text, 'job_completed' AS type,
        concat('Job completed – ', device_brand, ' ', device_model) AS message,
        completed_at AS timestamp
      FROM jobs WHERE status = 'COMPLETED' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 3
    )
    UNION ALL
    (
      SELECT id::text, 'dispute_opened' AS type,
        concat('Dispute opened – ', reason_code, ' for job ', job_id) AS message,
        created_at AS timestamp
      FROM disputes ORDER BY created_at DESC LIMIT 3
    )
    UNION ALL
    (
      SELECT id::text, 'payout_requested' AS type,
        concat('Payout requested – ', amount_cents, ' cents') AS message,
        created_at AS timestamp
      FROM payouts WHERE status = 'PENDING' ORDER BY created_at DESC LIMIT 3
    )
    UNION ALL
    (
      SELECT r.id::text, 'review_reported' AS type,
        concat('Review reported – reason: ', rr.reason) AS message,
        rr.created_at AS timestamp
      FROM review_reports rr
      JOIN reviews r ON rr.review_id = r.id
      ORDER BY rr.created_at DESC LIMIT 2
    )
    ORDER BY timestamp DESC
    LIMIT 20
  `);
  return (result.rows as any[]).map((r, i) => ({
    id: r.id ?? String(i),
    type: r.type,
    message: r.message,
    timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : new Date().toISOString(),
  }));
}
