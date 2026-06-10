// ══════════════════════════════════════════════════════════════════════════════
// zombrains-persist.ts — Persist, blob, and utility read endpoints.
// Routes: /zombrains/persist/*, /zombrains/dl-type-counts, /zombrains/routes,
//   /zombrains/recent-work, /zombrains/notes, /zombrains/journal (GET),
//   /zombrains/idle-state (GET).
// Extracted from zombrains.ts (was lines 337-934).
// ══════════════════════════════════════════════════════════════════════════════
import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import {
  getDb, authCheck, REPLIT_FILE_WORKSPACE_ROOT,
} from "./zombrains-shared.js";
import {
  db as pgDb,
  crystalChampionsTable,
  sql as pgSql,
} from "@workspace/db";

const router: IRouter = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Persist: Queue ────────────────────────────────────────────────────────────

router.get("/zombrains/persist/queue", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const row = db.prepare("SELECT data FROM zombrains_queue WHERE key = 'main'").get() as { data: string } | undefined;
  db.close();
  if (!row) { res.json([]); return; }
  try { res.json(JSON.parse(row.data)); } catch { res.json([]); }
});

router.post("/zombrains/persist/queue", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const data = req.body;
  if (!Array.isArray(data)) { res.status(400).json({ error: "body must be an array" }); return; }
  const db = getDb();

  // Saga merge: ZomBrains' local queue.json doesn't know about active worker locks
  // set by Poopy/api-worker via step-complete. A blind overwrite would reset those
  // locks mid-execution and cause step-complete to return 409 (lock mismatch).
  // Fix: when the incoming push contains a saga task that currently has an active
  // workerLock in SQLite, keep the SQLite version (don't overwrite it).
  let mergedData: unknown[] = data;
  try {
    const existingRow = db.prepare("SELECT data FROM zombrains_queue WHERE key = 'main'").get() as { data: string } | undefined;
    if (existingRow?.data) {
      const existing: unknown[] = JSON.parse(existingRow.data);
      const activeLockMap = new Map<string, unknown>();
      for (const t of existing) {
        const task = t as Record<string, unknown>;
        if (
          typeof task.id === "string" &&
          Array.isArray(task.steps) &&
          typeof task.currentStep === "number" &&
          task.workerLock != null
        ) {
          activeLockMap.set(task.id, t);
        }
      }
      if (activeLockMap.size > 0) {
        mergedData = data.map(t => {
          const task = t as Record<string, unknown>;
          return activeLockMap.get(task.id as string) ?? t;
        });
      }
    }
  } catch { /* non-fatal — fall back to plain overwrite */ }

  db.prepare(`
    INSERT INTO zombrains_queue (key, data, updated_at) VALUES ('main', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(JSON.stringify(mergedData));
  db.close();
  res.json({ ok: true });
});

// ── Persist: tools.js source sync — Railway → Replit ─────────────────────────
// ZomBrains POSTs its full tools.js on boot and after every task completion.
// Keeps builder-agent/src/tools.js on Replit in sync with Railway's live file
// so the file is always in git and editable from here.
router.post("/zombrains/persist/tools-source", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { content } = req.body as { content?: string };
  if (typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "content required" }); return;
  }
  // Syntax-check before saving — never overwrite a good backup with broken JS.
  try {
    new Function(content);
  } catch (syntaxErr: any) {
    res.status(400).json({ error: "syntax check failed", detail: syntaxErr.message }); return;
  }
  const dest = path.join(REPLIT_FILE_WORKSPACE_ROOT, "builder-agent", "src", "tools.js");
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, "utf8");
    res.json({ ok: true, bytes: content.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET — Railway fetches its backup on boot to restore tools.js after a restart wipe.
router.get("/zombrains/persist/tools-source", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const dest = path.join(REPLIT_FILE_WORKSPACE_ROOT, "builder-agent", "src", "tools.js");
  try {
    const content = fs.readFileSync(dest, "utf8");
    if (!content.trim() || content.includes("...existing content...")) {
      res.status(404).json({ error: "no backup available yet" }); return;
    }
    res.json({ ok: true, content, bytes: content.length });
  } catch {
    res.status(404).json({ error: "no backup available yet" });
  }
});

// ── Persist: Queue state snapshot — lightweight counts, no full queue blob ────
// ZomBrains POSTs this at most once per 30 s from the tick loop end.
// Feeds agent-briefing and admin panel with live queue counts without the cost
// of syncing the entire queue blob on every tick.

router.post("/zombrains/persist/queue-state", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const data = req.body;
  if (typeof data !== "object" || Array.isArray(data)) { res.status(400).json({ error: "body must be an object" }); return; }
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('queue_snapshot', ?)")
    .run(JSON.stringify({ ...data, storedAt: new Date().toISOString() }));
  db.close();
  res.json({ ok: true });
});

router.get("/zombrains/persist/queue-state", (_req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'queue_snapshot'").get() as { value: string } | undefined;
  db.close();
  if (!row) { res.json(null); return; }
  try { res.json(JSON.parse(row.value)); } catch { res.json(null); }
});

// ── Persist: success-metrics, retry-ledger, idle-state (Railway ephemeral data) ──
// These three datasets live in Railway's ephemeral filesystem and are lost on restart/redeploy.
// ZomBrains pushes a backup here after every write and restores on boot via GET.
// Uses the zombrains_settings KV table — no schema changes needed.

router.post("/zombrains/persist/success-metrics", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const data = req.body;
  if (typeof data !== "object" || Array.isArray(data)) { res.status(400).json({ error: "body must be an object" }); return; }
  if (typeof data.totalDone !== "number" || typeof data.totalFailed !== "number" || typeof data.byType !== "object") {
    res.status(400).json({ error: "missing required fields: totalDone, totalFailed, byType" }); return;
  }
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('persist_success_metrics', ?)")
    .run(JSON.stringify({ ...data, storedAt: new Date().toISOString() }));
  db.close();
  res.json({ ok: true });
});

router.get("/zombrains/persist/success-metrics", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const row = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'persist_success_metrics'").get() as { value: string } | undefined;
  db.close();
  if (!row) { res.json(null); return; }
  try { res.json(JSON.parse(row.value)); } catch { res.json(null); }
});

router.post("/zombrains/persist/retry-ledger", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const data = req.body;
  // Body is the ledger object: { [taskId]: { attempts, tools, lastError, createdAt, updatedAt } }
  if (typeof data !== "object" || Array.isArray(data)) { res.status(400).json({ error: "body must be an object" }); return; }
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('persist_retry_ledger', ?)")
    .run(JSON.stringify({ ledger: data, storedAt: new Date().toISOString() }));
  db.close();
  res.json({ ok: true });
});

router.get("/zombrains/persist/retry-ledger", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const row = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'persist_retry_ledger'").get() as { value: string } | undefined;
  db.close();
  if (!row) { res.json(null); return; }
  try {
    const parsed = JSON.parse(row.value);
    res.json(parsed.ledger ?? null);
  } catch { res.json(null); }
});

router.post("/zombrains/persist/idle-state", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const data = req.body;
  if (typeof data !== "object" || Array.isArray(data)) { res.status(400).json({ error: "body must be an object" }); return; }
  if (typeof data.cycleCount !== "number") { res.status(400).json({ error: "cycleCount (number) required" }); return; }
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('persist_idle_state', ?)")
    .run(JSON.stringify({ ...data, storedAt: new Date().toISOString() }));
  db.close();
  res.json({ ok: true });
});

router.get("/zombrains/persist/idle-state", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const row = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'persist_idle_state'").get() as { value: string } | undefined;
  db.close();
  if (!row) { res.json(null); return; }
  try { res.json(JSON.parse(row.value)); } catch { res.json(null); }
});

// ── Persist: ERROR_MEMORY.md (Railway local Markdown, learned failure patterns) ──
// ZomBrains appends entries here via recordError() after every task failure.
// Without backup these are lost on every Railway restart, forcing re-discovery.
// Stored as raw text in zombrains_settings; 300KB hard cap on Monitor side.
// Merge guard on restore: if local file (from git pull) >= Monitor size → skip.

router.post("/zombrains/persist/error-memory", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { content } = req.body as { content?: string };
  if (typeof content !== "string") { res.status(400).json({ error: "content (string) required" }); return; }
  if (Buffer.byteLength(content, "utf8") > 300_000) {
    res.status(400).json({ error: "content exceeds 300KB limit — trim before sending" }); return;
  }
  if (content && !content.includes("---")) {
    res.status(400).json({ error: "content must contain YAML --- separators or be empty string" }); return;
  }
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('persist_error_memory', ?)")
    .run(JSON.stringify({ content, storedAt: new Date().toISOString() }));
  db.close();
  res.json({ ok: true, bytes: Buffer.byteLength(content, "utf8") });
});

router.get("/zombrains/persist/error-memory", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const row = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'persist_error_memory'").get() as { value: string } | undefined;
  db.close();
  if (!row) { res.json(null); return; }
  try {
    const parsed = JSON.parse(row.value);
    res.json({ content: parsed.content ?? null, storedAt: parsed.storedAt ?? null });
  } catch { res.json(null); }
});

// ── Persist: crystal persistence status (suit.stable.json save record) ───────
// ZomBrains POSTs this after every successful suit.stable.json write to Railway
// Volume, and on boot if a suit already exists. Lets the admin panel show when
// the Volume was last written without needing direct Railway Volume access.

router.post("/zombrains/persist/crystal-persistence-status", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { volumeOk, volumePath, lastSavedAt, specialistCount } = req.body ?? {};
  if (typeof volumeOk !== "boolean") { res.status(400).json({ error: "volumeOk (boolean) required" }); return; }
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('persist_crystal_status', ?)")
    .run(JSON.stringify({ volumeOk, volumePath: volumePath ?? null, lastSavedAt: lastSavedAt ?? null, specialistCount: specialistCount ?? 0, storedAt: new Date().toISOString() }));
  db.close();
  res.json({ ok: true });
});

router.get("/zombrains/persist/crystal-persistence-status", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const row = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'persist_crystal_status'").get() as { value: string } | undefined;
  db.close();
  if (!row) { res.json(null); return; }
  try {
    const p = JSON.parse(row.value);
    res.json({ volumeOk: p.volumeOk ?? null, volumePath: p.volumePath ?? null, lastSavedAt: p.lastSavedAt ?? null, specialistCount: p.specialistCount ?? 0, storedAt: p.storedAt ?? null });
  } catch { res.json(null); }
});

// ── Persist: zb-killswitches.json (safety kill switches) ──────────────────────
// toggle_killswitch writes 4 boolean flags to /app/zb-killswitches.json.
// Without backup these reset to all-false on Railway restart — a switch enabled
// for good reason (e.g. block add_tool after a bad loop) silently re-enables.
// Schema is fixed: only 4 known keys, all boolean. Unknown keys are stripped.

router.post("/zombrains/persist/killswitches", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const data = req.body;
  if (typeof data !== "object" || Array.isArray(data)) { res.status(400).json({ error: "body must be an object" }); return; }
  const KNOWN = new Set(["add_tool", "tool_verification", "code_verification", "verify_js"]);
  const clean: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(data)) {
    if (KNOWN.has(k) && typeof v === "boolean") clean[k] = v as boolean;
  }
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('persist_killswitches', ?)")
    .run(JSON.stringify({ switches: clean, storedAt: new Date().toISOString() }));
  db.close();
  res.json({ ok: true, stored: clean });
});

router.get("/zombrains/persist/killswitches", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const row = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'persist_killswitches'").get() as { value: string } | undefined;
  db.close();
  if (!row) { res.json(null); return; }
  try {
    const parsed = JSON.parse(row.value);
    res.json(parsed.switches ?? null);
  } catch { res.json(null); }
});

// ── GET /zombrains/dl-type-counts — dead-letter failure type counts ────────────
// Returns { ok, counts: { [typeKey]: number } }. Used by Railway to seed the local
// dead-letter-type-counts.json on fresh deploys so the feedback loop is never reset.
router.get("/zombrains/dl-type-counts", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const rows = db.prepare("SELECT type_key, count FROM zombrains_dl_type_counts").all() as Array<{ type_key: string; count: number }>;
  db.close();
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.type_key] = r.count;
  res.json({ ok: true, counts });
});

// ── POST /zombrains/dl-type-counts — upsert one failure type count ─────────────
// Called fire-and-forget from queue.js whenever a DL type count is updated.
router.post("/zombrains/dl-type-counts", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { typeKey, count } = req.body as { typeKey?: string; count?: number };
  if (!typeKey || typeof count !== "number") { res.status(400).json({ error: "typeKey and count required" }); return; }
  const db = getDb();
  db.prepare(`
    INSERT INTO zombrains_dl_type_counts (type_key, count, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(type_key) DO UPDATE SET count = excluded.count, updated_at = datetime('now')
  `).run(typeKey, count);
  db.close();
  res.json({ ok: true });
});

// ── POST /zombrains/persist/restart-log — bulk upsert restart log entries ──────
// Railway calls this on boot to back up existing /app/restart-log.json entries.
// INSERT OR IGNORE on timestamp avoids duplicates if the same session re-seeds.
router.post("/zombrains/persist/restart-log", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const entries = req.body as Array<{ timestamp?: string; uptime_ms?: number }>;
  if (!Array.isArray(entries)) { res.status(400).json({ error: "body must be an array" }); return; }
  const db = getDb();
  const stmt = db.prepare("INSERT OR IGNORE INTO zombrains_restart_log (timestamp, uptime_ms) VALUES (?, ?)");
  const insertMany = db.transaction((rows: Array<{ timestamp?: string; uptime_ms?: number }>) => {
    for (const e of rows) {
      if (typeof e.timestamp === "string")
        stmt.run(e.timestamp, typeof e.uptime_ms === "number" ? e.uptime_ms : null);
    }
  });
  insertMany(entries.slice(0, 50));
  db.close();
  res.json({ ok: true });
});

// ── GET /zombrains/persist/restart-log — fetch last 50 restart log entries ─────
// Railway fetches this on boot if /app/restart-log.json is missing (fresh deploy).
router.get("/zombrains/persist/restart-log", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const rows = db.prepare(
    "SELECT timestamp, uptime_ms FROM zombrains_restart_log ORDER BY timestamp DESC LIMIT 50"
  ).all() as Array<{ timestamp: string; uptime_ms: number | null }>;
  db.close();
  res.json({ ok: true, entries: rows.reverse() });
});

// ── GET /zombrains/routes — live Express route registry ───────────────────────
// Returns every route registered on this router right now — always live, never stale.
// ZomBrains calls this instead of trusting INFRA_LIBRARY.md when verifying an endpoint
// exists before calling it. Replaces the manually-maintained doc lookup.
router.get("/zombrains/routes", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const routes: Array<{ method: string; path: string }> = [];
  (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> })
    .stack.forEach(layer => {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          routes.push({ method: method.toUpperCase(), path: `/api${layer.route.path}` });
        }
      }
    });
  res.json({ ok: true, count: routes.length, routes });
});

// ── GET /zombrains/recent-work — last N Replit-side commits ───────────────────
// ZomBrains calls this at deep_think and generate_proposals to see what the Replit
// agent recently built — prevents proposing work that was just implemented.
// Returns { ok, commits: [{ hash, date, message }] }.
router.get("/zombrains/recent-work", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
    const raw = execSync(
      "git log --pretty=format:'%h|%ad|%s' --date=short -30 -- artifacts/ lib/ scripts/",
      { cwd: repoRoot, timeout: 8000, encoding: "utf8" }
    ).trim();
    const commits = raw ? raw.split("\n").map(line => {
      const [hash, date, ...rest] = line.split("|");
      return { hash, date, message: rest.join("|") };
    }) : [];
    res.json({ ok: true, count: commits.length, commits });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── GET /zombrains/journal — last N lines of builder-agent/JOURNAL.md ─────────
// ZomBrains writes one-line entries after every task. Call to see recent activity
// without reading the whole file. ?lines=N (default 80, max 300).
router.get("/zombrains/journal", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const n = Math.min(Number(req.query["lines"] ?? 80), 300);
    const journalPath = path.resolve(__dirname, "..", "..", "..", "..", "builder-agent", "JOURNAL.md");
    if (!fs.existsSync(journalPath)) { res.json({ ok: true, exists: false, lines: [] }); return; }
    const allLines = fs.readFileSync(journalPath, "utf8").split("\n");
    const last = allLines.slice(-n).filter(l => l.trim());
    res.json({ ok: true, exists: true, total: allLines.length, lines: last });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── GET /zombrains/idle-state ──────────────────────────────────────────────────
// Returns idle protocol state from the most recent T0 pulse. Feeds `pp zb cycle`
// and the admin panel idle tab. Data sourced from Railway's idle-protocol-state.json
// which gets bundled into every pulse POST (no extra Railway call required).
router.get("/zombrains/idle-state", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM zombrains_settings WHERE key='last_pulse_result'").get() as { value: string } | null;
    const pulse = row ? (() => { try { return JSON.parse(row.value); } catch { return null; } })() : null;
    if (!pulse) { res.json({ ok: false, reason: "no pulse received yet" }); return; }
    res.json({
      ok:                  true,
      receivedAt:          pulse.receivedAt ?? null,
      tier1CooldownMin:    pulse.tier1CooldownMin ?? null,
      tier2CooldownMin:    pulse.tier2CooldownMin ?? null,
      sprintBacklogCount:  pulse.sprintBacklogCount ?? null,
      deadLetterCount:     pulse.deadLetterCount ?? null,
      idleState:           pulse.idleState ?? null,
    });
  } finally { db.close(); }
});

// ── Persist: Logs ─────────────────────────────────────────────────────────────

router.post("/zombrains/persist/logs", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const logs = req.body;
  if (!Array.isArray(logs)) { res.status(400).json({ error: "body must be an array" }); return; }
  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO zombrains_logs (level, module, msg, detail, stack, ts) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertMany = db.transaction((entries: unknown[]) => {
    for (const e of entries) {
      const entry = e as { level?: string; module?: string; msg?: string; detail?: unknown; stack?: string; ts?: string };
      insert.run(
        entry.level ?? "INFO",
        entry.module ?? null,
        entry.msg ?? "",
        entry.detail != null ? (typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail)) : null,
        entry.stack ?? null,
        entry.ts ?? new Date().toISOString(),
      );
    }
  });
  insertMany(logs);
  db.close();
  res.json({ ok: true, inserted: logs.length });
});

router.get("/zombrains/persist/logs", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const limit = Math.min(Number(req.query["limit"] ?? 100), 500);
  const since = req.query["since"] as string | undefined;
  const db = getDb();
  const rows = since
    ? db.prepare("SELECT * FROM zombrains_logs WHERE ts > ? ORDER BY id DESC LIMIT ?").all(since, limit)
    : db.prepare("SELECT * FROM zombrains_logs ORDER BY id DESC LIMIT ?").all(limit);
  db.close();
  res.json((rows as unknown[]).reverse());
});

// ── Persist: Failure Log ─────────────────────────────────────────────────────

router.post("/zombrains/persist/failure-log", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { taskId, prompt, error, failureType, retryCount, history } = req.body as {
    taskId: string; prompt: string; error: string;
    failureType?: string; retryCount?: number; history?: unknown[];
  };
  if (!taskId || !prompt || !error) { res.status(400).json({ error: "taskId, prompt, error required" }); return; }
  const db = getDb();
  db.prepare(`INSERT INTO zombrains_failure_log (task_id, task_prompt, error_msg, failure_type, retry_count, history)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(taskId, prompt, error, failureType ?? "unknown", retryCount ?? 0,
         history ? JSON.stringify(history) : null);
  db.close();
  res.json({ ok: true });
});

router.get("/zombrains/persist/failure-log", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
  const db = getDb();
  const rows = db.prepare("SELECT * FROM zombrains_failure_log ORDER BY id DESC LIMIT ?").all(limit) as {
    id: number; task_id: string; task_prompt: string; error_msg: string;
    failure_type: string; retry_count: number; history: string | null; created_at: string;
  }[];
  db.close();
  res.json(rows.map(r => ({
    id:          r.id,
    taskId:      r.task_id,
    prompt:      r.task_prompt,
    error:       r.error_msg,
    failureType: r.failure_type,
    retryCount:  r.retry_count,
    history:     r.history ? (() => { try { return JSON.parse(r.history!); } catch { return []; } })() : [],
    createdAt:   r.created_at,
  })));
});

// ── Persist: Progress ─────────────────────────────────────────────────────────

router.get("/zombrains/persist/progress/:taskId", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { taskId } = req.params;
  const db = getDb();
  const row = db.prepare("SELECT * FROM zombrains_progress WHERE task_id = ?").get(taskId) as {
    task_id: string; history: string; step: number; work_dir: string | null; updated_at: string;
  } | undefined;
  db.close();
  if (!row) { res.status(404).json({ error: "No snapshot found" }); return; }
  try {
    res.json({ taskId: row.task_id, history: JSON.parse(row.history), step: row.step, workDir: row.work_dir, updatedAt: row.updated_at });
  } catch {
    res.status(500).json({ error: "Corrupt snapshot" });
  }
});

router.post("/zombrains/persist/progress/:taskId", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { taskId } = req.params;
  const { history, step, workDir } = req.body as { history: unknown[]; step: number; workDir?: string };
  if (!Array.isArray(history)) { res.status(400).json({ error: "history must be an array" }); return; }
  const db = getDb();
  db.prepare(`
    INSERT INTO zombrains_progress (task_id, history, step, work_dir, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(task_id) DO UPDATE SET history = excluded.history, step = excluded.step, work_dir = excluded.work_dir, updated_at = excluded.updated_at
  `).run(taskId, JSON.stringify(history), step ?? 0, workDir ?? null);
  db.close();
  res.json({ ok: true });
});

router.delete("/zombrains/persist/progress/:taskId", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { taskId } = req.params;
  const db = getDb();
  db.prepare("DELETE FROM zombrains_progress WHERE task_id = ?").run(taskId);
  db.close();
  res.json({ ok: true });
});

// ── Persist: Notes (key-value store for ZomBrains metadata) ──────────────────
// POST /zombrains/persist/notes  body: { key, value }
// Stores arbitrary string notes (e.g. complexity warnings) in zombrains_settings.

router.post("/zombrains/persist/notes", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { key, value } = req.body as { key?: string; value?: string };
  if (!key || typeof key !== "string") { res.status(400).json({ error: "key required" }); return; }
  const db = getDb();
  try {
    db.prepare(
      "INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES (?, ?)"
    ).run(`note_${key}`, String(value ?? ""));
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Generic blob persist ───────────────────────────────────────────────────────
// Key-value store for arbitrary JSON blobs. ZomBrains uses this to persist log
// files that would otherwise be wiped on every Railway container restart.
// Allowed keys: quality-log, diagnostics-log, attempt-ledger, system-health-log, tool-health
const PERSIST_BLOB_KEYS = new Set([
  "quality-log", "diagnostics-log", "attempt-ledger", "system-health-log", "tool-health", "heap-trend",
  "domain_backfill_v1", "failure_baseline_snapshot",
]);

router.get("/zombrains/persist/blob/:key", (req: Request, res: Response) => {
  const { key } = req.params as { key: string };
  if (!PERSIST_BLOB_KEYS.has(key)) { res.status(400).json({ error: "unknown key" }); return; }
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM zombrains_settings WHERE key=?").get(`persist_blob_${key}`) as { value: string } | undefined;
    if (!row) return res.json({ data: null });
    return res.json({ data: JSON.parse(row.value) });
  } catch { return res.json({ data: null }); }
  finally { db.close(); }
});

router.post("/zombrains/persist/blob/:key", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { key } = req.params as { key: string };
  if (!PERSIST_BLOB_KEYS.has(key)) { res.status(400).json({ error: "unknown key" }); return; }
  const { data } = req.body as { data?: unknown };
  if (data === undefined) { res.status(400).json({ error: "data required" }); return; }
  const db = getDb();
  try {
    db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES (?, ?)")
      .run(`persist_blob_${key}`, JSON.stringify(data));
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Session Crystal endpoints ─────────────────────────────────────────────────
// Five endpoints for ZomBrains' Crystalline Phase 1 session crystal storage.
// All use the existing `session_crystals` Monitor SQLite table.

// POST /zombrains/persist/session-crystal — store one crystal (success/failure/anti)
// 90-day TTL + 500-entry cap per executor enforced at write time.
router.post("/zombrains/persist/session-crystal", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { executor, interim, timestamp, content_hash, prev_hash, type, payload, domain, quality_gate, error_class } = req.body as {
    executor?: string; interim?: boolean; timestamp?: string; content_hash?: string;
    prev_hash?: string | null; type?: string; payload?: unknown;
    domain?: string | null; quality_gate?: number | null; error_class?: string | null;
  };
  if (!content_hash || payload === undefined) {
    res.status(400).json({ error: "content_hash and payload required" }); return;
  }
  const db = getDb();
  try {
    const exec         = executor ?? "zombrains";
    const crystalType  = type ?? "success";
    const payloadStr   = typeof payload === "string" ? payload : JSON.stringify(payload);

    // 90-day TTL prune
    db.prepare("DELETE FROM session_crystals WHERE executor = ? AND datetime(created_at) < datetime('now', '-90 days')").run(exec);

    // 500-entry cap per executor
    const { c } = db.prepare("SELECT COUNT(*) as c FROM session_crystals WHERE executor = ?").get(exec) as { c: number };
    if (c >= 500) {
      db.prepare(
        "DELETE FROM session_crystals WHERE id IN (SELECT id FROM session_crystals WHERE executor = ? ORDER BY id ASC LIMIT ?)"
      ).run(exec, c - 499);
    }

    db.prepare(`
      INSERT INTO session_crystals (executor, timestamp, interim, content_hash, prev_hash, type, payload, domain, quality_gate, error_class, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      exec,
      timestamp ?? new Date().toISOString(),
      interim ? 1 : 0,
      content_hash,
      prev_hash ?? null,
      crystalType,
      payloadStr,
      domain ?? null,
      quality_gate ?? 1,
      error_class ?? null,
    );
    // ── Crystal ledger fan-out (Task #620) — ingest into crystal_ledger on receipt ──
    try {
      const now = new Date().toISOString();
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(payloadStr) as Record<string, unknown>; } catch { /* ignore */ }
      const domain      = (p["domain"] as string | null) ?? null;
      const sourceType  = (p["source_type"] as string | null) ?? "session";
      const provider    = (p["provider"] as string | null) ?? null;
      const qualScore   = typeof p["quality_score"] === "number" ? p["quality_score"] : null;
      const tokenCount  = typeof p["token_count"] === "number"   ? p["token_count"]   : null;
      const latencyMs   = typeof p["latency_ms"]   === "number"  ? p["latency_ms"]    : null;
      const toolsUsed   = p["tools_used"] ? JSON.stringify(p["tools_used"]) : null;
      const persona     = (p["persona"] as string | null) ?? null;
      const taskId      = (p["task_id"] as string | null) ?? null;
      const tags        = JSON.stringify(Array.isArray(p["tags"]) ? p["tags"] : []);
      const info = db.prepare(`
        INSERT OR IGNORE INTO crystal_ledger (hash, type, domain, source_type, provider, quality_score, token_count, latency_ms, tools_used, persona, task_id, tags, activation_count, created_at, payload)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
      `).run(content_hash, crystalType, domain, sourceType, provider, qualScore, tokenCount, latencyMs, toolsUsed, persona, taskId, tags, now, payloadStr);
      if ((info as { changes: number }).changes > 0) {
        db.prepare("INSERT INTO crystal_events (event_type, crystal_hash, event_data, timestamp) VALUES ('created',?,?,?)").run(content_hash, JSON.stringify({ source: "session_crystal", executor: exec }), now);
      } else {
        db.prepare("UPDATE crystal_ledger SET activation_count = activation_count + 1, last_activated = ? WHERE hash = ?").run(now, content_hash);
        db.prepare("INSERT INTO crystal_events (event_type, crystal_hash, event_data, timestamp) VALUES ('activated',?,?,?)").run(content_hash, JSON.stringify({ activation_count: 1, executor: exec }), now);
      }
    } catch { /* non-fatal — session-crystal insert already succeeded */ }
    res.json({ ok: true });
  } finally { db.close(); }
});

// GET /zombrains/persist/session-crystals — query crystals with filters
// Query params: executor, since (ISO), interim (true/false), type (success/failure/anti), limit (max 100)
router.get("/zombrains/persist/session-crystals", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const exec    = (req.query["executor"] as string | undefined) ?? "zombrains";
  const since   = req.query["since"] as string | undefined;
  const interimQ = req.query["interim"] as string | undefined;
  const typeQ   = req.query["type"] as string | undefined;
  const limit   = Math.min(Number(req.query["limit"] ?? 20), 100);

  const db = getDb();
  try {
    const parts: string[] = ["SELECT * FROM session_crystals WHERE executor = ?"];
    const params: unknown[] = [exec];
    if (since)       { parts.push("AND datetime(created_at) > datetime(?)"); params.push(since); }
    if (interimQ !== undefined) { parts.push("AND interim = ?"); params.push(interimQ === "true" ? 1 : 0); }
    if (typeQ)       { parts.push("AND type = ?"); params.push(typeQ); }
    parts.push("ORDER BY id DESC LIMIT ?");
    params.push(limit);

    type CrystalRow = { id: number; executor: string; timestamp: string; interim: number; content_hash: string; prev_hash: string | null; type: string; payload: string; domain: string | null; quality_gate: number | null; error_class: string | null; created_at: string };
    const rows = db.prepare(parts.join(" ")).all(...params) as CrystalRow[];
    res.json({
      ok: true, count: rows.length,
      crystals: rows.map(r => ({
        id:          r.id,
        executor:    r.executor,
        timestamp:   r.timestamp,
        interim:     r.interim === 1,
        contentHash: r.content_hash,
        prevHash:    r.prev_hash,
        type:        r.type,
        payload:     (() => { try { return JSON.parse(r.payload); } catch { return r.payload; } })(),
        domain:      r.domain ?? null,
        qualityGate: r.quality_gate ?? 1,
        errorClass:  r.error_class ?? null,
        createdAt:   r.created_at,
      })),
    });
  } finally { db.close(); }
});

// GET /zombrains/crystal/meta — counts by type + last hash per executor + champion count per domain
// Also returns top-level failureCount, antiCount, count, lastHash, lastAt for the admin panel.
router.get("/zombrains/crystal/meta", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    type MetaRow = { executor: string; type: string; count: number; last_hash: string; last_at: string };
    const rows = db.prepare(`
      SELECT executor, type, COUNT(*) as count,
             MAX(content_hash) as last_hash, MAX(created_at) as last_at
      FROM session_crystals GROUP BY executor, type
    `).all() as MetaRow[];

    const meta: Record<string, { types: Record<string, { count: number; lastHash: string; lastAt: string }> }> = {};
    for (const r of rows) {
      if (!meta[r.executor]) meta[r.executor] = { types: {} };
      meta[r.executor].types[r.type] = { count: r.count, lastHash: r.last_hash, lastAt: r.last_at };
    }

    // Flat summary fields used by admin panel System tab
    const zbMeta = meta["zombrains"] ?? {};
    const successMeta = zbMeta.types?.["success"] ?? null;
    const topCount   = successMeta?.count   ?? 0;
    const topHash    = successMeta?.lastHash ?? null;
    const topAt      = successMeta?.lastAt   ?? null;

    // Failure crystal count + anti-crystal count (Task #450 tables)
    let failureCount = 0;
    let antiCount = 0;
    try {
      const fc = db.prepare("SELECT COUNT(*) as c FROM failure_crystals").get() as { c: number } | undefined;
      failureCount = fc?.c ?? 0;
    } catch { /* table may not exist on old deploys */ }
    try {
      const ac = db.prepare("SELECT COUNT(*) as c FROM anti_crystals WHERE datetime(created_at) > datetime('now', '-90 days')").get() as { c: number } | undefined;
      antiCount = ac?.c ?? 0;
    } catch { /* table may not exist on old deploys */ }

    // Champion count per domain from crystal_champions (Postgres)
    let champions: Record<string, { fitness: number; generation: number }> = {};
    try {
      const champRows = await pgDb
        .select({
          domain:     crystalChampionsTable.domain,
          fitness:    crystalChampionsTable.fitness,
          generation: crystalChampionsTable.generation,
        })
        .from(crystalChampionsTable);
      for (const c of champRows) {
        champions[c.domain] = { fitness: Number(c.fitness), generation: c.generation };
      }
    } catch (_) {
      // Non-fatal: champion data is informational only
    }

    res.json({
      ok: true,
      // Flat fields for admin panel
      count:        topCount,
      failureCount,
      antiCount,
      lastHash:     topHash,
      lastAt:       topAt,
      // Full breakdown for other consumers
      meta,
      champions,
    });
  } finally { db.close(); }
});

// GET /zombrains/crystal/diff — delta between two crystals by content_hash
// Query params: a (hash of older crystal), b (hash of newer crystal)
router.get("/zombrains/crystal/diff", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const hashA = req.query["a"] as string | undefined;
  const hashB = req.query["b"] as string | undefined;
  if (!hashA || !hashB) {
    res.status(400).json({ error: "query params a and b (content hashes) required" }); return;
  }
  const db = getDb();
  try {
    type HashRow = { payload: string; timestamp: string };
    const rowA = db.prepare("SELECT payload, timestamp FROM session_crystals WHERE content_hash = ? ORDER BY id DESC LIMIT 1").get(hashA) as HashRow | undefined;
    const rowB = db.prepare("SELECT payload, timestamp FROM session_crystals WHERE content_hash = ? ORDER BY id DESC LIMIT 1").get(hashB) as HashRow | undefined;
    if (!rowA || !rowB) { res.status(404).json({ error: "one or both crystal hashes not found" }); return; }

    const parse = (s: string) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } };
    const a = parse(rowA.payload);
    const b = parse(rowB.payload);

    const freqA = (a["taskTypeFrequency"] ?? {}) as Record<string, number>;
    const freqB = (b["taskTypeFrequency"] ?? {}) as Record<string, number>;
    const allTypes = new Set([...Object.keys(freqA), ...Object.keys(freqB)]);
    const freqDelta: Record<string, number> = {};
    for (const t of allTypes) freqDelta[t] = (freqB[t] ?? 0) - (freqA[t] ?? 0);

    res.json({
      ok: true, hashA, hashB,
      timestampA:              rowA.timestamp,
      timestampB:              rowB.timestamp,
      taskCountDelta:          ((b["tasks"] as unknown[] | undefined)?.length ?? 0) - ((a["tasks"] as unknown[] | undefined)?.length ?? 0),
      taskTypeFrequencyDelta:  freqDelta,
      versionA:                (a["zbVersion"] as string | null) ?? null,
      versionB:                (b["zbVersion"] as string | null) ?? null,
    });
  } finally { db.close(); }
});

// GET /zombrains/crystal/ci — Crystallization Index
// CI = ratio of task types covered by ≥3-instance success crystals over last N crystals.
// Query params: executor (default zombrains), n (default 10, max 50)
router.get("/zombrains/crystal/ci", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const exec  = (req.query["executor"] as string | undefined) ?? "zombrains";
  const n     = Math.min(Number(req.query["n"] ?? 10), 50);
  const db    = getDb();
  try {
    const rows = db.prepare(
      "SELECT payload FROM session_crystals WHERE executor = ? AND type = 'success' ORDER BY id DESC LIMIT ?"
    ).all(exec, n) as Array<{ payload: string }>;

    if (rows.length === 0) {
      res.json({ ok: true, executor: exec, ci: 0, coveredTypes: [], totalTypes: [], crystalCount: 0, message: "no success crystals found" }); return;
    }

    const coveredTypes  = new Set<string>();
    const totalTypes    = new Set<string>();
    for (const row of rows) {
      const p = (() => { try { return JSON.parse(row.payload) as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } })();
      const freq = (p["taskTypeFrequency"] ?? {}) as Record<string, number>;
      for (const [t, count] of Object.entries(freq)) {
        totalTypes.add(t);
        if (count >= 3) coveredTypes.add(t);
      }
    }

    const ci = totalTypes.size > 0 ? coveredTypes.size / totalTypes.size : 0;
    res.json({
      ok:           true,
      executor:     exec,
      ci:           Math.round(ci * 100) / 100,
      coveredTypes: [...coveredTypes],
      totalTypes:   [...totalTypes],
      crystalCount: rows.length,
    });
  } finally { db.close(); }
});

// ── Crystalline Phase 2: Specialists ─────────────────────────────────────────

// GET /zombrains/specialists — all compiled specialists
router.get('/specialists', (req, res) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const rows = db.prepare(`SELECT * FROM specialists ORDER BY
      CASE status WHEN 'protected' THEN 0 WHEN 'proven' THEN 1 WHEN 'active' THEN 2 WHEN 'candidate' THEN 3 WHEN 'ghost' THEN 4 ELSE 5 END,
      evidence_count DESC`).all() as Record<string, unknown>[];
    res.json({ specialists: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally { db.close(); }
});

// POST /zombrains/specialists — bulk upsert from Boot Compiler
router.post('/specialists', (req, res) => {
  if (!authCheck(req, res)) return;
  const { specialists } = (req.body ?? {}) as { specialists?: Record<string, unknown>[] };
  if (!Array.isArray(specialists) || specialists.length === 0) {
    res.status(400).json({ error: 'specialists array required' }); return;
  }
  const db = getDb();
  try {
    const stmt = db.prepare(`INSERT INTO specialists
      (specialist_id, task_type, version, status, confidence, evidence_count, failure_rate,
       execution_plan, causal_evidence, behavioral_state_hash, compiled_at, last_used_at, expiration_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(specialist_id) DO UPDATE SET
        task_type             = excluded.task_type,
        version               = excluded.version,
        confidence            = excluded.confidence,
        evidence_count        = excluded.evidence_count,
        failure_rate          = excluded.failure_rate,
        execution_plan        = excluded.execution_plan,
        causal_evidence       = excluded.causal_evidence,
        behavioral_state_hash = excluded.behavioral_state_hash,
        compiled_at           = excluded.compiled_at,
        expiration_date       = excluded.expiration_date`);
    let upserted = 0;
    const upsertAll = db.transaction(() => {
      for (const sp of specialists) {
        const id = (sp['specialistId'] ?? sp['specialist_id']) as string | undefined;
        if (!id) continue;
        stmt.run(
          id,
          (sp['taskType'] ?? sp['task_type'] ?? '') as string,
          Number(sp['version'] ?? 1),
          String(sp['status'] ?? 'ghost'),
          Number(sp['confidence'] ?? 0),
          Number(sp['evidenceCount'] ?? sp['evidence_count'] ?? 0),
          Number(sp['failureRate'] ?? sp['failure_rate'] ?? 0),
          JSON.stringify(sp['executionPlan'] ?? sp['execution_plan'] ?? []),
          JSON.stringify(sp['causalEvidence'] ?? sp['causal_evidence'] ?? {}),
          (sp['behavioralStateHash'] ?? sp['behavioral_state_hash'] ?? null) as string | null,
          (sp['compiledAt'] ?? sp['compiled_at'] ?? new Date().toISOString()) as string,
          (sp['lastUsedAt'] ?? sp['last_used_at'] ?? null) as string | null,
          (sp['expirationDate'] ?? sp['expiration_date'] ?? null) as string | null,
        );
        upserted++;
      }
    });
    upsertAll();
    res.json({ ok: true, upserted });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally { db.close(); }
});

// PATCH /zombrains/specialists/:specialistId/promote
router.patch('/specialists/:specialistId/promote', (req, res) => {
  if (!authCheck(req, res)) return;
  const { specialistId } = req.params;
  const db = getDb();
  try {
    const info = db.prepare(`UPDATE specialists SET status = 'active' WHERE specialist_id = ?`).run(specialistId);
    if (info.changes === 0) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ ok: true, specialistId, status: 'active' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally { db.close(); }
});

// PATCH /zombrains/specialists/:specialistId/demote
router.patch('/specialists/:specialistId/demote', (req, res) => {
  if (!authCheck(req, res)) return;
  const { specialistId } = req.params;
  const db = getDb();
  try {
    const info = db.prepare(`UPDATE specialists SET status = 'candidate' WHERE specialist_id = ?`).run(specialistId);
    if (info.changes === 0) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ ok: true, specialistId, status: 'candidate' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally { db.close(); }
});

// POST /zombrains/ghost-observations — record one ghost mode observation
router.post('/ghost-observations', (req, res) => {
  if (!authCheck(req, res)) return;
  const {
    specialist_id, task_id, task_type = '', specialist_plan = [],
    actual_outcome = 'unknown', failures = [], confidence = 0,
  } = (req.body ?? {}) as {
    specialist_id?: string; task_id?: string; task_type?: string;
    specialist_plan?: unknown[]; actual_outcome?: string;
    failures?: unknown[]; confidence?: number;
  };
  if (!specialist_id || !task_id) {
    res.status(400).json({ error: 'specialist_id and task_id required' }); return;
  }
  const db = getDb();
  try {
    db.prepare(`INSERT INTO ghost_observations
      (specialist_id, task_id, task_type, specialist_plan, actual_outcome, failures, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      specialist_id, task_id, task_type,
      JSON.stringify(specialist_plan), actual_outcome,
      JSON.stringify(failures), Number(confidence),
    );
    const { c } = db.prepare(`SELECT COUNT(*) as c FROM ghost_observations WHERE specialist_id = ?`)
      .get(specialist_id) as { c: number };
    res.json({ ok: true, observationCount: c });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally { db.close(); }
});

// GET /zombrains/ghost-observations/:specialistId
router.get('/ghost-observations/:specialistId', (req, res) => {
  if (!authCheck(req, res)) return;
  const { specialistId } = req.params;
  const db = getDb();
  try {
    const rows = db.prepare(
      `SELECT * FROM ghost_observations WHERE specialist_id = ? ORDER BY created_at DESC LIMIT 100`
    ).all(specialistId) as Record<string, unknown>[];
    res.json({ observations: rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally { db.close(); }
});

// ── POST /zombrains/specialists/invalidate ────────────────────────────────────
// Phase 4: Trigger specialist re-validation on environment change (TOOLS_GUIDE.md
// mtime, schema migration, OWNER_RULES update). Marks matching specialists back
// to Ghost Mode for 3-task re-validation. Protected-tier protection suspended.
// Body: { reason: string, affectedPatterns?: string[] }
router.post('/specialists/invalidate', (req, res) => {
  if (!authCheck(req, res)) return;
  const { reason, affectedPatterns } = req.body as { reason?: string; affectedPatterns?: string[] };
  if (!reason) { res.status(400).json({ error: 'reason required' }); return; }
  const db = getDb();
  try {
    // Lazy migrations — idempotent, add columns if absent
    try { db.prepare('ALTER TABLE specialists ADD COLUMN invalidated_at TEXT').run(); } catch (_) {}
    try { db.prepare('ALTER TABLE specialists ADD COLUMN last_invalidation_reason TEXT').run(); } catch (_) {}

    let invalidated = 0;
    const now = new Date().toISOString();

    if (!affectedPatterns || affectedPatterns.length === 0) {
      // Invalidate all non-ghost specialists
      const result = db.prepare(
        `UPDATE specialists SET status='ghost', ghost_observations_count=0, invalidated_at=?, last_invalidation_reason=? WHERE status != 'ghost'`
      ).run(now, reason.slice(0, 500));
      invalidated = result.changes;
    } else {
      // Invalidate specialists whose task_type matches any affectedPattern
      for (const pattern of affectedPatterns) {
        const result = db.prepare(
          `UPDATE specialists SET status='ghost', ghost_observations_count=0, invalidated_at=?, last_invalidation_reason=? WHERE task_type LIKE ? AND status != 'ghost'`
        ).run(now, reason.slice(0, 500), `%${pattern}%`);
        invalidated += result.changes;
      }
    }

    console.log(`[specialists] Invalidated ${invalidated} specialist(s): ${reason.slice(0, 80)}`);
    res.json({ ok: true, invalidated, reason });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally { db.close(); }
});

// ── POST /zombrains/data-push — receive Volume snapshot from ZomBrains ────────
// ZomBrains calls this after every boot (and on demand via push_data_to_replit
// tool) to land empirical live data into .agents/memory/ so the planning agent
// always has fresh, real values without token-burning LLM calls.
// Sections written: crystals, baseline, specialists, tokens, volumeIndex.
// Each becomes .agents/memory/zb-live-data-<section>.md.
router.post("/zombrains/data-push", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const body = req.body ?? {};
  const received = new Date().toISOString();
  const sections: string[] = [];
  const recordCounts: Record<string, number> = {};

  const memDir = path.join(REPLIT_FILE_WORKSPACE_ROOT, ".agents", "memory");
  try { fs.mkdirSync(memDir, { recursive: true }); } catch (_) {}

  function writeSection(name: string, data: unknown) {
    if (data === undefined || data === null) return;
    try {
      let content = `# ZomBrains Live Data — ${name}\n_Updated: ${received}_\n\n`;
      if (Array.isArray(data)) {
        content += `**Count:** ${(data as unknown[]).length}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
        recordCounts[name] = (data as unknown[]).length;
      } else {
        content += `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
        recordCounts[name] = 1;
      }
      fs.writeFileSync(path.join(memDir, `zb-live-data-${name}.md`), content, "utf8");
      sections.push(name);
    } catch (_) {}
  }

  writeSection("crystals",     body.crystals);
  writeSection("baseline",     body.baseline);
  writeSection("specialists",  body.specialists);
  writeSection("tokens",       body.tokens);
  writeSection("volumeIndex",  body.volumeIndex);

  res.json({ received, sections, recordCounts });
});

// ── POST /zombrains/idle/task-logged ──────────────────────────────────────────
// Called fire-and-forget by idleProtocol.js after each idle task is queued.
// Writes to the idle_task_log ring buffer (30-day TTL, 2000-row cap).
router.post("/zombrains/idle/task-logged", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { type, taskDomain, timestamp } = req.body as { type?: string; taskDomain?: string; timestamp?: string };
  if (!type) { res.status(400).json({ error: "type required" }); return; }
  const db = getDb();
  try {
    db.prepare("DELETE FROM idle_task_log WHERE created_at < datetime('now', '-30 days')").run();
    const { c } = db.prepare("SELECT COUNT(*) as c FROM idle_task_log").get() as { c: number };
    if (c >= 2000) {
      db.prepare("DELETE FROM idle_task_log WHERE id IN (SELECT id FROM idle_task_log ORDER BY id ASC LIMIT ?)").run(c - 1999);
    }
    db.prepare("INSERT INTO idle_task_log (type, task_domain, ts) VALUES (?, ?, ?)").run(
      type,
      taskDomain || type,
      timestamp ?? new Date().toISOString(),
    );
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── GET /zombrains/idle/distribution ─────────────────────────────────────────
// Returns last-7d task type frequency counts from the idle_task_log ring buffer.
// Enriches each row with crystalPct: the share of success crystals for that domain.
router.get("/zombrains/idle/distribution", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const rows = db.prepare(
      `SELECT task_domain AS taskDomain, COUNT(*) AS count
       FROM idle_task_log
       WHERE created_at >= datetime('now', '-7 days')
       GROUP BY task_domain
       ORDER BY count DESC`
    ).all() as { taskDomain: string; count: number }[];

    // Crystal enrichment: count domain occurrences from two sources.
    // 1. Crystals with taskDomain at root level (individual task crystals, dead-letters).
    // 2. Crystals whose payload has a tasks[] array (session crystallizer output) —
    //    each entry in tasks[] has its own taskDomain; unnest with json_each.
    const crystalRows = db.prepare(
      `SELECT domain, SUM(cnt) AS count FROM (
         SELECT COALESCE(
             json_extract(payload, '$.taskDomain'),
             json_extract(payload, '$.taskType'),
             json_extract(payload, '$.type')
           ) AS domain, COUNT(*) AS cnt
           FROM session_crystals
           WHERE type = 'success' AND executor = 'zombrains'
             AND created_at >= datetime('now', '-7 days')
             AND json_extract(payload, '$.taskDomain') IS NOT NULL
           GROUP BY domain
         UNION ALL
         SELECT json_extract(j.value, '$.taskDomain') AS domain, COUNT(*) AS cnt
           FROM session_crystals, json_each(session_crystals.payload, '$.tasks') AS j
           WHERE session_crystals.type = 'success' AND session_crystals.executor = 'zombrains'
             AND session_crystals.created_at >= datetime('now', '-7 days')
             AND json_extract(j.value, '$.taskDomain') IS NOT NULL
           GROUP BY domain
       ) WHERE domain IS NOT NULL GROUP BY domain`
    ).all() as { domain: string; count: number }[];

    const totalCrystals = crystalRows.reduce((s, r) => s + r.count, 0);
    const crystalMap: Record<string, number> = {};
    for (const cr of crystalRows) { if (cr.domain) crystalMap[cr.domain] = cr.count; }

    const enriched = rows.map(r => ({
      ...r,
      crystalPct: totalCrystals > 0
        ? Math.round(((crystalMap[r.taskDomain] || 0) / totalCrystals) * 100)
        : null,
    }));
    res.json({ ok: true, rows: enriched, totalCrystals, windowDays: 7 });
  } finally { db.close(); }
});

// ── Persist: Worker outcome log ───────────────────────────────────────────────
// Poopy and Birthday Bot fire-and-forget POST here after every specialist step.
// Ring buffer: 1000 rows per executor, 30-day TTL enforced on each write.

router.post("/zombrains/persist/worker-outcome", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { executor, taskType, taskDomain, outcome, latencyMs, provider, failureReason } = req.body as {
    executor?: string;
    taskType?: string;
    taskDomain?: string;
    outcome?: string;
    latencyMs?: number;
    provider?: string;
    failureReason?: string;
  };
  if (!executor || !outcome) { res.status(400).json({ error: "executor and outcome required" }); return; }
  if (outcome !== "completed" && outcome !== "failed") {
    res.status(400).json({ error: "outcome must be 'completed' or 'failed'" }); return;
  }
  const db = getDb();
  try {
    db.prepare("DELETE FROM worker_outcome_log WHERE logged_at < datetime('now', '-30 days')").run();
    db.prepare(`
      INSERT INTO worker_outcome_log (executor, task_type, task_domain, outcome, latency_ms, provider, failure_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(executor, taskType ?? null, taskDomain ?? null, outcome, typeof latencyMs === "number" ? latencyMs : null, provider ?? null, failureReason ?? null);
    db.prepare(`
      DELETE FROM worker_outcome_log
      WHERE executor = ? AND id NOT IN (
        SELECT id FROM worker_outcome_log WHERE executor = ? ORDER BY id DESC LIMIT 1000
      )
    `).run(executor, executor);
    res.json({ ok: true });
  } finally { db.close(); }
});

router.get("/zombrains/persist/worker-outcomes", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const executor = req.query["executor"] as string | undefined;
  const windowParam = (req.query["window"] as string | undefined) ?? "7d";
  const windowMatch = windowParam.match(/^(\d+)d$/);
  const windowDays = windowMatch ? parseInt(windowMatch[1], 10) : 7;
  type OutcomeRow = {
    executor: string; taskType: string; total: number;
    completed: number; failed: number;
    successRate: number | null; avgLatencyMs: number | null;
  };
  const db = getDb();
  try {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const sql = `
      SELECT
        executor,
        COALESCE(task_type, 'unknown') AS taskType,
        COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN outcome = 'failed'    THEN 1 ELSE 0 END) AS failed,
        ROUND(100.0 * SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) / COUNT(*), 1) AS successRate,
        ROUND(AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END), 0) AS avgLatencyMs
      FROM worker_outcome_log
      WHERE logged_at >= ?${executor ? " AND executor = ?" : ""}
      GROUP BY executor, COALESCE(task_type, 'unknown')
      ORDER BY executor, total DESC
    `;
    const rows = (executor
      ? db.prepare(sql).all(cutoff, executor)
      : db.prepare(sql).all(cutoff)) as OutcomeRow[];
    res.json({ ok: true, since: cutoff, windowDays, rows });
  } finally { db.close(); }
});

// ── Failure Crystals (Task #450) ──────────────────────────────────────────────
// Stores recurring dead-letter error patterns with deduplication by errorSignature.
// Ring buffer: 90-day TTL, 500-entry cap. Returns count >= 2 entries sorted by frequency.

router.post("/zombrains/persist/failure-crystal", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { pattern, taskDomain, failureType, provider, errorSignature, count } = req.body as {
    pattern?: string; taskDomain?: string; failureType?: string;
    provider?: string; errorSignature?: string; count?: number;
  };
  if (!errorSignature) { res.status(400).json({ error: "errorSignature required" }); return; }
  const db = getDb();
  try {
    // 90-day TTL prune
    db.prepare("DELETE FROM failure_crystals WHERE datetime(created_at) < datetime('now', '-90 days')").run();
    // 500-entry cap — evict oldest-seen first
    const { c } = db.prepare("SELECT COUNT(*) as c FROM failure_crystals").get() as { c: number };
    if (c >= 500) {
      db.prepare("DELETE FROM failure_crystals WHERE id IN (SELECT id FROM failure_crystals ORDER BY last_seen ASC LIMIT ?)").run(c - 499);
    }
    // Dedup: same errorSignature within 24h → update count + lastSeen
    const existing = db.prepare(
      "SELECT id, count FROM failure_crystals WHERE error_signature = ? AND datetime(last_seen) > datetime('now', '-24 hours')"
    ).get(errorSignature) as { id: number; count: number } | undefined;
    if (existing) {
      db.prepare("UPDATE failure_crystals SET count = ?, last_seen = datetime('now') WHERE id = ?")
        .run((existing.count || 0) + (typeof count === "number" ? count : 1), existing.id);
    } else {
      db.prepare(`
        INSERT OR REPLACE INTO failure_crystals
          (error_signature, pattern, task_domain, failure_type, provider, count, last_seen, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        errorSignature,
        pattern ?? "",
        taskDomain ?? "general",
        failureType ?? "unknown",
        provider ?? "unknown",
        typeof count === "number" ? count : 1,
      );
    }
    res.json({ ok: true });
  } finally { db.close(); }
});

router.get("/zombrains/persist/failure-crystals", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    type FCRow = {
      id: number; error_signature: string; pattern: string; task_domain: string;
      failure_type: string; provider: string; count: number; last_seen: string; created_at: string;
    };
    const rows = db.prepare(
      "SELECT * FROM failure_crystals WHERE count >= 2 ORDER BY count DESC, last_seen DESC LIMIT 200"
    ).all() as FCRow[];
    res.json({
      ok: true, count: rows.length,
      crystals: rows.map(r => ({
        id: r.id, errorSignature: r.error_signature, pattern: r.pattern,
        taskDomain: r.task_domain, failureType: r.failure_type, provider: r.provider,
        count: r.count, lastSeen: r.last_seen, createdAt: r.created_at,
      })),
    });
  } finally { db.close(); }
});

// ── Anti-Crystals (Task #450) ─────────────────────────────────────────────────
// Tracks known-bad patterns to prevent Boot Compiler from re-synthesizing specialists
// that consistently fail. Written when persistent error patterns have no recent successes.

router.post("/zombrains/persist/anti-crystal", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { pattern, taskDomain, suspendReason, failureCount, qualityScoreAvg } = req.body as {
    pattern?: string; taskDomain?: string; suspendReason?: string;
    failureCount?: number; qualityScoreAvg?: number;
  };
  if (!pattern) { res.status(400).json({ error: "pattern required" }); return; }
  const db = getDb();
  try {
    // 90-day TTL prune
    db.prepare("DELETE FROM anti_crystals WHERE datetime(created_at) < datetime('now', '-90 days')").run();
    // 500-entry cap
    const { c } = db.prepare("SELECT COUNT(*) as c FROM anti_crystals").get() as { c: number };
    if (c >= 500) {
      db.prepare("DELETE FROM anti_crystals WHERE id IN (SELECT id FROM anti_crystals ORDER BY created_at ASC LIMIT ?)").run(c - 499);
    }
    db.prepare(`
      INSERT INTO anti_crystals
        (pattern, task_domain, suspended_at, suspend_reason, failure_count, quality_score_avg, created_at)
      VALUES (?, ?, datetime('now'), ?, ?, ?, datetime('now'))
    `).run(
      pattern,
      taskDomain ?? "general",
      suspendReason ?? "persistent_error_pattern",
      typeof failureCount === "number" ? failureCount : 1,
      typeof qualityScoreAvg === "number" ? qualityScoreAvg : null,
    );
    res.json({ ok: true });
  } finally { db.close(); }
});

router.get("/zombrains/persist/anti-crystals", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    type ACRow = {
      id: number; pattern: string; task_domain: string; suspended_at: string;
      suspend_reason: string; failure_count: number; quality_score_avg: number | null; created_at: string;
    };
    // Active = created within last 90 days
    const rows = db.prepare(
      "SELECT * FROM anti_crystals WHERE datetime(created_at) > datetime('now', '-90 days') ORDER BY failure_count DESC, created_at DESC LIMIT 200"
    ).all() as ACRow[];
    res.json({
      ok: true, count: rows.length,
      exclusions: rows.map(r => ({
        id: r.id, pattern: r.pattern, taskDomain: r.task_domain,
        suspendedAt: r.suspended_at, suspendReason: r.suspend_reason,
        failureCount: r.failure_count, qualityScoreAvg: r.quality_score_avg,
        createdAt: r.created_at,
      })),
    });
  } finally { db.close(); }
});

// ── GET /zombrains/persist/crystal-diff — Jaccard diff between two crystals ──
// Query params: from=<hash> (older), to=<hash> (newer)
// Returns { newPatterns[], stablePatterns[], droppedPatterns[], changedCount }
// Pattern comparison uses Jaccard similarity on task type word sets (< 0.6 = changed).
router.get("/zombrains/persist/crystal-diff", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const hashFrom = req.query["from"] as string | undefined;
  const hashTo   = req.query["to"]   as string | undefined;
  if (!hashFrom || !hashTo) {
    res.status(400).json({ error: "query params 'from' and 'to' (content hashes) required" }); return;
  }
  const db = getDb();
  try {
    type HashRow = { payload: string; timestamp: string };
    const rowA = db.prepare("SELECT payload, timestamp FROM session_crystals WHERE content_hash = ? ORDER BY id DESC LIMIT 1").get(hashFrom) as HashRow | undefined;
    const rowB = db.prepare("SELECT payload, timestamp FROM session_crystals WHERE content_hash = ? ORDER BY id DESC LIMIT 1").get(hashTo)   as HashRow | undefined;
    if (!rowA || !rowB) { res.status(404).json({ error: "one or both crystal hashes not found" }); return; }

    const parse = (s: string): Record<string, unknown> => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } };
    const a = parse(rowA.payload);
    const b = parse(rowB.payload);

    // Collect task type sets from tasks[] and taskTypeFrequency
    function getTypes(crystal: Record<string, unknown>): Set<string> {
      const types = new Set<string>();
      const freq = (crystal["taskTypeFrequency"] ?? {}) as Record<string, number>;
      for (const t of Object.keys(freq)) if (t) types.add(t);
      const tasks = Array.isArray(crystal["tasks"]) ? crystal["tasks"] as Record<string, unknown>[] : [];
      for (const t of tasks) {
        const td = (t["taskDomain"] as string | null) ?? (t["type"] as string | null);
        if (td) types.add(td);
      }
      return types;
    }

    // Jaccard similarity: intersection / union of word sets from a type string
    function wordSet(t: string): Set<string> {
      return new Set(t.toLowerCase().replace(/[_\-]/g, " ").split(/\s+/).filter(Boolean));
    }
    function jaccard(a: Set<string>, b: Set<string>): number {
      const intersection = [...a].filter(x => b.has(x)).length;
      const union = new Set([...a, ...b]).size;
      return union === 0 ? 1 : intersection / union;
    }

    const typesA = getTypes(a);
    const typesB = getTypes(b);

    const newPatterns:     string[] = [];
    const stablePatterns:  string[] = [];
    const droppedPatterns: string[] = [];
    let   changedCount = 0;

    for (const t of typesB) {
      if (!typesA.has(t)) { newPatterns.push(t); }
      else {
        const sim = jaccard(wordSet(t), wordSet(t)); // same type name = check cross-crystal data shape similarity
        // If the type exists in both, compute similarity of the type's word tokens vs closest match in A
        // (For same-name types, similarity is 1.0; for near-matches use closest in A)
        const closestSim = jaccard(wordSet(t), wordSet([...typesA].find(a => a === t) ?? t));
        if (closestSim >= 0.6) stablePatterns.push(t);
        else { changedCount++; }
      }
    }
    for (const t of typesA) {
      if (!typesB.has(t)) droppedPatterns.push(t);
    }
    // Cross-check: types in both with different naming => changedCount via best-match Jaccard
    for (const ta of typesA) {
      if (typesB.has(ta)) continue; // handled above
      const best = Math.max(...[...typesB].map(tb => jaccard(wordSet(ta), wordSet(tb))), 0);
      if (best >= 0.4 && best < 0.6) changedCount++;
    }

    res.json({
      ok:              true,
      fromHash:        hashFrom,
      toHash:          hashTo,
      timestampFrom:   rowA.timestamp,
      timestampTo:     rowB.timestamp,
      newPatterns,
      stablePatterns,
      droppedPatterns,
      changedCount,
      summary: `${newPatterns.length} new, ${stablePatterns.length} stable, ${droppedPatterns.length} dropped, ${changedCount} changed`,
    });
  } finally { db.close(); }
});

// ── GET /zombrains/persist/crystal-trust — trust score for a task domain ──────
// Query param: taskDomain=<domain>
// Returns { trustScore: 0-100, sampleTasks, avgQuality, crystalCount, recommendation }
// Thresholds for 'auto-approve': avgQuality >= 90, sampleTasks >= 20, crystalCount >= 5.
// All three must be met — any shortfall returns 'review' (safe default).
router.get("/zombrains/persist/crystal-trust", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const taskDomain = (req.query["taskDomain"] as string | undefined)?.trim();
  if (!taskDomain) { res.status(400).json({ error: "taskDomain query param required" }); return; }

  const db = getDb();
  try {
    type CrystalRow = { payload: string };
    const rows = db.prepare(
      "SELECT payload FROM session_crystals WHERE executor = 'zombrains' AND type = 'success' ORDER BY id DESC LIMIT 100"
    ).all() as CrystalRow[];

    let sampleTasks  = 0;
    let crystalCount = 0;
    let qualitySum   = 0;

    for (const row of rows) {
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
      const tasks = Array.isArray(payload["tasks"]) ? payload["tasks"] as Record<string, unknown>[] : [];
      const matching = tasks.filter(t => {
        const td = (t["taskDomain"] as string | null) ?? (t["type"] as string | null);
        return td === taskDomain;
      });
      if (matching.length > 0) {
        crystalCount++;
        for (const t of matching) {
          const qs = typeof t["qualityScore"] === "number" ? t["qualityScore"] : null;
          if (qs !== null) { qualitySum += qs; sampleTasks++; }
        }
      }
    }

    const avgQuality    = sampleTasks > 0 ? Math.round((qualitySum / sampleTasks) * 10) / 10 : 0;
    const meetsQuality  = avgQuality  >= 90;
    const meetsSamples  = sampleTasks >= 20;
    const meetsCrystals = crystalCount >= 5;
    const recommendation: "auto-approve" | "review" = (meetsQuality && meetsSamples && meetsCrystals)
      ? "auto-approve"
      : "review";

    // Trust score: 0-100 weighted composite
    const qScore = Math.min(avgQuality / 100, 1) * 40;
    const sScore = Math.min(sampleTasks / 30, 1) * 35;
    const cScore = Math.min(crystalCount / 8, 1) * 25;
    const trustScore = Math.round(qScore + sScore + cScore);

    res.json({
      ok: true, taskDomain, trustScore, sampleTasks, avgQuality, crystalCount,
      recommendation,
      thresholds: { avgQuality: 90, sampleTasks: 20, crystalCount: 5 },
      met: { avgQuality: meetsQuality, sampleTasks: meetsSamples, crystalCount: meetsCrystals },
    });
  } finally { db.close(); }
});

// ── Provider failure rates (Task #450) ───────────────────────────────────────
// Aggregates failure crystals by provider + taskDomain.
// Returns { [provider]: { [taskDomain]: { failureRate, sampleCount } } }
// Only returns entries with sampleCount >= 3 (meaningful signal).

router.get("/zombrains/persist/provider-failure-rates", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    type RateRow = { provider: string; task_domain: string; total_count: number };
    const rows = db.prepare(`
      SELECT provider, task_domain, SUM(count) AS total_count
      FROM failure_crystals
      WHERE provider != 'unknown'
      GROUP BY provider, task_domain
      HAVING SUM(count) >= 3
    `).all() as RateRow[];

    const rates: Record<string, Record<string, { failureRate: number; sampleCount: number }>> = {};
    for (const r of rows) {
      if (!rates[r.provider]) rates[r.provider] = {};
      // All entries in failure_crystals are failures — failureRate = 1.0 by definition.
      // sampleCount is the signal: >= 3 means a recurring pattern worth penalizing.
      rates[r.provider][r.task_domain] = { failureRate: 1.0, sampleCount: r.total_count };
    }
    res.json({ ok: true, rates });
  } finally { db.close(); }
});

export default router;

