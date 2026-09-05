import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { createHash, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { verifyAccessToken, DecodedAccessToken } from '../lib/tokens.js';
import { redis } from '../lib/redis.js';
import { AppError, ErrorCode } from './error-handler.plugin.js';

const SIGNATURE_MAX_AGE_MS = 2 * 60 * 1000;
const SIGNATURE_NONCE_TTL_SECONDS = 3 * 60;

function sortForStableJson(value: any): any {
  if (Array.isArray(value)) {
    return value.map((item) => sortForStableJson(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, sortForStableJson(value[key])] as const);
    return Object.fromEntries(entries);
  }

  return value;
}

function stableStringify(value: any): string {
  return JSON.stringify(sortForStableJson(value));
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function buildCanonicalSignaturePayload(params: {
  method: string;
  url: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}): string {
  return [params.method.toUpperCase(), params.url, params.timestamp, params.nonce, params.bodyHash].join('\n');
}

function readHeaderValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authorization header');
    }

    const token = authHeader.slice(7);

    let decoded: DecodedAccessToken;
    try {
      decoded = verifyAccessToken(token);
    } catch (err: any) {
      const message =
        err.name === 'TokenExpiredError' ? 'Access token has expired' :
        err.name === 'JsonWebTokenError' ? 'Invalid access token' :
        'Authentication failed';
      throw new AppError(401, ErrorCode.UNAUTHORIZED, message);
    }

    // Check if token is blacklisted (e.g. after logout)
    const isBlacklisted = await redis.exists(`bl:${decoded.jti}`);
    if (isBlacklisted) {
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Token has been revoked');
    }

    const [user] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, decoded.sub))
      .limit(1);

    if (!user) {
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'User not found');
    }

    if (user.status === 'SUSPENDED') {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'Due to Unusual Activities Your Account has been suspended');
    }

    request.user = {
      userId: decoded.sub,
      userType: decoded.userType ?? 'SHOP_OWNER', // backward compat for old tokens
      shopId: decoded.shopId ?? '',
      role: decoded.role ?? '',
      jti: decoded.jti,
    };

    if (decoded.userType === 'ADMIN') {
      return;
    }

    const signature = readHeaderValue(request.headers['x-rr-signature'] as string | string[] | undefined);
    const nonce = readHeaderValue(request.headers['x-rr-nonce'] as string | string[] | undefined);
    const timestamp = readHeaderValue(request.headers['x-rr-ts'] as string | string[] | undefined);

    if (!signature || !nonce || !timestamp) {
      throw new AppError(401, ErrorCode.INVALID_REQUEST_SIGNATURE, 'Missing signed request headers');
    }

    const timestampMs = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(timestampMs)) {
      throw new AppError(401, ErrorCode.INVALID_REQUEST_SIGNATURE, 'Invalid request timestamp');
    }

    if (Math.abs(Date.now() - timestampMs) > SIGNATURE_MAX_AGE_MS) {
      throw new AppError(401, ErrorCode.INVALID_REQUEST_SIGNATURE, 'Request signature expired');
    }

    const requestBody = request.body === undefined ? '' : stableStringify(request.body);
    const bodyHash = sha256Hex(requestBody);
    const canonicalPayload = buildCanonicalSignaturePayload({
      method: request.method,
      url: request.url,
      timestamp,
      nonce,
      bodyHash,
    });

    const expectedSignature = sha256Hex(`${token}:${canonicalPayload}`);
    const providedSignatureBuffer = Buffer.from(signature, 'utf8');
    const expectedSignatureBuffer = Buffer.from(expectedSignature, 'utf8');

    if (
      providedSignatureBuffer.length !== expectedSignatureBuffer.length ||
      !timingSafeEqual(providedSignatureBuffer, expectedSignatureBuffer)
    ) {
      throw new AppError(401, ErrorCode.INVALID_REQUEST_SIGNATURE, 'Invalid request signature');
    }

    const nonceKey = `sig-nonce:${decoded.jti}:${nonce}`;
    const nonceReserved = await redis.set(nonceKey, '1', 'EX', SIGNATURE_NONCE_TTL_SECONDS, 'NX');
    if (!nonceReserved) {
      throw new AppError(401, ErrorCode.INVALID_REQUEST_SIGNATURE, 'Replay request detected');
    }
  });
};

/**
 * Pre-handler factory to enforce RBAC (shop roles).
 * Usage: `{ preHandler: [fastify.authenticate, requireRole('OWNER', 'MANAGER')] }`
 */
export function requireRole(...roles: Array<'OWNER' | 'MANAGER' | 'TECH'>) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user) {
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Not authenticated');
    }
    if (!request.user.role || !roles.includes(request.user.role)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'Insufficient permissions');
    }
  };
}

/**
 * Pre-handler factory to enforce user type.
 * Usage: `{ preHandler: [fastify.authenticate, requireUserType('CUSTOMER')] }`
 */
export function requireUserType(...types: Array<'CUSTOMER' | 'SHOP_OWNER' | 'ADMIN'>) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user) {
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Not authenticated');
    }
    if (!types.includes(request.user.userType)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint is not available for your account type');
    }
  };
}

export default fp(authPlugin, { name: 'auth', dependencies: ['error-handler'] });
