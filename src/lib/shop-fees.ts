import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shops, systemSettings } from '../db/schema/index.js';

const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

function clampPercent(value: number | null | undefined, fallback: number) {
  const resolved = value ?? fallback;
  return Math.max(0, Math.min(100, Number(resolved)));
}

export async function getShopFeeRates(shopId: string) {
  const [[shop], [settings]] = await Promise.all([
    db
      .select({
        customCommissionPercent: shops.customCommissionPercent,
        customInsurancePercent: shops.customInsurancePercent,
      })
      .from(shops)
      .where(eq(shops.id, shopId))
      .limit(1),
    db
      .select({
        commissionPercent: systemSettings.commissionPercent,
        insurancePercent: systemSettings.insurancePercent,
      })
      .from(systemSettings)
      .where(eq(systemSettings.id, SETTINGS_ID))
      .limit(1),
  ]);

  const defaultCommissionPercent = clampPercent(settings?.commissionPercent, 15);
  const defaultInsurancePercent = clampPercent(settings?.insurancePercent, 5);

  return {
    commissionPercent: clampPercent(shop?.customCommissionPercent, defaultCommissionPercent),
    insurancePercent: clampPercent(shop?.customInsurancePercent, defaultInsurancePercent),
    defaultCommissionPercent,
    defaultInsurancePercent,
    hasCustomCommission: shop?.customCommissionPercent != null,
    hasCustomInsurance: shop?.customInsurancePercent != null,
  };
}
