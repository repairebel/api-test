import { eq, and, isNull, gt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users, shops, memberships, refreshTokens, passwordResetTokens, adminUsers, loginActivity } from '../../db/schema/index.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import {
  signAccessToken,
  generateRefreshToken,
  hashToken,
  parseDurationMs,
  generateResetToken,
} from '../../lib/tokens.js';
import { redis } from '../../lib/redis.js';
import { env } from '../../config/env.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { sendPasswordResetEmail } from '../../lib/email.js';
import type {
  SignupBody,
  SignupCustomerBody,
  LoginBody,
  ForgotPasswordBody,
  ResetPasswordBody,
} from './auth.schema.js';

// ──────────────────────────────────────────────────────────
// SIGNUP — Shop Owner (creates user + shop + membership)
// ──────────────────────────────────────────────────────────

export async function signup({ email, password, shopName }: SignupBody) {
  // Check unique email for SHOP_OWNER
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, email), eq(users.userType, 'SHOP_OWNER')))
    .limit(1);

  if (existing.length > 0) {
    throw new AppError(409, ErrorCode.CONFLICT, 'A shop owner account with this email already exists');
  }

  const passwordHash = await hashPassword(password);

  // Atomic transaction: user + shop + membership
  const result = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email, passwordHash, userType: 'SHOP_OWNER' })
      .returning({ id: users.id, email: users.email, createdAt: users.createdAt });

    const [shop] = await tx
      .insert(shops)
      .values({ name: shopName })
      .returning({
        id: shops.id,
        name: shops.name,
        onboardingStatus: shops.onboardingStatus,
        stripeConnected: shops.stripeConnected,
      });

    await tx
      .insert(memberships)
      .values({ userId: user.id, shopId: shop.id, role: 'OWNER' });

    return { user, shop };
  });

  // Generate tokens
  const accessToken = signAccessToken({
    sub: result.user.id,
    userType: 'SHOP_OWNER',
    shopId: result.shop.id,
    role: 'OWNER',
    sessionVersion: 0,
  });

  const rawRefreshToken = generateRefreshToken();
  const refreshTokenHash = hashToken(rawRefreshToken);
  const refreshExpiresAt = new Date(
    Date.now() + parseDurationMs(env.JWT_REFRESH_EXPIRES_IN),
  );

  await db.insert(refreshTokens).values({
    userId: result.user.id,
    tokenHash: refreshTokenHash,
    expiresAt: refreshExpiresAt,
  });

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    user: {
      id: result.user.id,
      email: result.user.email,
      userType: 'SHOP_OWNER' as const,
    },
    shop: {
      id: result.shop.id,
      name: result.shop.name,
      onboardingStatus: result.shop.onboardingStatus,
      stripeConnected: result.shop.stripeConnected,
    },
  };
}

// ──────────────────────────────────────────────────────────
// SIGNUP — Customer (creates user only, no shop)
// ──────────────────────────────────────────────────────────

export async function signupCustomer({ name, email, password, phone }: SignupCustomerBody) {
  // Check unique email for CUSTOMER
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, email), eq(users.userType, 'CUSTOMER')))
    .limit(1);

  if (existing.length > 0) {
    throw new AppError(409, ErrorCode.CONFLICT, 'A customer account with this email already exists');
  }

  // Check unique phone (if provided) — scoped to CUSTOMER
  if (phone) {
    const phoneExists = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.phone, phone), eq(users.userType, 'CUSTOMER')))
      .limit(1);

    if (phoneExists.length > 0) {
      throw new AppError(409, ErrorCode.CONFLICT, 'A customer account with this phone number already exists');
    }
  }

  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      fullName: name,
      phone: phone ?? null,
      userType: 'CUSTOMER',
    })
    .returning({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
    });

  // Generate tokens (no shopId or role for customers)
  const accessToken = signAccessToken({
    sub: user.id,
    userType: 'CUSTOMER',
  });

  const rawRefreshToken = generateRefreshToken();
  const refreshTokenHash = hashToken(rawRefreshToken);
  const refreshExpiresAt = new Date(
    Date.now() + parseDurationMs(env.JWT_REFRESH_EXPIRES_IN),
  );

  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: refreshTokenHash,
    expiresAt: refreshExpiresAt,
  });

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      userType: 'CUSTOMER' as const,
    },
  };
}

// ──────────────────────────────────────────────────────────
// LOGIN (unified — works for both customers and shop users)
// ──────────────────────────────────────────────────────────

export interface LoginContext {
  ipAddress?: string;
  userAgent?: string;
  location?: string;
  platform?: string;
}

function loginDeviceName(userAgent = '', platform = '') {
  const source = `${platform} ${userAgent}`;
  const os = /iPhone|iPad|iPod/i.test(source) ? 'iOS' : /Android/i.test(source) ? 'Android' : /Windows/i.test(source) ? 'Windows' : /Mac OS X|Macintosh/i.test(source) ? 'macOS' : /Linux/i.test(source) ? 'Linux' : platform || 'Unknown OS';
  const browser = /Edg\//i.test(userAgent) ? 'Edge' : /Chrome\//i.test(userAgent) ? 'Chrome' : /Firefox\//i.test(userAgent) ? 'Firefox' : /Safari\//i.test(userAgent) && !/Chrome\//i.test(userAgent) ? 'Safari' : /Electron/i.test(userAgent) ? 'Desktop app' : '';
  return browser ? `${os} · ${browser}` : os;
}

async function recordLogin(userId: string, userType: string, context?: LoginContext) {
  try {
    await db.insert(loginActivity).values({ userId, userType, ipAddress: context?.ipAddress || null, location: context?.location || null, deviceName: loginDeviceName(context?.userAgent, context?.platform), platform: context?.platform || null, userAgent: context?.userAgent || null });
  } catch (error) {
    console.error('Failed to record login activity:', error);
  }
}

export async function login({ email, password, expectedUserType }: LoginBody, context?: LoginContext) {
  const genericError = 'Invalid email or password';
  const suspendedMessage = 'Due to Unusual Activities Your Account has been suspended';

  // Build query — if expectedUserType is specified, filter by it directly
  const conditions = expectedUserType
    ? and(eq(users.email, email), eq(users.userType, expectedUserType))
    : eq(users.email, email);

  // Find user (including userType)
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      fullName: users.fullName,
      phone: users.phone,
      avatarUrl: users.avatarUrl,
      status: users.status,
      userType: users.userType,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(conditions)
    .limit(1);

  if (!user) {
    throw new AppError(401, ErrorCode.UNAUTHORIZED, genericError);
  }

  // Verify password
  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    throw new AppError(401, ErrorCode.UNAUTHORIZED, genericError);
  }

  if (user.status === 'SUSPENDED') {
    throw new AppError(403, ErrorCode.FORBIDDEN, suspendedMessage);
  }

  // Store accounts are single-device sessions. A new login invalidates every
  // previous refresh token and advances the access-token version immediately.
  let sessionVersion = user.sessionVersion;
  if (user.userType === 'SHOP_OWNER') {
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(
      and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)),
    );
    const [updatedUser] = await db.update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning({ sessionVersion: users.sessionVersion });
    sessionVersion = updatedUser?.sessionVersion ?? sessionVersion + 1;
  }

  // Admin sessions are persistent and serialized against other logins/refreshes.
  if (user.userType === 'ADMIN') {
    const adminResult = await db.transaction(async tx => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('update');
      const [profile] = await tx.select().from(adminUsers).where(eq(adminUsers.userId, user.id)).limit(1);
      if (!profile || profile.status === 'suspended') throw new AppError(403, ErrorCode.FORBIDDEN, 'Admin account is unavailable');
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));
      const [updated] = await tx.update(users).set({ sessionVersion: sql`${users.sessionVersion} + 1` }).where(eq(users.id, user.id)).returning({ version: users.sessionVersion });
      const refreshToken = generateRefreshToken();
      await tx.insert(refreshTokens).values({ userId: user.id, tokenHash: hashToken(refreshToken), expiresAt: new Date('9999-12-31T00:00:00Z') });
      await tx.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, profile.id));
      try { const { getIO } = await import('../../lib/socket.js'); getIO().in(`admin-user:${user.id}`).disconnectSockets(true); } catch { /* HTTP-only test runtime */ }
      return { accessToken: signAccessToken({ sub: user.id, userType: 'ADMIN', sessionVersion: updated.version }), refreshToken,
        user: { id: user.id, email: user.email, fullName: user.fullName, userType: user.userType, adminRole: profile.role } };
    });
    await recordLogin(user.id, 'ADMIN', context);
    return adminResult;
  }

  // Generate refresh token (common to both user types)
  const rawRefreshToken = generateRefreshToken();
  const refreshTokenHash = hashToken(rawRefreshToken);
  const refreshExpiresAt = new Date(
    Date.now() + parseDurationMs(env.JWT_REFRESH_EXPIRES_IN),
  );

  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: refreshTokenHash,
    expiresAt: refreshExpiresAt,
  });

  // ─── Customer login ───
  if (user.userType === 'CUSTOMER') {
    const accessToken = signAccessToken({
      sub: user.id,
      userType: 'CUSTOMER',
    });

    await recordLogin(user.id, 'CUSTOMER', context);
    return {
      accessToken,
      refreshToken: rawRefreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        avatarUrl: user.avatarUrl,
        userType: user.userType,
      },
    };
  }

  // ─── Shop owner login ───
  // Get membership + shop (first shop for now — multi-shop support later)
  const [membership] = await db
    .select({
      role: memberships.role,
      shopId: memberships.shopId,
      shopName: shops.name,
      onboardingStatus: shops.onboardingStatus,
      stripeConnected: shops.stripeConnected,
    })
    .from(memberships)
    .innerJoin(shops, eq(memberships.shopId, shops.id))
    .where(eq(memberships.userId, user.id))
    .limit(1);

  if (!membership) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'No shop membership found');
  }

  const accessToken = signAccessToken({
    sub: user.id,
    userType: user.userType,
    shopId: membership.shopId,
    role: membership.role,
    sessionVersion,
  });

  await recordLogin(user.id, user.userType, context);

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      userType: user.userType,
    },
    shop: {
      id: membership.shopId,
      name: membership.shopName,
      onboardingStatus: membership.onboardingStatus,
      stripeConnected: membership.stripeConnected,
    },
  };
}

// ──────────────────────────────────────────────────────────
// REFRESH (unified)
// ──────────────────────────────────────────────────────────

export async function refresh(rawRefreshToken: string) {
  const tokenHash = hashToken(rawRefreshToken);
  const suspendedMessage = 'Due to Unusual Activities Your Account has been suspended';

  // Find the refresh token — must exist, not revoked, not expired
  const [storedToken] = await db
    .select({
      id: refreshTokens.id,
      userId: refreshTokens.userId,
      expiresAt: refreshTokens.expiresAt,
      revokedAt: refreshTokens.revokedAt,
    })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);

  if (!storedToken || storedToken.revokedAt || storedToken.expiresAt < new Date()) {
    throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Invalid or expired refresh token');
  }

  const [account] = await db.select({ type: users.userType }).from(users).where(eq(users.id, storedToken.userId)).limit(1);
  if (account?.type === 'ADMIN') {
    return db.transaction(async tx => {
      const [admin] = await tx.select().from(users).where(eq(users.id, storedToken.userId)).for('update');
      const [token] = await tx.select().from(refreshTokens).where(eq(refreshTokens.id, storedToken.id));
      const [profile] = await tx.select().from(adminUsers).where(eq(adminUsers.userId, storedToken.userId));
      if (!token || token.revokedAt) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'This session has ended');
      if (admin.status === 'SUSPENDED' || !profile || profile.status === 'suspended') throw new AppError(403, ErrorCode.FORBIDDEN, 'Admin account is unavailable');
      // Keep the revocable device token stable, including across concurrent browser tabs.
      return { accessToken: signAccessToken({ sub: admin.id, userType: 'ADMIN', sessionVersion: admin.sessionVersion }), refreshToken: rawRefreshToken };
    });
  }

  // Rotate: revoke old token
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.id, storedToken.id));

  // Look up user type
  const [user] = await db
    .select({ userType: users.userType, status: users.status, sessionVersion: users.sessionVersion })
    .from(users)
    .where(eq(users.id, storedToken.userId))
    .limit(1);

  if (!user) {
    throw new AppError(401, ErrorCode.UNAUTHORIZED, 'User not found');
  }

  if (user.status === 'SUSPENDED') {
    throw new AppError(403, ErrorCode.FORBIDDEN, suspendedMessage);
  }

  let newAccessToken: string;

  if (user.userType === 'CUSTOMER') {
    // Customer — no shop/role in token
    newAccessToken = signAccessToken({
      sub: storedToken.userId,
      userType: 'CUSTOMER',
    });
  } else if (user.userType === 'ADMIN') {
    // Admin — no shop/role in token
    newAccessToken = signAccessToken({
      sub: storedToken.userId,
      userType: 'ADMIN',
    });
  } else {
    // Shop owner — include shopId + role
    const [membership] = await db
      .select({
        role: memberships.role,
        shopId: memberships.shopId,
      })
      .from(memberships)
      .where(eq(memberships.userId, storedToken.userId))
      .limit(1);

    if (!membership) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'No shop membership found');
    }

    newAccessToken = signAccessToken({
      sub: storedToken.userId,
      userType: user.userType,
      shopId: membership.shopId,
      role: membership.role,
      sessionVersion: user.sessionVersion,
    });
  }

  const newRawRefreshToken = generateRefreshToken();
  const newRefreshTokenHash = hashToken(newRawRefreshToken);
  const refreshExpiresAt = new Date(
    Date.now() + parseDurationMs(env.JWT_REFRESH_EXPIRES_IN),
  );

  await db.insert(refreshTokens).values({
    userId: storedToken.userId,
    tokenHash: newRefreshTokenHash,
    expiresAt: refreshExpiresAt,
  });

  return {
    accessToken: newAccessToken,
    refreshToken: newRawRefreshToken,
  };
}

// ──────────────────────────────────────────────────────────
// LOGOUT
// ──────────────────────────────────────────────────────────

export async function logout(
  userId: string,
  jti: string,
  accessTokenExp: number,
  rawRefreshToken?: string,
) {
  // Blacklist the current access token until it naturally expires
  const ttl = Math.max(0, accessTokenExp - Math.floor(Date.now() / 1000));
  if (ttl > 0) {
    await redis.set(`bl:${jti}`, '1', 'EX', ttl);
  }

  if (rawRefreshToken) {
    // Revoke the specific refresh token
    const tokenHash = hashToken(rawRefreshToken);
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          eq(refreshTokens.userId, userId),
        ),
      );
  } else {
    // Revoke ALL refresh tokens for this user
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
        ),
      );
  }
}

// ──────────────────────────────────────────────────────────
// FORGOT PASSWORD
// ──────────────────────────────────────────────────────────

export async function forgotPassword({ email, expectedUserType }: ForgotPasswordBody) {
  const conditions = expectedUserType
    ? and(eq(users.email, email), eq(users.userType, expectedUserType))
    : eq(users.email, email);

  // Same email can exist for CUSTOMER, SHOP_OWNER, or ADMIN, so only fan out when no
  // caller has scoped the request to one account type.
  const matchingUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(conditions);

  if (matchingUsers.length === 0) {
    if (expectedUserType === 'SHOP_OWNER') {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'No store account found with this email');
    }

    if (expectedUserType === 'CUSTOMER') {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'No customer account found with this email');
    }

    if (expectedUserType === 'ADMIN') {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'No admin account found with this email');
    }

    // Default public flow stays enumeration-safe.
    return { message: 'If an account with this email exists, a reset link has been sent' };
  }

  // Generate a reset token for each matching user (could be 1 or 2)
  for (const user of matchingUsers) {
    // Invalidate any previous unused reset tokens for this user
    await db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          isNull(passwordResetTokens.usedAt),
        ),
      );

    // Generate a new reset token
    const rawToken = generateResetToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    // Send the reset email (fire-and-forget so we don't leak timing info)
    sendPasswordResetEmail(email, rawToken, 15).catch((err) => {
      console.error('❌ Failed to send password reset email:', err);
    });
  }

  return { message: 'If an account with this email exists, a reset link has been sent' };
}

// ──────────────────────────────────────────────────────────
// RESET PASSWORD
// ──────────────────────────────────────────────────────────

export async function resetPassword({ token, newPassword }: ResetPasswordBody) {
  const tokenHash = hashToken(token);

  const [storedToken] = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
      usedAt: passwordResetTokens.usedAt,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1);

  if (!storedToken || storedToken.usedAt || storedToken.expiresAt < new Date()) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Invalid or expired reset token');
  }

  const newPasswordHash = await hashPassword(newPassword);

  // Atomic: update password + mark token used + revoke all refresh tokens
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash: newPasswordHash, updatedAt: new Date() })
      .where(eq(users.id, storedToken.userId));

    await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(passwordResetTokens.id, storedToken.id));

    // Revoke all refresh tokens — user must re-login after password reset
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.userId, storedToken.userId),
          isNull(refreshTokens.revokedAt),
        ),
      );
  });

  return { message: 'Password has been reset successfully' };
}

// ──────────────────────────────────────────────────────────
// GET ME (unified)
// ──────────────────────────────────────────────────────────

export async function getMe(userId: string) {
  // User info (no password hash)
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
      avatarUrl: users.avatarUrl,
      userType: users.userType,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'User not found');
  }

  // Customers — no shop memberships
  if (user.userType === 'CUSTOMER') {
    return { user, shops: [] };
  }

  // Shop owners — include memberships
  const shopMemberships = await db
    .select({
      shopId: memberships.shopId,
      role: memberships.role,
      shopName: shops.name,
      onboardingStatus: shops.onboardingStatus,
      stripeConnected: shops.stripeConnected,
      vacationMode: shops.vacationMode,
      protectionEnabled: shops.protectionEnabled,
    })
    .from(memberships)
    .innerJoin(shops, eq(memberships.shopId, shops.id))
    .where(eq(memberships.userId, userId));

  return {
    user,
    shops: shopMemberships.map((m) => ({
      id: m.shopId,
      name: m.shopName,
      role: m.role,
      onboardingStatus: m.onboardingStatus,
      stripeConnected: m.stripeConnected,
      vacationMode: m.vacationMode,
      protectionEnabled: m.protectionEnabled,
    })),
  };
}
