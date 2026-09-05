import { pgTable, uuid, varchar, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { shops } from './shops.js';

export const onboardingSubmissions = pgTable('onboarding_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' })
    .unique(),
  ownerFirstName: varchar('owner_first_name', { length: 100 }).notNull(),
  ownerLastName: varchar('owner_last_name', { length: 100 }).notNull(),
  ownerDob: varchar('owner_dob', { length: 20 }).notNull(),
  llcDocumentUrls: jsonb('llc_document_urls').$type<string[]>().default([]),
  incorporationDocUrl: varchar('incorporation_doc_url', { length: 1000 }),
  businessLicenseUrl: varchar('business_license_url', { length: 1000 }),
  idDocumentUrl: varchar('id_document_url', { length: 1000 }).notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
