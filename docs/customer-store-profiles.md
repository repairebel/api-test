# Customer store profiles and protection eligibility

Implemented in the test server only. No production migration or deployment was performed.

## Behavior

- Authenticated customers can browse active plans only from approved, protection-enabled stores where they have a `COMPLETED` repair with `RELEASED` payment. The optional `shopId` filter narrows this list. Direct subscription requests enforce the same rule before calling Stripe. Existing subscriptions remain accessible.
- After payment release, the customer repair screen shows an optional protection invitation below the review action. It opens that store's plans using the existing subscription and payment flow.
- `GET /v1/customer/shops/:shopId?page=1` returns an approved store's public business details and visible reviews (20 per page). Hidden reviews are excluded from both the list and rating. Owner account and payment details are never projected.
- Store profiles open from map store details and incoming offer headers.
- Store settings now include a separate public business email. Existing website, logo, description, phone, address and business hours populate the profile. Missing fields display an empty-state message.

## Database and validation

Migration `0005_public_shop_email.sql` adds nullable `shops.public_email`. Apply migrations before running the updated server. This migration was applied to the isolated localhost test database only.

Validation: `npm run test:pricing` includes authenticated eligibility and profile checks; `npm run test:deploy` checks compiled Railway setup against a fresh isolated database, including repeatability. Both passed. Customer and store TypeScript checks also passed.

Before live rollout, check the profile, map navigation, incoming offer navigation, post-release invitation and subscription screen on a physical device against the test API. No real subscription charge was made during these tests.
