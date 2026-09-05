# Dataset suggested pricing

For Railway deployment, see `RAILWAY.md`. The compiled pre-deploy setup seeds
this catalog directly and does not require `database-seed.sql`.

This change belongs to `Repairebel-Server -test`, `Repairebel-Customer`, and
`Repairebel-Store`. The main server checkout is unchanged. No production deployment
or migration is part of this work.

## Request flow

1. The customer searches supported device models in PostgreSQL. Existing inventory
   device IDs are retained; the importer adds missing models without deleting the
   old catalog or shop inventory.
2. The issue screen asks for the repairs priced for that exact device ID.
3. The price screen receives a model-specific suggested price. This is a required
   minimum, shown as a read-only value. The customer may offer that amount or more.
4. Before submission, the app refreshes the quote. The API independently looks up
   the selected model and repair, validates the model labels, checks catalog
   version and offer amount, and saves the floor and its calculation snapshot.
5. Dispatch events, customer request details, the store feed and store details all
   expose the saved floor as `suggestedPriceCents`. `minPriceCents` remains an equal
   compatibility alias. Store offers are also checked against the saved floor.
6. Offer acceptance continues through the existing job/payment workflow. Historical
   requests keep their saved prices after catalog updates.

Auth, request signatures, dispatch ranking/timeouts, inventory reservations,
offer expiry, job status, Stripe payment capture, payouts, reviews, notifications,
and administration remain in their existing modules. The catalog import does not
contact suppliers, send messages, run queue workers, or invoke payment APIs.

## Price policy

- Use the corrected workbook's parts median, a 2x multiplier and fixed $30 labor.
- Formula: `ROUNDUP(parts cost × 2 + 30, 2) × 100`. Always round upward to cents.
- Normalized duplicate rows use an unweighted median of eligible source-row
  medians per individual device and repair variant. Every row must use 2x markup
  and $30 labor. These decisions are saved in the snapshot.
- No brand-wide inventory fallback or arbitrary baseline is used for new requests.
  An unsupported model/repair combination returns 422 and cannot be posted.
- All prices are treated as USD, matching the existing apps. The workbook itself
  does not specify a currency code.

The original source has 8,513 rows. The corrected workbook publishes 2,639
device/hardware variants and 5,543 model/repair prices using 7,653 eligible source rows.
The other 860 rows remain in its Needs Review sheet with reasons. Brand, device
family, individual model, hardware variant and parts category are separate fields.
The database JSON is read back from the corrected Excel workbook. See
`src/modules/pricing/CATALOG.md` for normalization rules, repair variants,
compatibility handling, limitations, and reproducible extraction commands.

## API contract

Public routes use the existing `{success:true,data:...}` envelope:

| Endpoint | Result |
| --- | --- |
| `GET /v1/device-models?brand=&query=&limit=100&supportedOnly=true` | Search models with active dataset pricing; max 500 results per search |
| `GET /v1/device-models/brands?supportedOnly=true` | Brands with active dataset prices |
| `GET /v1/issue-types?deviceModelId=UUID` | Only the selected model's supported repairs |
| `GET /v1/price-estimate?deviceModelId=UUID&issueType=SCREEN` | Authoritative model/repair quote |
| `POST /v1/customer/requests` | Authenticated request; requires model ID, canonical brand/model, repair ID, integer offer cents, location, and usual request fields |

The quote includes `deviceModelId`, `deviceBrand`, `deviceModel`, `issueType`,
`issueDisplayName`, `catalogVersion`, `source:"dataset"`, `currency:"USD"`,
`partsCost`, `partsCostCents`, `markupMultiplier`, `laborFeeCents`,
`suggestedPriceCents`, `minPriceCents`, and `suggestedOfferCents`.
All three price aliases equal the required floor. Parts medians may include
fractions of a cent; final payable/offer amounts are integer cents.

Submit `catalogVersion` with the request. A changed version returns 409 and requires
price review; a price below the floor or mismatched device label returns 400.
Unknown models/repairs return 422. The backend disregards client-supplied floor
fields. Request feeds/detail and dispatch events include `issueDisplayName` so
new repair variants display correctly.

## Isolated local run

Prerequisites: Node 20+, installed project dependencies, PostgreSQL, and Redis.
The default local database is `repairebel_pricing_test` under the current OS user;
the runner accepts `TEST_DATABASE_URL` for a different **local test-named** database.
It never resets an existing database.

```sh
# Dedicated local Redis: keep this terminal open.
redis-server --port 6385 --bind 127.0.0.1 --save '' --appendonly no

# From Repairebel-Server -test:
npm run db:test:pricing:setup
npm run test:pricing
npm run dev:test

# In separate Customer and Store terminals:
npm run start:test
```

The API runs at `http://localhost:6065`. For Android emulators use the app test
script's Android option, or `REPAIREBEL_TEST_API_URL=http://10.0.2.2:6065`.
For physical devices set that variable to this computer's LAN address. See the
Customer README and Store `TEST_API.md` for their exact launch commands.

The runtime deliberately overrides the test folder's `.env`: its configured
Redis points to the same service as the main server. Local tests use port 6385,
local-only SMTP, empty payment/media keys, and synthetic users without push tokens.
Live payment, email delivery, and media upload need separate test integration
credentials and are outside the pricing regression run. Do not run the ordinary
`npm run dev` against the shared Redis to test these changes.

## Test database import

```sh
npm run db:pricing:check       # Validate and print counts; no database mutation
npm run db:pricing:import      # Additive migration + atomic import, verified test DB only
```

The remote import guard checks this test checkout's database identity against
its own `.env` and independently against the main checkout's `.env`. It refuses
the main database or an unverified remote target. Credentials are not printed.
The source rows are archived by catalog version; current prices are upserted in
one transaction under an advisory lock. A re-import is idempotent. A changed
catalog retires missing current prices but retains old source snapshots and
previously submitted requests.

Migration `0001_dataset_suggested_prices.sql` adds `repair_price_sources`,
`repair_prices`, and nullable request model/snapshot columns. It does not rewrite
old request prices. Future migration to the main server requires the user's
explicit instruction and a new migration reconciled with the main server's
existing Drizzle history; do not copy the test journal over it.

## Verification

- Extractor tests cover all source invariants, accessory filtering, compatibility,
  model metadata cleanup, camera variants, and display assembly rules.
- Pricing tests reconcile every source row to the independently extracted workbook
  formula, exercise rounding boundaries, version changes, and database target guards.
- API integration tests use real signatures/authentication and PostgreSQL to
  exercise customer submission, dispatch, store feeds/details, and offer validation.
- Both mobile apps include focused pricing guard tests and test launch scripts.
  The customer native iOS JS bundle and store web bundle were checked. The existing
  customer Stripe native import prevents its web export; native payment architecture
  was not changed by this work.
