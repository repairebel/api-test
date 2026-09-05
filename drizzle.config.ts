import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // Drizzle Kit reads the compiled schema because the source files use ESM .js imports.
  schema: './dist/db/schema/index.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
