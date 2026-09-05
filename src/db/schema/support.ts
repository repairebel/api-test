import { pgTable, uuid, varchar, text, timestamp, pgEnum, boolean } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { adminUsers } from './admin-users.js';

export const supportMessageRoleEnum = pgEnum('support_message_role', ['user', 'assistant']);
export const supportConversationStatusEnum = pgEnum('support_conversation_status', ['waiting', 'active', 'closed']);
export const supportTicketStatusEnum = pgEnum('support_ticket_status', ['open', 'in_review', 'closed']);

export const supportConversations = pgTable('support_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 255 }),
  category: varchar('category', { length: 100 }),
  description: text('description'),
  status: supportConversationStatusEnum('status').notNull().default('waiting'),
  ticketStatus: supportTicketStatusEnum('ticket_status').notNull().default('open'),
  agentId: uuid('agent_id').references(() => adminUsers.id, { onDelete: 'set null' }),
  agentName: varchar('agent_name', { length: 255 }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const supportMessages = pgTable('support_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => supportConversations.id, { onDelete: 'cascade' }),
  role: supportMessageRoleEnum('role').notNull(),
  content: text('content').notNull(), // for text messages, or fallback text
  type: varchar('type', { length: 20 }).notNull().default('text'), // 'text', 'image', 'video'
  mediaUrl: text('media_url'),
  senderName: varchar('sender_name', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const supportAgentStatus = pgTable('support_agent_status', {
  adminUserId: uuid('admin_user_id').primaryKey().references(() => adminUsers.id, { onDelete: 'cascade' }),
  isAvailable: boolean('is_available').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
