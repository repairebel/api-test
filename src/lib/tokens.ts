import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { env } from '../config/env.js';

// ---------- Types ----------

export type UserType = 'CUSTOMER' | 'SHOP_OWNER' | 'ADMIN';
export type ShopRole = 'OWNER' | 'MANAGER' | 'TECH';

export interface AccessTokenPayload {
  sub: string;       // userId
  userType: UserType;
  shopId?: string;   // only for SHOP_OWNER
  role?: ShopRole;   // only for SHOP_OWNER
  jti: string;       // unique token id (for blacklisting)
}

export interface DecodedAccessToken extends AccessTokenPayload {
  iat: number;
  exp: number;
}

// ---------- Access Token ----------

export function signAccessToken(payload: Omit<AccessTokenPayload, 'jti'>): string {
  const jti = nanoid(21);
  // Strip undefined values so JWT payload stays clean
  const clean: Record<string, unknown> = { ...payload, jti };
  for (const key of Object.keys(clean)) {
    if (clean[key] === undefined) delete clean[key];
  }
  return jwt.sign(
    clean,
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN } as jwt.SignOptions,
  );
}

export function verifyAccessToken(token: string): DecodedAccessToken {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as DecodedAccessToken;
}

// ---------- Refresh Token ----------

/** Generate a cryptographically random refresh token (hex string). */
export function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex');
}

/** SHA-256 hash of a token, for safe database storage. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---------- Helpers ----------

/** Parse a duration string like "15m" or "7d" into milliseconds. */
export function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid duration format: ${duration}`);

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default:  throw new Error(`Unknown time unit: ${unit}`);
  }
}

/** Generate a password reset token (shorter, URL-safe). */
export function generateResetToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}
