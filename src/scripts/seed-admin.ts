/**
 * Seed script: creates the initial super_admin user.
 *
 * Usage:
 *   npx tsx src/scripts/seed-admin.ts
 *
 * Uses the same DATABASE_URL from .env.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { hashPassword } from '../lib/password.js';
import { users } from '../db/schema/users.js';
import { adminUsers } from '../db/schema/admin-users.js';
import { eq, and } from 'drizzle-orm';
import { getPgConnectionConfig } from '../lib/postgres-config.js';

const { Pool } = pg;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim() || 'admin@repairrebel.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim() || 'Admin123!';
const ADMIN_NAME = process.env.ADMIN_NAME?.trim() || 'Super Admin';

async function main() {
  const pool = new Pool(getPgConnectionConfig(process.env.DATABASE_URL || ''));
  const db = drizzle(pool);

  console.log('🔧 Seeding initial admin user...');

  const [existingAdminUserRow] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .limit(1);

  if (existingAdminUserRow) {
    console.log('✅ Admin user already exists. Skipping.');
    await pool.end();
    process.exit(0);
  }

  const [existingAdminAccount] = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
    })
    .from(users)
    .where(eq(users.userType, 'ADMIN'))
    .limit(1);

  if (existingAdminAccount) {
    await db.insert(adminUsers).values({
      userId: existingAdminAccount.id,
      name: existingAdminAccount.fullName || existingAdminAccount.email || ADMIN_NAME,
      role: 'super_admin',
      status: 'active',
    });

    console.log('✅ admin_users row created for existing ADMIN account.');
    await pool.end();
    process.exit(0);
  }

  // Check if admin user already exists
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, ADMIN_EMAIL), eq(users.userType, 'ADMIN')))
    .limit(1);

  if (existing) {
    await db.insert(adminUsers).values({
      userId: existing.id,
      name: ADMIN_NAME,
      role: 'super_admin',
      status: 'active',
    });
    console.log('✅ admin_users row created for existing user.');
  } else {
    // Create the user
    const passwordHash = await hashPassword(ADMIN_PASSWORD);
    const [newUser] = await db
      .insert(users)
      .values({
        email: ADMIN_EMAIL,
        passwordHash,
        fullName: ADMIN_NAME,
        userType: 'ADMIN',
      })
      .returning();

    // Create admin_users entry
    await db.insert(adminUsers).values({
      userId: newUser.id,
      name: ADMIN_NAME,
      role: 'super_admin',
      status: 'active',
    });

    console.log(`✅ Admin user created:`);
    console.log(`   Email:    ${ADMIN_EMAIL}`);
    console.log(`   Password: ${ADMIN_PASSWORD}`);
    console.log(`   Role:     super_admin`);
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
