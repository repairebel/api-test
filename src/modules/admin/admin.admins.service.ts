import { eq, desc, count } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { adminUsers, users } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { hashPassword } from '../../lib/password.js';

export async function listAdmins(query: { page?: number; limit?: number }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: adminUsers.id,
        userId: adminUsers.userId,
        name: adminUsers.name,
        email: users.email,
        role: adminUsers.role,
        status: adminUsers.status,
        lastLoginAt: adminUsers.lastLoginAt,
        createdAt: adminUsers.createdAt,
      })
      .from(adminUsers)
      .innerJoin(users, eq(users.id, adminUsers.userId))
      .orderBy(desc(adminUsers.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(adminUsers),
  ]);

  return {
    data: rows.map((r) => ({
      ...r,
      lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    pagination: { page, pageSize: limit, total: Number(total) },
  };
}

export async function createAdmin(data: {
  email: string;
  password: string;
  name: string;
  role: 'super_admin' | 'admin' | 'moderator';
}) {
  // Check if user with this email exists as ADMIN
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, data.email))
    .limit(1);

  let userId: string;

  if (existing) {
    // Check if already an admin
    const [existingAdmin] = await db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.userId, existing.id))
      .limit(1);
    if (existingAdmin) throw new AppError(409, ErrorCode.CONFLICT, 'Admin already exists for this email');
    userId = existing.id;
  } else {
    // Create new user
    const passwordHash = await hashPassword(data.password);
    const [newUser] = await db
      .insert(users)
      .values({
        email: data.email,
        passwordHash,
        fullName: data.name,
        userType: 'ADMIN',
      })
      .returning();
    userId = newUser.id;
  }

  const [admin] = await db
    .insert(adminUsers)
    .values({
      userId,
      name: data.name,
      role: data.role,
    })
    .returning();

  return {
    ...admin,
    email: data.email,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    createdAt: admin.createdAt?.toISOString() ?? null,
  };
}

export async function updateAdminRole(adminUserId: string, role: 'super_admin' | 'admin' | 'moderator') {
  const [admin] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.id, adminUserId))
    .limit(1);
  if (!admin) throw new AppError(404, ErrorCode.NOT_FOUND, 'Admin not found');

  await db.update(adminUsers).set({ role }).where(eq(adminUsers.id, adminUserId));
  return { message: 'Admin role updated', adminUserId, role };
}

export async function suspendAdmin(adminUserId: string) {
  const [admin] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.id, adminUserId))
    .limit(1);
  if (!admin) throw new AppError(404, ErrorCode.NOT_FOUND, 'Admin not found');

  await db.update(adminUsers).set({ status: 'suspended' }).where(eq(adminUsers.id, adminUserId));
  return { message: 'Admin suspended', adminUserId };
}

export async function activateAdmin(adminUserId: string) {
  const [admin] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.id, adminUserId))
    .limit(1);
  if (!admin) throw new AppError(404, ErrorCode.NOT_FOUND, 'Admin not found');

  await db.update(adminUsers).set({ status: 'active' }).where(eq(adminUsers.id, adminUserId));
  return { message: 'Admin activated', adminUserId };
}

export async function deleteAdmin(adminUserId: string) {
  const [admin] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.id, adminUserId))
    .limit(1);
  if (!admin) throw new AppError(404, ErrorCode.NOT_FOUND, 'Admin not found');

  await db.delete(adminUsers).where(eq(adminUsers.id, adminUserId));
  return { message: 'Admin deleted', adminUserId };
}

export async function updateAdmin(
  adminUserId: string,
  data: { email?: string; password?: string; name?: string; role?: 'super_admin' | 'admin' | 'moderator' },
) {
  // Find admin + user + current email
  const [admin] = await db
    .select({ id: adminUsers.id, userId: adminUsers.userId, currentEmail: users.email })
    .from(adminUsers)
    .innerJoin(users, eq(users.id, adminUsers.userId))
    .where(eq(adminUsers.id, adminUserId))
    .limit(1);
  if (!admin) throw new AppError(404, ErrorCode.NOT_FOUND, 'Admin not found');

  // Update user table fields (email, password)
  const userUpdates: Record<string, any> = {};
  if (data.email && data.email !== admin.currentEmail) {
    // Check email not taken by another user
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, data.email))
      .limit(1);
    if (existing) {
      throw new AppError(409, ErrorCode.CONFLICT, 'Email already in use');
    }
    userUpdates.email = data.email;
  }
  if (data.password) {
    userUpdates.passwordHash = await hashPassword(data.password);
  }
  if (data.name) {
    userUpdates.fullName = data.name;
  }
  if (Object.keys(userUpdates).length > 0) {
    await db.update(users).set(userUpdates).where(eq(users.id, admin.userId));
  }

  // Update admin_users table fields (name, role)
  const adminUpdates: Record<string, any> = {};
  if (data.name) adminUpdates.name = data.name;
  if (data.role) adminUpdates.role = data.role;
  if (Object.keys(adminUpdates).length > 0) {
    await db.update(adminUsers).set(adminUpdates).where(eq(adminUsers.id, adminUserId));
  }

  return { message: 'Admin updated', adminUserId };
}
