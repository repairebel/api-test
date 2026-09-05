# Railway test-server deployment

Deploy this test-server checkout. The main server and its database are separate.

## Service configuration

Use the directory containing this `package.json` as the Railway service root.
If deploying the parent monorepo, set Root Directory to `/Repairebel-Server -test`
and the Railway config file path to `/Repairebel-Server -test/railway.json`.
If this folder is its own repository, use `/railway.json` and the repository root.

The checked-in configuration sets:

| Setting | Value |
| --- | --- |
| Builder | Railpack |
| Build command | `npm ci --include=dev --legacy-peer-deps && npm run build` |
| Pre-deploy command | `npm run db:deploy` |
| Start command | `npm start` |
| Health check | `/health` |

Remove an old custom start command such as
`npm run db:setup -- --no-create && npm start` if it is still applied in Railway.
The pre-deploy command runs the compiled migration and seed script. The start
command only starts the compiled API, including on container restarts.
See [Railway configuration](https://docs.railway.com/config-as-code/reference)
and [pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command).

## Variables

Keep secrets in Railway Variables; do not upload a local `.env` or SQL dump.

- `NODE_ENV=production` for the deployed Node process, even in the test service.
- `DATABASE_URL`: reference the **test PostgreSQL** service connection string.
- `REDIS_URL`: reference a **dedicated test Redis** service. The local test folder's
  old `.env` shares a Redis server with production, so do not copy that value.
- `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`: separate test secrets, each at
  least 32 characters.
- Existing email variables: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  `SMTP_FROM`.
- Configure test Cloudinary/Stripe credentials if testing uploads/payments.
- `AWS_REGION=us-east-1` and `AWS_BEARER_TOKEN_BEDROCK`: Bedrock Kimi K2.5
  credentials for missing model/part prices. Keep the bearer token only in
  Railway Variables; never commit it. If Bedrock is throttled, the API serves a
  short-lived catalog fallback and retries Bedrock after 15 minutes.

Railway provides `PORT`; the API binds that port on `0.0.0.0`.

## Bundled data and setup

The build copies the tracked `src/modules/pricing/catalog-data.json` to
`dist/modules/pricing/catalog-data.json`. Commit that source JSON and the `drizzle/`
migrations with the deployment files. `database-seed.sql` and `database-schema.sql`
remain ignored and are no longer runtime dependencies.

`db:deploy` uses Node and compiled files, so it works after development dependencies
such as `tsx` and TypeScript are pruned. It does not create or reset the Railway
database. It applies migrations, inserts default settings only when absent, and
atomically upserts the bundled devices, source rows, and suggested prices.
Existing device IDs, operator settings, inventory, and request snapshots survive
redeployment. It also populates a fresh test database with the complete catalog.

The deployment setup uses the service's configured `DATABASE_URL`. The separate
local `db:pricing:import` utility retains its checkout-based test-database guard;
use `db:deploy` in Railway, where sibling checkout `.env` files do not exist.

## Validation

`npm run test:deploy` builds and runs the compiled setup twice in a temporary
deployment folder with no `.env`, source directory, or SQL dump. It uses a newly
created, local-only test database, verifies the bundled catalog counts and every
2x-parts-plus-$30 price, and checks that redeployment preserves IDs and settings.
PostgreSQL must be running locally; `TEST_DATABASE_URL` can specify local credentials.

After redeployment, check the pre-deploy log for the import counts and call `/health`
and `/v1/device-models?brand=Apple&query=iPhone%2013` on the test API domain.
