import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    "[db] DATABASE_URL not set — database queries will fail at runtime. " +
    "Server will start normally; set DATABASE_URL to enable Postgres features.",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgresql://disabled" });
export const db = drizzle(pool, { schema });

export * from "./schema";

export { eq, and, or, ne, gt, gte, lt, lte, isNull, isNotNull, inArray, desc, asc, sql } from "drizzle-orm";
