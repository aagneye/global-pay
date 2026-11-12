import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `prisma generate` doesn't need a database, so a missing URL must not fail it.
    // Migrations do need one: set DATABASE_URL in .env.
    url: process.env.DATABASE_URL ?? '',
  },
});
