import { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shops } from '../db/schema/index.js';
import { AppError, ErrorCode } from './error-handler.plugin.js';

/**
 * Pre-handler that checks the shop's onboarding status is 'APPROVED'.
 * Must be used AFTER `fastify.authenticate` so `request.user` is populated.
 *
 * Usage: `{ preHandler: [fastify.authenticate, requireApproved] }`
 */
export async function requireApproved(request: FastifyRequest, _reply: FastifyReply) {
  if (!request.user) {
    throw new AppError(401, ErrorCode.UNAUTHORIZED, 'Not authenticated');
  }

  // Customers don't have a shop — block access to shop-only endpoints
  if (request.user.userType === 'CUSTOMER') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'This endpoint requires a shop account');
  }

  if (!request.user.shopId) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'No shop associated with this account');
  }

  const [shop] = await db
    .select({ onboardingStatus: shops.onboardingStatus })
    .from(shops)
    .where(eq(shops.id, request.user.shopId))
    .limit(1);

  if (!shop || shop.onboardingStatus !== 'APPROVED') {
    throw new AppError(
      403,
      ErrorCode.SHOP_NOT_APPROVED,
      'Your shop has not been approved yet. Please complete the onboarding process.',
    );
  }
}
