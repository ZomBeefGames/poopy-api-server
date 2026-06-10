// ══════════════════════════════════════════════════════════════════════════════
// zombrains.ts — Core endpoints: ping, auth/viewer-secret, journal (write),
//   reports, task feedback, tasks-paused, cluster-flags, known-problems.
// ══════════════════════════════════════════════════════════════════════════════
import { Router, type IRouter, type Request, type Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import {
  getDb, DB_PATH,
  authCheck,
  getExpectedSecret, getExpectedViewSecret,
  postTaskCompletedToDiscord,
} from "./zombrains-shared.js";
import { setRailwayBenchmarkFlag } from "../lib/crystallineEvolver.js";

const router: IRouter = Router();

// ── Ping — lightweight connectivity check for systemHealth.js on Railway ────────
router.get("/zombrains/ping", (_req: Request, res: Response) => {
  res.json({ ok: true, ts: Date.now() });
});

// ── Crystalline Evolver Heartbeat ───────────────────────────────────────────────
router.post("/crystalline-evolver/heartbeat", (req: Request, res: Response) => {
  // Handle crystalline evolver heartbeat
  res.json({ ok: true });
});

// ── Viewer secret endpoints ────────────────────────────────────────────────────

router.get("/zombrains/view-secret", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  // Only tell admin whether it's configured — never return the value
  const secret = getExpectedViewSecret();
  res.json({ configured: !!secret });
});

router.put("/zombrains/view-secret", (req: Request, res: Response) => {
  // This is a write endpoint — only admin secret accepted (not viewer secret)
  const expected = getExpectedSecret();
  if (expected) {
    const token = (req.headers["x-zombrains-secret"] ?? req.headers["x-admin-secret"] ?? req.headers["authorization"]?.replace("Bearer ", "")) as string | undefined;
    if (token !== expected) { res.status(401).json({ error: "Unauthorized" }); return; }
  }
  const { secret } = req.body as { secret?: string };
  if (!secret || secret.trim().length < 4) { res.status(400).json({ error: "Viewer secret must be at least 4 characters" }); return; }
  const db = new Database(DB_PATH, { readonly: false });
  try {
    db.prepare(`INSERT INTO bot_settings (key, value) VALUES ('zombrains_view_secret', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(secret.trim());
    res.json({ ok: true });
  } finally { db.close(); }
});

router.delete("/zombrains/view-secret", (req: Request, res: Response) => {
  const expected = getExpectedSecret();
  if (expected) {
    const token = (req.headers["x-zombrains-secret"] ?? req.headers["x-admin-secret"] ?? req.headers["authorization"]?.replace("Bearer ", "")) as string | undefined;
    if (token !== expected) { res.status(401).json({ error: "Unauthorized" }); return; }
  }
  const db = new Database(DB_PATH, { readonly: false });
  try {
    db.prepare("DELETE FROM bot_settings WHERE key='zombrains_view_secret'").run();
    res.json({ ok: true });
  } finally { db.close(); }
});

router.post("/zombrains/verify-view-secret", (req: Request, res: Response) => {
  const expected = getExpectedViewSecret();
  if (!expected) { res.status(404).json({ error: "Viewer secret not configured" }); return; }
  const { secret } = req.body as { secret?: string };
  if (secret !== expected) { res.status(401).json({ error: "Invalid viewer secret" }); return; }
  res.json({ ok: true });
});

// ── Journal write endpoint ─────────────────────────────────────────────────────
router.post("/zombrains/journal", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { message, level } = req.body as { message?: string; level?: string };
  if (!message) { res.status(400).json({ error: "message required" }); return; }
  const db = getDb();
  try {
    db.prepare(`INSERT INTO zombrains_journal (message, level, ts) VALUES (?, ?, ?)`).run(message, level || "info", Date.now());
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Reports endpoint ───────────────────────────────────────────────────────────
router.get("/zombrains/reports", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const limit = parseInt((req.query.limit as string) || "10");
  const db = getDb();
  try {
    const rows = db.prepare(`SELECT * FROM zombrains_reports ORDER BY id DESC LIMIT ?`).all(limit);
    res.json({ ok: true, rows });
  } finally { db.close(); }
});

// ── POST /zombrains/report — task completion/error reports from Railway ────────
// Called by report_to_replit tool and notifyDiscordComplete in queue.js.
// Poopy's completion poller reads these via GET /zombrains/reports for 👍/👎 feedback.
router.post("/zombrains/report", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { type, task, message, data } = req.body as {
    type?: string; task?: string; message?: string; data?: unknown;
  };
  if (!message) { res.status(400).json({ error: "message is required" }); return; }
  const db = getDb();
  try {
    const dataStr = data !== undefined
      ? (typeof data === "string" ? data : JSON.stringify(data))
      : null;
    db.prepare(`INSERT INTO zombrains_reports (type, task, message, data) VALUES (?, ?, ?, ?)`)
      .run(type || "info", task ?? null, message, dataStr);
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Task feedback endpoint ─────────────────────────────────────────────────────
router.post("/zombrains/task/feedback", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { taskId, feedback, ai_score, completion_score } = req.body as { taskId?: string; feedback?: string; ai_score?: number; completion_score?: number };
  if (!taskId) { res.status(400).json({ error: "taskId required" }); return; }
  const db = getDb();
  try {
    db.prepare(`INSERT INTO zombrains_feedback (taskId, feedback, ai_score, completion_score, ts) VALUES (?, ?, ?, ?, ?)`).run(taskId, feedback || "", ai_score || null, completion_score || null, Date.now());
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Tasks paused endpoint ──────────────────────────────────────────────────────
router.get("/zombrains/tasks-paused", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const row = db.prepare("SELECT enabled FROM feature_flags WHERE flag='zombrains_tasks_paused'").get() as { enabled: number } | undefined;
    res.json({ paused: row?.enabled === 1 });
  } finally { db.close(); }
});

// ── Cluster flags endpoint ─────────────────────────────────────────────────────
const CLUSTER_FLAGS: Record<string, { key: string; defaultEnabled: boolean }> = {
  tasksPaused:                { key: "zombrains_tasks_paused",              defaultEnabled: false },
  autoApprove:                { key: "zombrains_auto_approve_enabled",      defaultEnabled: false },
  pushLocked:                 { key: "zombrains_push_locked",               defaultEnabled: false },
  groqDeepseekRatelimit:      { key: "zombrains_groq_deepseek_ratelimit",   defaultEnabled: false },
  taskPlansOnly:              { key: "zombrains_task_plans_only",           defaultEnabled: false },
  evolverRailwayBenchmark:          { key: "evolver_railway_benchmark_enabled",   defaultEnabled: false },
  evolver_railway_benchmark_enabled: { key: "evolver_railway_benchmark_enabled",   defaultEnabled: false },
  zombrains:                  { key: "zombrains_cluster_enabled",           defaultEnabled: true  },
  poopy:                      { key: "poopy_cluster_enabled",               defaultEnabled: true  },
  birthday:                   { key: "birthday_cluster_enabled",            defaultEnabled: true  },
  apiWorker:                  { key: "api_worker_cluster_enabled",          defaultEnabled: true  },
};

router.get("/zombrains/cluster-flags", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const result: Record<string, boolean> = {};
    for (const [field, { key, defaultEnabled }] of Object.entries(CLUSTER_FLAGS)) {
      const row = db.prepare("SELECT enabled FROM feature_flags WHERE flag=?").get(key) as { enabled: number } | undefined;
      result[field] = row != null ? row.enabled === 1 : defaultEnabled;
    }
    res.json(result);
  } finally { db.close(); }
});

router.patch("/zombrains/cluster-flags", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { flag, enabled } = req.body as { flag?: string; enabled?: boolean };
  const entry = flag ? CLUSTER_FLAGS[flag] : undefined;
  if (!entry) { res.status(400).json({ error: "unknown flag" }); return; }
  const db = getDb();
  try {
    db.prepare("INSERT OR REPLACE INTO feature_flags (flag, enabled) VALUES (?, ?)").run(entry.key, enabled ? 1 : 0);
    if (flag === "evolverRailwayBenchmark" || flag === "evolver_railway_benchmark_enabled") setRailwayBenchmarkFlag(!!enabled);
    res.json({ ok: true, flag, enabled: !!enabled });
  } finally { db.close(); }
});

// ── Known problems endpoint ─────────────────────────────────────────────────────
router.get("/zombrains/known-problems", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const rows = db.prepare(`SELECT * FROM zombrains_known_problems ORDER BY last_seen DESC`).all();
    res.json({ ok: true, rows });
  } finally { db.close(); }
});

// ── Evolver injected config ─────────────────────────────────────────────────────
// ZomBrains reads this at boot to pick up any live config injected via bot_settings.
// Returns { config: {} } if no evolver_config key is stored yet.
router.get("/zombrains/evolver/injected-config", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'evolver_config'").get() as { value: string } | undefined;
    let config: Record<string, unknown> = {};
    if (row?.value) {
      try { config = JSON.parse(row.value); } catch { /* leave empty — corrupt value */ }
    }
    res.json({ config });
  } finally { db.close(); }
});

// ── Task #448: Domain stats endpoint ───────────────────────────────────────────
// Returns task count grouped by task_domain for quality records in the last 7 days.
// Source of truth for what types of work ZomBrains has been doing.
// Untagged rows (task_domain IS NULL) appear under 'untagged'.
router.get("/zombrains/queue/domain-stats", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const rows = db.prepare(
      `SELECT COALESCE(task_domain, 'untagged') AS domain,
              COUNT(*)  AS total,
              SUM(CASE WHEN outcome = 'done'       THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN outcome = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter,
              SUM(CASE WHEN outcome = 'failed'      THEN 1 ELSE 0 END) AS failed,
              ROUND(AVG(CASE WHEN ai_score IS NOT NULL THEN ai_score END), 1) AS avg_ai_score
       FROM zb_ai_quality
       WHERE evaluated_at >= datetime('now', '-7 days')
       GROUP BY COALESCE(task_domain, 'untagged')
       ORDER BY total DESC`
    ).all() as { domain: string; total: number; done: number; dead_letter: number; failed: number; avg_ai_score: number | null }[];
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    res.json({ ok: true, since, domains: rows });
  } finally { db.close(); }
});

export default router;