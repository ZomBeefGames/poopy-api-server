/**
 * workerEvents.ts — Postgres tables for worker bot observability.
 *
 * Tables:
 *  - worker_step_events  : one row per saga step executed by any worker (durable analytics)
 *  - worker_registry_log : register / heartbeat / expire lifecycle events
 */

import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

// ── worker_step_events ────────────────────────────────────────────────────────
// One row per step execution attempt (complete or failed).
// Ring-buffered: keep last 2000 rows (enforced on insert in api-server).
export const workerStepEventsTable = pgTable("worker_step_events", {
  id:           serial("id").primaryKey(),
  ts:           timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  executor:     text("executor").notNull(),          // "api-worker" | "poopy" | "zombrains"
  task_id:      text("task_id").notNull(),
  step_index:   integer("step_index").notNull(),
  outcome:      text("outcome").notNull(),            // "complete" | "failed"
  provider:     text("provider"),                     // which AI provider was used
  tokens:       integer("tokens"),                    // total tokens consumed
  latency_ms:   integer("latency_ms"),                // wall-clock execution time
  prompt_chars: integer("prompt_chars"),              // resolved prompt length (chars)
  output_chars: integer("output_chars"),              // output length (chars)
  error_msg:    text("error_msg"),                    // failure reason (if outcome=failed)
});

export type WorkerStepEvent    = typeof workerStepEventsTable.$inferSelect;
export type NewWorkerStepEvent = typeof workerStepEventsTable.$inferInsert;

// ── worker_registry_log ───────────────────────────────────────────────────────
// Lifecycle events for every worker that has ever connected.
// Useful for spotting workers that crash + restart frequently.
// Ring-buffered: keep last 500 rows.
export const workerRegistryLogTable = pgTable("worker_registry_log", {
  id:         serial("id").primaryKey(),
  ts:         timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  executor:   text("executor").notNull(),
  event_type: text("event_type").notNull(),            // "register" | "heartbeat" | "expire"
  pid:        integer("pid"),
  version:    text("version"),
});

export type WorkerRegistryLog    = typeof workerRegistryLogTable.$inferSelect;
export type NewWorkerRegistryLog = typeof workerRegistryLogTable.$inferInsert;
