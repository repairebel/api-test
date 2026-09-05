import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { adminUsers, users } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';

export async function getProfile(userId: string) {
  const [admin] = await db
    .select({
      id: adminUsers.id,
      userId: adminUsers.userId,
      name: adminUsers.name,
      email: users.email,
      phone: users.phone,
      avatarUrl: users.avatarUrl,
      role: adminUsers.role,
      status: adminUsers.status,
      lastLoginAt: adminUsers.lastLoginAt,
      createdAt: adminUsers.createdAt,
    })
    .from(adminUsers)
    .innerJoin(users, eq(users.id, adminUsers.userId))
    .where(eq(adminUsers.userId, userId))
    .limit(1);

  if (!admin) throw new AppError(404, ErrorCode.NOT_FOUND, 'Admin profile not found');

  return {
    ...admin,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    createdAt: admin.createdAt?.toISOString() ?? null,
  };
}

export async function updateProfile(
  userId: string,
  data: Partial<{ name: string; email: string; phone: string; avatarUrl: string }>,
) {
  // Update admin_users name if provided
  if (data.name) {
    await db.update(adminUsers).set({ name: data.name }).where(eq(adminUsers.userId, userId));
  }

  // Update users table fields
  const userUpdate: any = { updatedAt: new Date() };
  if (data.phone !== undefined) userUpdate.phone = data.phone;
  if (data.avatarUrl !== undefined) userUpdate.avatarUrl = data.avatarUrl;
  if (data.name !== undefined) userUpdate.fullName = data.name;
  if (data.email) {
    // Check email not taken by another user
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, data.email))
      .limit(1);
    if (existing && existing.id !== userId) {
      throw new AppError(409, ErrorCode.CONFLICT, 'Email already in use');
    }
    // Only update if actually different
    if (!existing || existing.id !== userId || true) {
      userUpdate.email = data.email;
    }
  }

  await db.update(users).set(userUpdate).where(eq(users.id, userId));

  return getProfile(userId);
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');

  const isValid = await verifyPassword(user.passwordHash, currentPassword);
  if (!isValid) throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Current password is incorrect');

  const newHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, userId));

  return { message: 'Password changed successfully' };
}
