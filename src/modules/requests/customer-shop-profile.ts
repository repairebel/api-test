import { and, eq, desc, count, avg } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { shops, reviews } from '../../db/schema/index.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';

// Public business fields only: never expose owner identities or payment settings.
export async function getCustomerShopProfile(shopId: string, page = 1) {
  const [shop] = await db.select({
    id: shops.id, name: shops.name, description: shops.description,
    logoUrl: shops.logoUrl, phone: shops.phone, email: shops.publicEmail,
    website: shops.website, address: shops.address, city: shops.city,
    state: shops.state, zipCode: shops.zipCode, country: shops.country,
    latitude: shops.latitude, longitude: shops.longitude,
    businessHours: shops.businessHours, categories: shops.categories,
  }).from(shops).where(and(eq(shops.id, shopId), eq(shops.onboardingStatus, 'APPROVED'))).limit(1);
  if (!shop) throw new AppError(404, ErrorCode.NOT_FOUND, 'Store profile is unavailable.');
  const visible = and(eq(reviews.shopId, shopId), eq(reviews.isHidden, false));
  const [summary] = await db.select({ total: count(), rating: avg(reviews.rating) }).from(reviews).where(visible);
  const entries = await db.select({ id: reviews.id, customerName: reviews.customerName,
    rating: reviews.rating, text: reviews.text, createdAt: reviews.createdAt,
  }).from(reviews).where(visible).orderBy(desc(reviews.createdAt), desc(reviews.id)).limit(20).offset((page - 1) * 20);
  return { ...shop, rating: Number(summary?.rating ?? 0), reviewCount: summary?.total ?? 0,
    reviews: entries, reviewsPage: page, hasMoreReviews: page * 20 < (summary?.total ?? 0) };
}
