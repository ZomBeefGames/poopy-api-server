// ══════════════════════════════════════════════════════════════════════════════
// billing.ts — ZomBrains monetization: credits, tiers, beta invites, Whop webhooks
//
// Identity contract (end-to-end canonical):
//   'owner'          → internal ZomBrains tasks, idle tasks, proposals — never charged
//   '<customerId>'   → raw Whop customer ID, no prefix — set as task.userId at enqueue
//   '<any string>'   → beta users chose their own userId at beta-redeem time
//
// Balance lookup: GET /api/billing/balance
//   ?userId=<id>  + admin Bearer → Railway pipeline stop (balanceCheck.js)
//   x-billing-user-id header    → user self-lookup (e.g. future frontend)
//   no params + admin Bearer    → admin full user list
//
// Webhook HMAC: verified against raw request bytes (req.rawBody captured by app.ts verify).
// WHOP_WEBHOOK_SECRET must be set — returns 503 if missing (fail-closed).
// ══════════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { eq, sql, desc, isNull, and } from "@workspace/db";
import { authCheck } from "./zombrains-shared.js";
import { TIER_CAPS } from "@workspace/db";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// 60-second in-memory balance cache keyed by userId.
const _balanceCache = new Map<string, { balance: number; tier: string; tasksThisMonth: number; monthKey: string; cachedAt: number }>();
const BALANCE_CACHE_TTL_MS = 60_000;

function invalidateBalanceCache(userId: string) {
  _balanceCache.delete(userId);
}

async function getBalance(userId: string): Promise<{ balance: number; tier: string; tasksThisMonth: number; cap: number | null } | null> {
  const now = Date.now();
  const cached = _balanceCache.get(userId);
  if (cached && now - cached.cachedAt < BALANCE_CACHE_TTL_MS) {
    const cap = TIER_CAPS[cached.tier] ?? null;
    return { balance: cached.balance, tier: cached.tier, tasksThisMonth: cached.tasksThisMonth, cap };
  }
  try {
    const { db, userCreditsTable } = await import("@workspace/db");
    const monthKey = currentMonthKey();
    const rows = await db.select().from(userCreditsTable).where(eq(userCreditsTable.user_id, userId)).limit(1);
    if (!rows.length) return null;
    const row = rows[0];
    const tasksThisMonth = row.month_key === monthKey ? row.tasks_this_month : 0;
    _balanceCache.set(userId, { balance: row.balance, tier: row.tier, tasksThisMonth, monthKey: row.month_key, cachedAt: now });
    const cap = TIER_CAPS[row.tier] ?? null;
    return { balance: row.balance, tier: row.tier, tasksThisMonth, cap };
  } catch {
    return null;
  }
}

// ── GET /api/billing/balance ──────────────────────────────────────────────────
router.get("/billing/balance", async (req: Request, res: Response) => {
  // Mode 1: ?userId= with admin Bearer (Railway balanceCheck.js)
  const qUserId = (req.query["userId"] as string | undefined) ?? "";
  if (qUserId) {
    if (!authCheck(req, res)) return;
    if (qUserId === "owner") {
      res.json({ ok: true, balance: Infinity, tier: "owner", tasksThisMonth: 0, cap: null });
      return;
    }
    const bal = await getBalance(qUserId);
    if (!bal) { res.status(404).json({ error: "User not found" }); return; }
    res.json({ ok: true, ...bal });
    return;
  }

  // Mode 2: x-billing-user-id header (user self-lookup, e.g. future frontend)
  // Trusts the caller-supplied ID. Acceptable for balance metadata (not PII).
  const hUserId = (req.headers["x-billing-user-id"] as string | undefined) ?? "";
  if (hUserId) {
    if (hUserId === "owner") {
      res.json({ ok: true, balance: Infinity, tier: "owner", tasksThisMonth: 0, cap: null });
      return;
    }
    const bal = await getBalance(hUserId);
    if (!bal) { res.status(404).json({ error: "User not found" }); return; }
    res.json({ ok: true, ...bal });
    return;
  }

  // Mode 3: admin full user list
  if (!authCheck(req, res)) return;
  const { db, userCreditsTable } = await import("@workspace/db");
  try {
    const rows = await db.select().from(userCreditsTable).orderBy(desc(userCreditsTable.created_at)).limit(100);
    res.json({ ok: true, users: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/billing/decrement ───────────────────────────────────────────────
// Requires admin auth — replitPost on Railway sends Authorization: Bearer automatically.
// Owner tasks: no-op. Dead-letter tasks: caller must not send those.
router.post("/billing/decrement", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;

  const { userId, taskId, taskDomain, tokenless } = req.body as {
    userId?: string; taskId?: string; taskDomain?: string; tokenless?: boolean;
  };
  if (!userId || !taskId) { res.status(400).json({ error: "userId and taskId required" }); return; }
  if (userId === "owner") { res.json({ ok: true, noOp: true }); return; }

  invalidateBalanceCache(userId);

  try {
    const { db, userCreditsTable, billingEventsTable } = await import("@workspace/db");
    const monthKey = currentMonthKey();

    const rows = await db.select().from(userCreditsTable).where(eq(userCreditsTable.user_id, userId)).limit(1);
    if (!rows.length) { res.status(404).json({ error: "User not found" }); return; }
    const row = rows[0];

    const tasksThisMonth = row.month_key === monthKey ? row.tasks_this_month : 0;

    await db.update(userCreditsTable)
      .set({
        balance:          Math.max(0, row.balance - 1),
        tasks_this_month: tasksThisMonth + 1,
        month_key:        monthKey,
        updated_at:       new Date(),
      })
      .where(eq(userCreditsTable.user_id, userId));

    await db.insert(billingEventsTable).values({
      user_id:      userId,
      task_id:      taskId,
      task_domain:  taskDomain ?? "general",
      tokenless:    tokenless ?? false,
      credit_cost:  1,
      tier_at_time: row.tier,
    });

    // Ring-buffer: delete oldest beyond 10,000
    await db.execute(sql`
      DELETE FROM billing_events
      WHERE id IN (
        SELECT id FROM billing_events ORDER BY id ASC LIMIT (
          SELECT GREATEST(0, COUNT(*) - 10000) FROM billing_events
        )
      )
    `);

    res.json({ ok: true, newBalance: Math.max(0, row.balance - 1) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/billing/beta-invite ─────────────────────────────────────────────
// Admin creates a one-time beta access code — stored in billing_beta_codes.
router.post("/billing/beta-invite", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const code = crypto.randomBytes(12).toString("hex");
  try {
    const { db, billingBetaCodesTable } = await import("@workspace/db");
    await db.insert(billingBetaCodesTable).values({ code });
    res.json({ ok: true, beta_code: code, redeem_url: `/api/billing/beta-redeem` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/billing/beta-redeem ─────────────────────────────────────────────
// Validates code, atomically marks used (WHERE redeemed_at IS NULL), creates user.
router.post("/billing/beta-redeem", async (req: Request, res: Response) => {
  const { code, userId } = req.body as { code?: string; userId?: string };
  if (!code || !userId) { res.status(400).json({ error: "code and userId required" }); return; }
  if (userId === "owner") { res.status(400).json({ error: "reserved userId" }); return; }

  try {
    const { db, billingBetaCodesTable, userCreditsTable } = await import("@workspace/db");

    const codeRows = await db.select().from(billingBetaCodesTable)
      .where(eq(billingBetaCodesTable.code, code)).limit(1);
    if (!codeRows.length) { res.status(404).json({ error: "Invalid invite code" }); return; }
    if (codeRows[0].redeemed_at !== null) { res.status(409).json({ error: "Invite code already used" }); return; }

    const existing = await db.select().from(userCreditsTable).where(eq(userCreditsTable.user_id, userId)).limit(1);
    if (existing.length) { res.status(409).json({ error: "User already exists" }); return; }

    const monthKey = currentMonthKey();
    const now = new Date();

    let redeemed = false;
    await db.transaction(async (tx) => {
      const updated = await tx.update(billingBetaCodesTable)
        .set({ redeemed_at: now, redeemed_by: userId })
        .where(and(eq(billingBetaCodesTable.code, code), isNull(billingBetaCodesTable.redeemed_at)))
        .returning({ id: billingBetaCodesTable.id });

      if (!updated.length) return;

      await tx.insert(userCreditsTable).values({
        user_id:          userId,
        balance:          50,
        tier:             "beta",
        beta_code:        code,
        tasks_this_month: 0,
        month_key:        monthKey,
      });
      redeemed = true;
    });

    if (!redeemed) { res.status(409).json({ error: "Invite code already used" }); return; }
    res.json({ ok: true, userId, tier: "beta", balance: 50, cap: 50 });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/billing/webhook — Whop webhook handler ─────────────────────────
// HMAC-SHA256 verified against raw request bytes (req.rawBody from app.ts verify).
// Fails-closed: returns 503 if WHOP_WEBHOOK_SECRET is not configured.
// Identity: user_id stored as raw customerId (no prefix) to match task.userId convention.
router.post("/billing/webhook", async (req: Request & { rawBody?: Buffer }, res: Response) => {
  const secret = process.env["WHOP_WEBHOOK_SECRET"] ?? "";
  if (!secret) {
    res.status(503).json({ error: "Webhook not configured — set WHOP_WEBHOOK_SECRET" });
    return;
  }

  const sig = req.headers["whop-signature"] as string | undefined;
  if (!sig) { res.status(401).json({ error: "missing whop-signature header" }); return; }

  // Verify against raw body bytes — avoids canonicalization mismatches from JSON.stringify
  const rawBody = req.rawBody;
  if (!rawBody) { res.status(400).json({ error: "raw body unavailable" }); return; }

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  let sigValid = false;
  try {
    const sigBuf = Buffer.from(sig.replace(/^sha256=/, ""), "hex");
    sigValid = sigBuf.length > 0 && crypto.timingSafeEqual(sigBuf, Buffer.from(expected, "hex"));
  } catch {
    sigValid = false;
  }
  if (!sigValid) { res.status(401).json({ error: "invalid signature" }); return; }

  const { event, data } = req.body as { event?: string; data?: { customer_id?: string; plan?: string } };
  const customerId = data?.customer_id ?? "";
  if (!customerId) { res.json({ ok: true, skipped: true }); return; }

  // user_id stored as raw customerId — matches task.userId convention (no whop_ prefix)
  const tierMap: Record<string, string> = { starter: "starter", pro: "pro", unlimited: "unlimited" };
  const planTier = tierMap[data?.plan ?? ""] ?? "starter";
  const monthKey = currentMonthKey();

  try {
    const { db, userCreditsTable } = await import("@workspace/db");
    const existing = await db.select().from(userCreditsTable).where(eq(userCreditsTable.whop_customer_id, customerId)).limit(1);

    if (event === "purchase" || event === "subscription.renewed") {
      const cap = TIER_CAPS[planTier];
      const topUp = cap ?? 999999;
      if (existing.length) {
        await db.update(userCreditsTable).set({
          balance:          topUp,
          tier:             planTier,
          tasks_this_month: 0,
          month_key:        monthKey,
          updated_at:       new Date(),
        }).where(eq(userCreditsTable.whop_customer_id, customerId));
        invalidateBalanceCache(existing[0].user_id);
      } else {
        // Store raw customerId as user_id (no whop_ prefix) so task.userId matches directly
        await db.insert(userCreditsTable).values({
          whop_customer_id: customerId,
          user_id:          customerId,
          balance:          topUp,
          tier:             planTier,
          tasks_this_month: 0,
          month_key:        monthKey,
        });
      }
    } else if (event === "subscription.cancelled") {
      if (existing.length) {
        await db.update(userCreditsTable).set({ balance: 0, updated_at: new Date() }).where(eq(userCreditsTable.whop_customer_id, customerId));
        invalidateBalanceCache(existing[0].user_id);
      }
    } else if (event === "refund") {
      if (existing.length) {
        await db.update(userCreditsTable).set({ balance: Math.max(0, (existing[0].balance ?? 0) - 1), updated_at: new Date() }).where(eq(userCreditsTable.whop_customer_id, customerId));
        invalidateBalanceCache(existing[0].user_id);
      }
    }

    res.json({ ok: true, event });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/billing/revenue-summary ─────────────────────────────────────────
router.get("/billing/revenue-summary", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const { db, billingEventsTable, userCreditsTable } = await import("@workspace/db");
    const monthKey = currentMonthKey();

    const allEvents = await db.select().from(billingEventsTable).orderBy(desc(billingEventsTable.created_at)).limit(10000);
    const allUsers  = await db.select().from(userCreditsTable);

    const thisMonthEvents = allEvents.filter(e => {
      const d = new Date(e.created_at);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === monthKey;
    });

    const tasksThisMonth = thisMonthEvents.length;
    const tokenlessCount = thisMonthEvents.filter(e => e.tokenless).length;
    const tokenlessPct   = tasksThisMonth > 0 ? Math.round((tokenlessCount / tasksThisMonth) * 100) : 0;

    const tierCounts: Record<string, number> = {};
    for (const u of allUsers) { tierCounts[u.tier] = (tierCounts[u.tier] ?? 0) + 1; }

    const tierMrr: Record<string, number> = { starter: 5, pro: 15, unlimited: 40, beta: 0 };
    let mrr = 0;
    for (const u of allUsers) { mrr += tierMrr[u.tier] ?? 0; }

    const avgCost = tokenlessPct / 100 * 0.001 + (1 - tokenlessPct / 100) * 0.01;
    const revenuePerTask = 0.05;
    const avgMarginPct = revenuePerTask > 0 ? Math.round((1 - avgCost / revenuePerTask) * 100) : 0;

    res.json({
      ok: true, mrr, tasksThisMonth, tokenlessPct, avgMarginPct,
      byTier: tierCounts, totalUsers: allUsers.length,
      betaCount: allUsers.filter(u => u.tier === "beta").length,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
