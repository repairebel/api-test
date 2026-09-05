# RepairRebel Server

The backend API for the RepairRebel platform, built with Fastify, TypeScript, and Drizzle ORM.

For deployment, use [RAILWAY.md](RAILWAY.md). Railway setup uses the bundled dataset;
no local SQL dump is required. Migrations and seeds run in the pre-deploy step.

For the dataset suggested-price implementation, test database import, and isolated
local API on port 6065, use [PRICING_IMPLEMENTATION.md](PRICING_IMPLEMENTATION.md).
The ordinary `.env` shares a Redis service with the main server; use `npm run dev:test`
for this pricing test environment.

## Tech Stack

- **Framework**: [Fastify](https://www.fastify.io/)
- **ORM**: [Drizzle ORM](https://orm.drizzle.team/)
- **Database**: [PostgreSQL](https://www.postgresql.org/)
- **Real-time**: [Socket.io](https://socket.io/)
- **Task Queue**: [BullMQ](https://docs.bullmq.io/) with [Redis](https://redis.io/)
- **Validation**: [Zod](https://zod.dev/)
- **Logging**: [Pino](https://getpino.io/)

## Prerequisites

- **Node.js**: v18 or later
- **PostgreSQL**: v14 or later
- **Redis**: v6 or later
- **SMTP Server**: For email notifications

## Quick Start (Recommended)

The server includes an interactive setup script that handles environment configuration and database seeding.

```bash
chmod +x setup.sh
./setup.sh
```

The script will prompt you for database credentials, SMTP settings, and initial admin user details.

## Manual Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create a `.env` file in the root of the `server/` directory:

```env
NODE_ENV=development
PORT=6664

# PostgreSQL
DATABASE_URL=postgresql://user:password@localhost:5432/repairrebel

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_ACCESS_SECRET=your_32_char_access_secret
JWT_REFRESH_SECRET=your_32_char_refresh_secret
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# SMTP (Email)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user@example.com
SMTP_PASS=password
SMTP_FROM="RepairRebel <no-reply@repairrebel.com>"

# Optional Integrations
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PUBLISHABLE_KEY=
OPENAI_API_KEY=
```

### 3. Database Setup And Migrations

The setup script applies the Drizzle migrations in `drizzle/`, inserts missing
default settings, and imports the bundled supplier catalog with its suggested
prices. It does not read local SQL dumps. Railway runs the compiled `db:deploy`
command before starting the API; see [RAILWAY.md](RAILWAY.md).

```bash
# Create the database if needed, run migrations, and seed system settings + device models
npm run db:setup

# Generate migrations from the current Drizzle schema
npm run db:generate

# Apply only the Drizzle migrations
npm run db:migrate

# Seed only the baseline data
npm run db:seed

# Rebuild a fresh local test database
npm run db:test:setup

# Refresh the checked-in SQL schema/data dumps from DATABASE_URL
npm run db:dump

# Alternatively, push schema changes directly (dev only)
npm run db:push
```

### 4. Admin Seeding

To create an initial super admin user:

```bash
ADMIN_NAME="Super Admin" \
ADMIN_EMAIL="admin@repairrebel.com" \
ADMIN_PASSWORD="securepassword" \
npx tsx src/scripts/seed-admin.ts
```

## Development

Run the server in development mode with hot-reloading:

```bash
npm run dev
```

The API will be available at `http://localhost:6664`.

## Available Scripts

- `npm run dev`: Start development server using `tsx watch`.
- `npm run build`: Compile TypeScript to JavaScript in the `dist/` folder.
- `npm start`: Start the production build from `dist/index.js`.
- `npm run db:generate`: Generate migration files.
- `npm run db:migrate`: Run pending Drizzle migrations on `DATABASE_URL`.
- `npm run db:seed`: Seed baseline system settings and device models.
- `npm run db:setup`: Create the database if needed, migrate it, and seed it.
- `npm run db:test:setup`: Reset and rebuild `repairebeltest`.
- `npm run db:dump`: Refresh `database-schema.sql` and `database-seed.sql` from `DATABASE_URL`.
- `npm run db:push`: Sync schema directly with the database.
- `npm run db:studio`: Open Drizzle Studio for database exploration.

## Project Structure

- `src/app.ts`: Fastify application instance and plugin registration.
- `src/index.ts`: Server entry point and worker initialization.
- `src/modules/`: Domain-specific routes and logic (Auth, Jobs, etc.).
- `src/db/`: Database configuration and schema definitions.
- `drizzle/`: Generated Drizzle migration files and metadata.
- `src/lib/`: Reusable utilities (Email, Redis, Socket, Queue).
- `src/plugins/`: Custom Fastify plugins.
- `src/scripts/`: Maintenance and seeding scripts.
- `database-schema.sql`: Schema dump refreshed from the live PostgreSQL database.
- `database-seed.sql`: Data dump refreshed from the live PostgreSQL database.
