import { pgTable, uuid, varchar, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const auditActionTypeEnum = pgEnum('audit_action_type', [
  'auth',
  'order',
  'store',
  'user',
  'finance',
  'settings',
  'admin',
  'dispute',
  'review',
  'onboarding',
]);

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminUserId: uuid('admin_user_id').notNull(),
  performedBy: varchar('performed_by', { length: 255 }).notNull(),
  performedByRole: varchar('performed_by_role', { length: 50 }).notNull(),
  action: text('action').notNull(),
  actionType: auditActionTypeEnum('action_type').notNull(),
  target: varchar('target', { length: 500 }),
  details: text('details'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
