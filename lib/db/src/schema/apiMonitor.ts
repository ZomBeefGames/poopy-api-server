/**
 * apiMonitor.ts — Postgres tables for api-server observability.
 *
 * Why Postgres (not SQLite): these tables must survive api-server restarts.
 * error_log and test_runs are the primary data — they must be durable.
 *
 * Tables:
 *  - error_log      : ring buffer of caught errors (Step 1)
 *  - test_runs      : async test harness job tracking (Step 5)
 */

import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  jsonb,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── error_log — Postgres-persisted error ring buffer ──────────────────────────
// Every caught Express error + uncaughtException + unhandledRejection writes here.
// Ring-buffer enforced on insert: keep last 500 rows, delete oldest beyond that.
// /api/zombrains/logs/recent reads from this table, not from memory.
export const errorLogTable = pgTable("error_log", {
  id:          serial("id").primaryKey(),
  timestamp:   timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  route:       text("route").notNull().default("unknown"),
  method:      text("method").notNull().default("unknown"),
  message:     text("message").notNull(),
  stack:       text("stack"),
  status_code: integer("status_code"),
  source:      text("source").notNull().default("api-server"),
});

export type ErrorLog    = typeof errorLogTable.$inferSelect;
export type NewErrorLog = typeof errorLogTable.$inferInsert;

// ── test_runs — async test harness job tracking ───────────────────────────────
// POST /api/zombrains/test/run creates a row with status=pending and returns the id.
// The async runner updates the row on completion/failure.
// GET /api/zombrains/test/run/:jobId polls this table.
export const testRunsTable = pgTable("test_runs", {
  id:                    uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  created_at:            timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  status:                text("status").notNull().default("pending"), // pending | running | complete | failed
  prompt:                text("prompt").notNull(),
  persona_detected:      text("persona_detected"),
  system_prompt_preview: text("system_prompt_preview"),
  tools_filtered:        jsonb("tools_filtered"),
  llm_output:            text("llm_output"),
  reviewer_would_trigger: boolean("reviewer_would_trigger"),
  error:                 text("error"),
  completed_at:          timestamp("completed_at", { withTimezone: true }),
});

export type TestRun    = typeof testRunsTable.$inferSelect;
export type NewTestRun = typeof testRunsTable.$inferInsert;
