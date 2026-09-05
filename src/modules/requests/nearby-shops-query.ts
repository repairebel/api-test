import { z } from 'zod';

export const CUSTOMER_MAP_RADIUS_KM = 160.9344;
const numeric = (schema: z.ZodNumber) => z.preprocess(
  value => typeof value === 'string' && !value.trim() ? undefined : value,
  schema,
);

// Radius remains kilometres for existing clients, capped at 100 miles.
export const nearbyShopsQuerySchema = z.object({
  lat: numeric(z.coerce.number().finite().min(-90).max(90)),
  lng: numeric(z.coerce.number().finite().min(-180).max(180)),
  radius: numeric(z.coerce.number().finite().positive()).optional()
    .default(CUSTOMER_MAP_RADIUS_KM).transform(value => Math.min(value, CUSTOMER_MAP_RADIUS_KM)),
});
