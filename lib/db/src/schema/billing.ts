/**
 * billing.ts — Postgres tables for ZomBrains monetization layer.
 *
 * Why Postgres (not SQLite): this is financial data. Must survive api-server restarts
 * and be queryable from any future replica or self-hosted node.
 *
 * Tables:
 *  - user_credits   : per-user balance, tier, and monthly task counter
 *  - billing_events : ring buffer of all credit transactions (max 10,000 rows)
 */

import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── user_credits — per-user credit balance and tier ───────────────────────────
// Created manually by owner via POST /api/billing/beta-invite + beta-redeem,
// or automatically by Whop webhook on purchase/subscription events.
// tier values: 'beta' | 'starter' | 'pro' | 'unlimited'
export const userCreditsTable = pgTable("user_credits", {
  id:               serial("id").primaryKey(),
  whop_customer_id: text("whop_customer_id"),
  user_id:          text("user_id").notNull().unique(),
  balance:          integer("balance").notNull().default(0),
  tier:             text("tier").notNull().default("beta"),
  // tasks_this_month is reset on the 1st of each month by POST /api/billing/month-reset
  tasks_this_month: integer("tasks_this_month").notNull().default(0),
  month_key:        text("month_key").notNull().default(""),
  beta_code:        text("beta_code"),
  created_at:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at:       timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type UserCredit    = typeof userCreditsTable.$inferSelect;
export type NewUserCredit = typeof userCreditsTable.$inferInsert;

// ── billing_events — ring buffer of credit transactions ───────────────────────
// Appended on every credit decrement. Ring-buffer enforced on insert: keep last 10,000 rows.
// tokenless=true means no AI provider was called → 100% margin event.
export const billingEventsTable = pgTable("billing_events", {
  id:           serial("id").primaryKey(),
  user_id:      text("user_id").notNull(),
  task_id:      text("task_id").notNull(),
  task_domain:  text("task_domain").notNull().default("general"),
  tokenless:    boolean("tokenless").notNull().default(false),
  credit_cost:  integer("credit_cost").notNull().default(1),
  tier_at_time: text("tier_at_time").notNull().default("beta"),
  created_at:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type BillingEvent    = typeof billingEventsTable.$inferSelect;
export type NewBillingEvent = typeof billingEventsTable.$inferInsert;

// ── billing_beta_codes — one-time invite codes ────────────────────────────────
// Created by POST /api/billing/beta-invite (admin).
// Redeemed atomically by POST /api/billing/beta-redeem — sets redeemed_at + redeemed_by.
// Unused codes have redeemed_at = NULL.
export const billingBetaCodesTable = pgTable("billing_beta_codes", {
  id:          serial("id").primaryKey(),
  code:        text("code").notNull().unique(),
  created_at:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  redeemed_at: timestamp("redeemed_at", { withTimezone: true }),
  redeemed_by: text("redeemed_by"),
}, (table) => ({
  codeIdx: index("billing_beta_codes_code_idx").on(table.code),
}));

export type BillingBetaCode    = typeof billingBetaCodesTable.$inferSelect;
export type NewBillingBetaCode = typeof billingBetaCodesTable.$inferInsert;

// ── Tier caps (reference — not a table) ──────────────────────────────────────
// Used by balanceCheck.js (Railway) and billing.ts (api-server) to enforce monthly limits.
// tier: 'beta'      → 50 tasks/month, free
// tier: 'starter'   → 100 tasks/month, $5/month
// tier: 'pro'       → 350 tasks/month, $15/month
// tier: 'unlimited' → no cap, $40/month
export const TIER_CAPS: Record<string, number | null> = {
  beta:      50,
  starter:   100,
  pro:       350,
  unlimited: null,
};
