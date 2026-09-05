import { db } from '../../db/client.js';
import { auditLogs, adminUsers } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';

type AuditActionType =
  | 'auth' | 'order' | 'store' | 'user' | 'finance'
  | 'settings' | 'admin' | 'dispute' | 'review' | 'onboarding';

/**
 * Write an audit log entry. Call from any admin mutating endpoint.
 */
export async function logAudit(
  adminUserId: string,
  action: string,
  actionType: AuditActionType,
  target?: string,
  details?: string,
): Promise<void> {
  // Resolve admin name + role
  const [admin] = await db
    .select({ name: adminUsers.name, role: adminUsers.role })
    .from(adminUsers)
    .where(eq(adminUsers.userId, adminUserId))
    .limit(1);

  await db.insert(auditLogs).values({
    adminUserId,
    performedBy: admin?.name ?? 'Unknown',
    performedByRole: admin?.role ?? 'admin',
    action,
    actionType,
    target: target ?? null,
    details: details ?? null,
  });
}
