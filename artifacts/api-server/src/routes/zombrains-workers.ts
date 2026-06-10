import { Router, type IRouter, type Request, type Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { callProviderAgentic, type Msg } from "../lib/providers.js";
import { listTools, registerTool as clusterRegisterTool, removeTool as clusterRemoveTool } from "../lib/clusterTools.js";
import { db, workerRegistryLogTable, workerStepEventsTable, eq, desc, sql } from "@workspace/db";
import {
  getDb, DB_PATH,
  type LibraryRow, addStalenessWarning,
  authCheck, strictAuthCheck, readonlyAuthCheck,
  askState, MAX_CONCURRENT_ASK, channelContext,
} from "./zombrains-shared.js";

const router: IRouter = Router();

// ── Worker registry ────────────────────────────────────────────────────────────
// Lightweight in-memory registry for external worker processes (api-worker-bot etc.)
// Workers register on startup and send heartbeats every 60s.
// Entries expire after 2 min with no heartbeat (worker assumed dead/restarting).

type WorkerEntry = {
  executor:       string;
  pid:            number;
  version:        string;
  registeredAt:   number;   // epoch ms (internal)
  lastHeartbeat:  number;   // epoch ms (internal)
};

// Enriched shape returned to callers (admin panel, ZomBrains)
type LiveWorkerEntry = {
  executor:       string;
  pid:            number;
  version:        string;
  registeredAt:   string;   // ISO string
  lastHeartbeat:  string;   // ISO string
  ageMs:          number;   // ms since lastHeartbeat
  ttlMs:          number;   // registry TTL constant
  alive:          boolean;  // lastHeartbeat within TTL
};

const _workerRegistry = new Map<string, WorkerEntry>();
const WORKER_TTL_MS   = 2 * 60 * 1000; // 2 minutes

// ── Prompt codec compression ──────────────────────────────────────────────────
// Compresses tool names in step prompts before returning them to worker bots,
// using the same prompt_index codec table that ZomBrains already uses on Railway.
// Cache is refreshed every 5 min to pick up new entries without a restart.
let _codecRows: { code: string; full_name: string }[] | null = null;
let _codecLoadedAt = 0;
const CODEC_CACHE_TTL_MS = 5 * 60 * 1000;

function getCodecRows(): { code: string; full_name: string }[] {
  const now = Date.now();
  if (_codecRows && now - _codecLoadedAt < CODEC_CACHE_TTL_MS) return _codecRows;
  const localDb = getDb();
  try {
    // Sort by full_name length DESC so longer names are replaced first
    // (prevents partial replacements like "read_file" clobbering "read_file_content")
    _codecRows = localDb.prepare(
      `SELECT code, full_name FROM prompt_index
       WHERE (deprecated IS NULL OR deprecated = 0)
       ORDER BY length(full_name) DESC`
    ).all() as { code: string; full_name: string }[];
    _codecLoadedAt = now;
    return _codecRows;
  } catch { return []; }
  finally { localDb.close(); }
}

function compressForWorker(prompt: string): string {
  const rows = getCodecRows();
  if (rows.length === 0) return prompt;
  let result = prompt;
  for (const { code, full_name } of rows) {
    result = result.split(full_name).join(code);
  }
  return result;
}

// ── Cross-cluster step dedup ring buffer ──────────────────────────────────────
// Caches outputs from recently completed worker steps. Before executing a step,
// we check if an incoming prompt is ≥75% Jaccard-similar to a recent one and
// return the cached output directly — saving an AI call and reducing quota usage.
const STEP_CACHE_MAX          = 50;
const STEP_CACHE_SIM_THRESHOLD = 0.75;

type StepCacheEntry = {
  words:    Set<string>;
  output:   string;
  cachedAt: number;
};

const _stepCache: StepCacheEntry[] = [];

function promptWordSet(prompt: string): Set<string> {
  return new Set(
    prompt.toLowerCase().replace(/[^a-z0-9\s_]/g, " ")
      .split(/\s+/).filter(w => w.length > 2)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function stepCacheLookup(prompt: string): string | null {
  const words = promptWordSet(prompt);
  for (const entry of _stepCache) {
    if (jaccardSimilarity(words, entry.words) >= STEP_CACHE_SIM_THRESHOLD) {
      return entry.output;
    }
  }
  return null;
}

function stepCacheStore(prompt: string, output: string): void {
  if (!output) return;
  const words = promptWordSet(prompt);
  if (_stepCache.length >= STEP_CACHE_MAX) _stepCache.shift();
  _stepCache.push({ words, output, cachedAt: Date.now() });
}

// Mirror the worker-side {{stepState.N}} resolution so the cache fingerprint
// uses the actual runtime content, not the template. Both GET and step-complete
// call this with the stepState snapshot that existed *before* the current step
// completes, matching what the worker resolved when it executed the step.
function resolveWorkerPrompt(prompt: string, stepState: Record<number, unknown>): string {
  return (prompt ?? "").replace(/\{\{stepState\.(\d+)\}\}/g, (_: string, i: string) => {
    const val = stepState[parseInt(i, 10)] ?? "";
    const s   = typeof val === "string" ? val : JSON.stringify(val);
    return s.slice(0, 500);
  });
}

// NOTE: api-server does NOT self-register as a worker. The api_worker_cluster_enabled
// flag controls whether api-* proxy slots are available, but there is no polling
// worker process for api-worker — real workers (Poopy, Birthday Bot) register via
// POST /worker/register on boot. Fake registry presence would fool delegate_to_worker
// into queuing steps that nothing ever claims.

function getLiveWorkers(): LiveWorkerEntry[] {
  const now    = Date.now();
  const cutoff = now - WORKER_TTL_MS;
  const live: LiveWorkerEntry[] = [];
  for (const [, entry] of _workerRegistry) {
    const ageMs = now - entry.lastHeartbeat;
    if (entry.lastHeartbeat >= cutoff) {
      live.push({
        executor:      entry.executor,
        pid:           entry.pid,
        version:       entry.version,
        registeredAt:  new Date(entry.registeredAt).toISOString(),
        lastHeartbeat: new Date(entry.lastHeartbeat).toISOString(),
        ageMs,
        ttlMs:         WORKER_TTL_MS,
        alive:         true,
      });
    }
  }
  return live;
}

// Returns ALL registered workers with alive:true/false — used by registry endpoint
// so the admin panel and ZomBrains can see recently-offline workers, not just live ones.
function getAllWorkers(): LiveWorkerEntry[] {
  const now = Date.now();
  return Array.from(_workerRegistry.values()).map(entry => {
    const ageMs = now - entry.lastHeartbeat;
    return {
      executor:      entry.executor,
      pid:           entry.pid,
      version:       entry.version,
      registeredAt:  new Date(entry.registeredAt).toISOString(),
      lastHeartbeat: new Date(entry.lastHeartbeat).toISOString(),
      ageMs,
      ttlMs:         WORKER_TTL_MS,
      alive:         ageMs <= WORKER_TTL_MS,
    };
  });
}

// POST /api/zombrains/worker/register
// Called by worker on startup. Body: { executor, pid, version? }
router.post("/zombrains/worker/register", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { executor, pid, version } = req.body as {
    executor?: string; pid?: number; version?: string;
  };
  if (!executor) {
    res.status(400).json({ ok: false, error: "executor required" });
    return;
  }
  const now   = Date.now();
  const entry: WorkerEntry = {
    executor,
    pid:           pid ?? 0,
    version:       version ?? "unknown",
    registeredAt:  now,
    lastHeartbeat: now,
  };
  _workerRegistry.set(executor, entry);

  // Log register event to Postgres (fire-and-forget)
  db.insert(workerRegistryLogTable).values({
    executor,
    event_type: "register",
    pid:        pid ?? null,
    version:    version ?? null,
  }).then(() => {
    // Ring-buffer: keep last 500 rows
    return db.execute(sql`DELETE FROM worker_registry_log WHERE id IN (SELECT id FROM worker_registry_log ORDER BY ts ASC LIMIT GREATEST(0, (SELECT COUNT(*) FROM worker_registry_log) - 500))`);
  }).catch(() => { /* non-fatal */ });

  res.json({ ok: true, executor, registeredAt: new Date(now).toISOString() });
});

// POST /api/zombrains/worker/heartbeat
// Called every 60s by live workers. Body: { executor }
router.post("/zombrains/worker/heartbeat", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { executor } = req.body as { executor?: string };
  if (!executor) {
    res.status(400).json({ ok: false, error: "executor required" });
    return;
  }
  const entry = _workerRegistry.get(executor);
  if (!entry) {
    res.status(404).json({ ok: false, error: `executor "${executor}" not registered — call /worker/register first` });
    return;
  }
  entry.lastHeartbeat = Date.now();
  _workerRegistry.set(executor, entry);
  res.json({ ok: true, executor, lastHeartbeat: new Date(entry.lastHeartbeat).toISOString() });
});

// GET /api/zombrains/worker/registry
// Returns ALL known workers with alive:true/false.
// liveCount = workers within TTL. count = total (including recently offline).
router.get("/zombrains/worker/registry", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const workers   = getAllWorkers();
  const liveCount = workers.filter(w => w.alive).length;
  res.json({ ok: true, count: workers.length, liveCount, workers, ttlMs: WORKER_TTL_MS });
});

// ── GET /api/zombrains/worker/events ─────────────────────────────────────────
// Returns recent step events from Postgres, newest first.
// Query: limit (default 60, max 200)
router.get("/zombrains/worker/events", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  try {
    const events = await db
      .select()
      .from(workerStepEventsTable)
      .orderBy(desc(workerStepEventsTable.ts))
      .limit(limit);
    const countResult = await db.execute(sql`SELECT COUNT(*)::int AS n FROM worker_step_events`);
    const total = (countResult.rows[0] as { n: number }).n ?? 0;
    res.json({ ok: true, events, total });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ── GET /api/zombrains/worker/analytics ───────────────────────────────────────
// Aggregated step analytics for a time window.
// Query: window = "1h" | "24h" | "7d" | "all"
router.get("/zombrains/worker/analytics", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const windowParam = String(req.query.window ?? "24h");

  let since: Date;
  const now = new Date();
  switch (windowParam) {
    case "1h":  since = new Date(now.getTime() - 60 * 60 * 1000); break;
    case "7d":  since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
    case "all": since = new Date(0); break;
    default:    since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  try {
    // ── Summary ────────────────────────────────────────────────────────────────
    const summaryRows = await db.execute(sql`
      SELECT
        COUNT(*)::int                                                         AS total,
        COUNT(*) FILTER (WHERE outcome = 'complete')::int                    AS complete,
        COUNT(*) FILTER (WHERE outcome = 'failed')::int                      AS failed,
        AVG(latency_ms)                                                       AS avg_latency_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms)              AS p50_latency_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)             AS p95_latency_ms,
        COALESCE(SUM(tokens), 0)::int                                         AS total_tokens
      FROM worker_step_events
      WHERE ts >= ${since}
    `);
    const sr = summaryRows.rows[0] as {
      total: number; complete: number; failed: number;
      avg_latency_ms: string | null; p50_latency_ms: string | null;
      p95_latency_ms: string | null; total_tokens: number;
    };
    const total    = sr.total ?? 0;
    const complete = sr.complete ?? 0;
    const summary = {
      total,
      complete,
      failed:       sr.failed ?? 0,
      successRate:  total > 0 ? (complete / total) * 100 : 0,
      avgLatencyMs: sr.avg_latency_ms != null ? Math.round(Number(sr.avg_latency_ms)) : null,
      p50LatencyMs: sr.p50_latency_ms != null ? Math.round(Number(sr.p50_latency_ms)) : null,
      p95LatencyMs: sr.p95_latency_ms != null ? Math.round(Number(sr.p95_latency_ms)) : null,
      totalTokens:  sr.total_tokens ?? 0,
    };

    // ── By executor ────────────────────────────────────────────────────────────
    const execRows = await db.execute(sql`
      SELECT executor,
        COUNT(*)::int                                             AS total,
        COUNT(*) FILTER (WHERE outcome = 'complete')::int        AS complete,
        COUNT(*) FILTER (WHERE outcome = 'failed')::int          AS failed,
        AVG(latency_ms)                                           AS avg_latency_ms
      FROM worker_step_events
      WHERE ts >= ${since}
      GROUP BY executor
      ORDER BY total DESC
    `);
    const byExecutor = (execRows.rows as { executor: string; total: number; complete: number; failed: number; avg_latency_ms: string | null }[]).map(r => ({
      executor:     r.executor,
      total:        r.total,
      complete:     r.complete,
      failed:       r.failed,
      avgLatencyMs: r.avg_latency_ms != null ? Math.round(Number(r.avg_latency_ms)) : null,
    }));

    // ── By provider ────────────────────────────────────────────────────────────
    const provRows = await db.execute(sql`
      SELECT COALESCE(provider, 'unknown') AS provider,
        COUNT(*)::int                         AS total,
        AVG(latency_ms)                        AS avg_latency_ms,
        COALESCE(SUM(tokens), 0)::int          AS total_tokens
      FROM worker_step_events
      WHERE ts >= ${since}
      GROUP BY provider
      ORDER BY total DESC
    `);
    const byProvider = (provRows.rows as { provider: string; total: number; avg_latency_ms: string | null; total_tokens: number }[]).map(r => ({
      provider:     r.provider,
      total:        r.total,
      avgLatencyMs: r.avg_latency_ms != null ? Math.round(Number(r.avg_latency_ms)) : null,
      totalTokens:  r.total_tokens ?? 0,
    }));

    // ── Hourly / daily breakdown ───────────────────────────────────────────────
    const groupBy = windowParam === "7d" ? "day" : "hour";
    const hourlyRows = await db.execute(sql`
      SELECT date_trunc(${groupBy}, ts AT TIME ZONE 'UTC') AS hour,
        COUNT(*) FILTER (WHERE outcome = 'complete')::int AS complete,
        COUNT(*) FILTER (WHERE outcome = 'failed')::int   AS failed
      FROM worker_step_events
      WHERE ts >= ${since}
      GROUP BY hour
      ORDER BY hour ASC
    `);
    const hourly = (hourlyRows.rows as { hour: unknown; complete: number; failed: number }[]).map(r => ({
      hour:     new Date(r.hour as string).toISOString(),
      complete: r.complete,
      failed:   r.failed,
    }));

    // ── Registry history (last 50 events, regardless of window) ───────────────
    const regRows = await db
      .select()
      .from(workerRegistryLogTable)
      .orderBy(desc(workerRegistryLogTable.ts))
      .limit(50);
    const registryHistory = regRows.map(r => ({
      executor:   r.executor,
      event_type: r.event_type,
      ts:         r.ts.toISOString(),
      pid:        r.pid,
    }));

    res.json({ ok: true, window: windowParam, summary, byExecutor, byProvider, hourly, registryHistory });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ── Runner heartbeat (ZomBrains → Replit every 30s during active task) ────────
// POST /zombrains/runner/heartbeat  body: { taskId, ts }
// Lets the admin panel distinguish a live-running task from a silently-hung one.

router.post("/zombrains/runner/heartbeat", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { taskId, ts } = req.body as { taskId?: string; ts?: string };
  if (!taskId) { res.status(400).json({ error: "taskId required" }); return; }
  const db = getDb();
  try {
    const value = JSON.stringify({ taskId, ts: ts ?? new Date().toISOString() });
    db.prepare(
      "INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('runner_heartbeat', ?)"
    ).run(value);
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Runner heartbeat GET — Poopy polls this for T02 false-alarm fix ──────────
// Returns the last timestamp ZomBrains sent a runner heartbeat (every 30s during
// any active task). More reliable than reports (which only update on task completion).
// Public endpoint — no auth needed, only returns a timestamp.
router.get("/zombrains/settings/runner-heartbeat", (_req: Request, res: Response) => {
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM zombrains_settings WHERE key='runner_heartbeat'").get() as { value: string } | null;
    if (!row) { res.json({ ts: null, taskId: null }); return; }
    try {
      const parsed = JSON.parse(row.value) as { ts?: string; taskId?: string };
      res.json({ ts: parsed.ts ?? null, taskId: parsed.taskId ?? null });
    } catch { res.json({ ts: row.value, taskId: null }); }
  } finally { db.close(); }
});

// ── Kill switches — enable/disable guarded ZomBrains systems at runtime ───────
// Stored as a JSON blob in zombrains_settings key='killswitches'.
// ZomBrains checks ENV vars first, then reads this via its local file cache.
// Owner triggers via !zb kill / !zb unkill Discord commands through Poopy.
//
// Guarded systems:
//   add_tool          — block all new tool registrations
//   tool_verification — bypass verifyTool checks (allow add_tool without verification)
//   code_verification — bypass verifyJsFile checks (allow verify_js_module writes without checking)
//   verify_js         — block verify_js_module from writing files at all

const VALID_KILL_SYSTEMS = ['add_tool', 'tool_verification', 'code_verification', 'verify_js'] as const;

router.get("/zombrains/killswitch", (_req: Request, res: Response) => {
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM zombrains_settings WHERE key='killswitches'").get() as { value: string } | null;
    const switches = row ? JSON.parse(row.value) : {};
    res.json({ ok: true, switches });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally { db.close(); }
});

router.post("/zombrains/killswitch", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { system, enabled } = req.body as { system: string; enabled: boolean };
  if (!VALID_KILL_SYSTEMS.includes(system as typeof VALID_KILL_SYSTEMS[number])) {
    res.status(400).json({ error: `Unknown system '${system}'. Valid: ${VALID_KILL_SYSTEMS.join(', ')}` });
    return;
  }
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM zombrains_settings WHERE key='killswitches'").get() as { value: string } | null;
    const switches: Record<string, boolean> = row ? JSON.parse(row.value) : {};
    switches[system] = Boolean(enabled);
    db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('killswitches', ?)").run(JSON.stringify(switches));
    // Also write to persist_killswitches so Railway's boot restore picks it up on next restart.
    db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('persist_killswitches', ?)")
      .run(JSON.stringify({ switches, storedAt: new Date().toISOString() }));
    res.json({ ok: true, system, enabled: Boolean(enabled), switches });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally { db.close(); }
});

// ── Queue housekeep — forward to Railway to retire legacy tasks ───────────────

router.post("/zombrains/queue/housekeep", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const ZOMBRAINS_URL = "https://builder-agent-production.up.railway.app";
  try {
    const r = await fetch(`${ZOMBRAINS_URL}/queue/housekeep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const json = await r.json() as Record<string, unknown>;
    res.json(json);
  } catch (e) {
    res.status(502).json({ ok: false, error: (e as Error).message });
  }
});

// ── Clear dead-letter tasks from the persisted queue ─────────────────────────
// Two-step: (1) forward to Railway's live /queue/purge-dead-letters so the
// in-memory queue is drained immediately, (2) filter the Monitor-persisted queue
// (SQLite backup) so DL tasks don't come back after Railway restart.
// Also marks dead-letter alerts as sent so the analytics count drops to 0.

router.post("/zombrains/queue/clear-dead-letters", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const ZOMBRAINS_URL = "https://builder-agent-production.up.railway.app";
  const adminSecret = process.env["ADMIN_SECRET"] ?? "";

  // Step 1: drain Railway's live in-memory queue (best-effort — don't fail if Railway is down)
  let railwayCleared = 0;
  try {
    const rr = await fetch(`${ZOMBRAINS_URL}/queue/purge-dead-letters`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": adminSecret },
      body: JSON.stringify({ includeFailed: false }),
      signal: AbortSignal.timeout(8_000),
    });
    if (rr.ok) {
      const rj = await rr.json() as { ok?: boolean; removed?: number };
      railwayCleared = rj.removed ?? 0;
    }
  } catch { /* Railway unreachable — still clear the persisted copy */ }

  // Step 2: clear the Monitor-persisted SQLite queue backup
  const db = getDb();
  try {
    const row = db.prepare("SELECT data FROM zombrains_queue WHERE key = 'main'").get() as { data: string } | undefined;
    const queue: unknown[] = row ? (() => { try { return JSON.parse(row.data); } catch { return []; } })() : [];
    const before = queue.length;
    const filtered = (queue as Array<{ status?: string }>).filter(t => t.status !== "dead_letter");
    const clearedPersisted = before - filtered.length;
    db.prepare(`
      INSERT INTO zombrains_queue (key, data, updated_at) VALUES ('main', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(JSON.stringify(filtered));

    // Step 3: mark dead-letter alerts as acknowledged so the analytics count drops to 0
    db.prepare("UPDATE zombrains_dead_letter_alerts SET sent_at = datetime('now') WHERE sent_at IS NULL").run();

    const cleared = Math.max(railwayCleared, clearedPersisted);
    res.json({ ok: true, cleared, railwayCleared, persistedCleared: clearedPersisted, remaining: filtered.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally { db.close(); }
});

// ── Clear queue to owner/task-plan tasks only ─────────────────────────────────
// Strips all autonomously-generated tasks from the persisted queue, keeping only
// tasks where ownerTask===true or source==="owner". Also enables the
// zombrains_task_plans_only flag to block new autonomous tasks from queuing.
// Railway's live in-memory queue is NOT touched — ZomBrains reconciles on next sync.

router.post("/zombrains/queue/clear-to-plans", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const row = db.prepare("SELECT data FROM zombrains_queue WHERE key = 'main'").get() as { data: string } | undefined;
    const queue: unknown[] = row ? (() => { try { return JSON.parse(row.data); } catch { return []; } })() : [];
    const before = queue.length;

    const isOwnerTask = (t: unknown): boolean => {
      const task = t as Record<string, unknown>;
      return task["ownerTask"] === true || task["source"] === "owner";
    };
    // Keep owner tasks (any status) + all done/failed/dead_letter tasks for history
    const filtered = (queue as Array<Record<string, unknown>>).filter(
      t => isOwnerTask(t) || t["status"] === "done" || t["status"] === "failed" || t["status"] === "dead_letter"
    );
    const removed = before - filtered.length;

    db.prepare(`
      INSERT INTO zombrains_queue (key, data, updated_at) VALUES ('main', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(JSON.stringify(filtered));

    // Enable task-plans-only mode to block new autonomous proposals from queuing
    db.prepare(`INSERT OR REPLACE INTO feature_flags (flag, enabled, updated_at) VALUES ('zombrains_task_plans_only', 1, strftime('%s','now'))`).run();

    res.json({ ok: true, removed, remaining: filtered.length, taskPlansOnlyEnabled: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally { db.close(); }
});

// ── Live proxy ────────────────────────────────────────────────────────────────

router.get("/zombrains/live", async (req: Request, res: Response) => {
  if (!readonlyAuthCheck(req, res)) return;
  const BASE = "https://builder-agent-production.up.railway.app";

  async function fetchJSON(url: string): Promise<unknown> {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  const [queueResult, safeResult, providersResult, logsResult, tokensResult, qsResult] = await Promise.allSettled([
    fetchJSON(`${BASE}/queue`),
    fetchJSON(`${BASE}/safe-to-push`),
    fetchJSON(`${BASE}/providers`),
    fetchJSON(`${BASE}/logs?limit=80`),
    fetchJSON(`${BASE}/tokens`),
    fetchJSON(`${BASE}/queue-status`), // Task #507: bootLock status
  ]);

  const db = getDb();
  const reports   = db.prepare("SELECT * FROM zombrains_reports ORDER BY id DESC LIMIT 30").all();
  const storedLogs = db.prepare("SELECT * FROM zombrains_logs ORDER BY id DESC LIMIT 100").all();
  const queueRow  = db.prepare("SELECT data FROM zombrains_queue WHERE key = 'main'").get() as { data: string } | undefined;

  // Library snapshot — count + top categories (zero-token data for admin panel)
  const libraryTotal = (() => {
    try { return (db.prepare("SELECT COUNT(*) AS n FROM zombrains_library").get() as { n: number }).n; } catch { return 0; }
  })();
  const libraryCategories = (() => {
    try { return db.prepare("SELECT category, COUNT(*) AS cnt FROM zombrains_library GROUP BY category ORDER BY cnt DESC LIMIT 6").all(); } catch { return []; }
  })();

  // System snapshot from DB (no Railway call — never hangs)
  const systemSnapshot = (() => {
    const safeVal = (key: string) => { try { return (db.prepare("SELECT value FROM zombrains_settings WHERE key=?").get(key) as { value: string } | null)?.value ?? null; } catch { return null; } };
    const hbRaw   = safeVal('runner_heartbeat');
    const hbTs    = hbRaw ? (() => { try { return (JSON.parse(hbRaw) as Record<string,string>).ts ?? hbRaw; } catch { return hbRaw; } })() : null;
    const hbAgo   = hbTs ? Math.floor((Date.now() - new Date(hbTs).getTime()) / 1000) : null;
    const ahbTs   = safeVal('admin_heartbeat');
    const ahbAgo  = ahbTs ? Math.floor((Date.now() - new Date(ahbTs).getTime()) / 1000) : null;
    return {
      zombrains:  { alive: hbAgo !== null && hbAgo < 120, lastHeartbeatAgo: hbAgo },
      adminPanel: { open:  ahbAgo !== null && ahbAgo < 90, lastHeartbeatAgo: ahbAgo },
    };
  })();

  db.close();

  const persistedQueue = queueRow ? (() => { try { return JSON.parse(queueRow.data); } catch { return []; } })() : [];

  res.json({
    queue:          queueResult.status     === "fulfilled" ? queueResult.value     : { error: (queueResult as PromiseRejectedResult).reason?.message, persisted: persistedQueue },
    safe:           safeResult.status      === "fulfilled" ? safeResult.value      : { error: (safeResult as PromiseRejectedResult).reason?.message },
    providers:      providersResult.status === "fulfilled" ? providersResult.value : { error: (providersResult as PromiseRejectedResult).reason?.message },
    logs:           logsResult.status      === "fulfilled" ? logsResult.value      : { error: (logsResult as PromiseRejectedResult).reason?.message, stored: storedLogs },
    tokenStats:     tokensResult.status    === "fulfilled" ? tokensResult.value    : null,
    reports:        (reports as unknown[]).reverse(),
    storedLogs:     (storedLogs as unknown[]).reverse(),
    persistedQueue,
    library:        { total: libraryTotal, topCategories: libraryCategories },
    systemSnapshot,
    bootLock:       qsResult.status === "fulfilled" ? (qsResult.value as { bootLock?: { locked: boolean; unlocksAt: string | null } }).bootLock ?? null : null,
    fetchedAt:      new Date().toISOString(),
  });
});

// ── Web Search Proxy ──────────────────────────────────────────────────────────
// ZomBrains calls this from Railway to search the internet via Tavily.
// Requires TAVILY_API_KEY in Replit environment.

router.post("/zombrains/search", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { query } = req.body as { query?: string };
  if (!query?.trim()) { res.status(400).json({ error: "query required" }); return; }
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "TAVILY_API_KEY not configured" }); return; }
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: String(query).slice(0, 300),
        search_depth: "basic",
        max_results: 5,
        include_answer: true,
        include_raw_content: false,
      }),
    });
    if (!resp.ok) { res.status(502).json({ error: `Tavily error: ${resp.status}` }); return; }
    const data = await resp.json() as {
      answer?: string;
      results?: Array<{ title: string; url: string; content: string; score?: number }>;
    };
    res.json({
      ok: true,
      query: query.trim(),
      answer: data.answer ?? null,
      results: (data.results ?? []).map(r => ({
        title: r.title,
        url:   r.url,
        snippet: (r.content ?? "").slice(0, 400),
      })),
      fetchedAt: new Date().toISOString(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: `Search failed: ${msg}` });
  }
});

// ── Knowledge Library ─────────────────────────────────────────────────────────

router.get("/zombrains/library", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { search, title, category, tags_contains, limit: limitQ, offset: offsetQ } = req.query as Record<string, string | undefined>;
  const limit  = Math.min(Number(limitQ  ?? 20), 100);
  const offset = Number(offsetQ ?? 0);
  const db = getDb();

  let rows: LibraryRow[];
  if (search) {
    // FTS5 full-text search (title + content columns only — not tags)
    rows = db.prepare(`
      SELECT l.* FROM zombrains_library l
      JOIN zombrains_library_fts fts ON fts.rowid = l.id
      WHERE zombrains_library_fts MATCH ?
      ORDER BY rank LIMIT ? OFFSET ?
    `).all(`${search}*`, limit, offset) as LibraryRow[];
  } else if (tags_contains) {
    // Exact tag-field filter — use this for stale-check queries, not FTS5
    rows = db.prepare(
      "SELECT * FROM zombrains_library WHERE tags LIKE ? ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    ).all(`%${tags_contains}%`, limit, offset) as LibraryRow[];
  } else if (title) {
    rows = db.prepare(
      "SELECT * FROM zombrains_library WHERE title = ? LIMIT 1"
    ).all(title) as LibraryRow[];
  } else if (category) {
    rows = db.prepare(
      "SELECT * FROM zombrains_library WHERE category = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    ).all(category, limit, offset) as LibraryRow[];
  } else {
    rows = db.prepare(
      "SELECT * FROM zombrains_library ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    ).all(limit, offset) as LibraryRow[];
  }

  const total = (db.prepare("SELECT COUNT(*) AS n FROM zombrains_library").get() as { n: number }).n;
  db.close();
  res.json({ ok: true, total, entries: rows.map(addStalenessWarning) });
});

router.post("/zombrains/library", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { title, content, category, source_file, tags } = req.body as {
    title: string; content: string; category?: string; source_file?: string; tags?: string;
  };
  if (!title || !content) { res.status(400).json({ error: "title and content required" }); return; }
  const db = getDb();
  const cat = String(category ?? "knowledge");
  // error_pattern entries expire after 30 days — SQLite computes the datetime inline
  // to avoid any JS-to-SQLite datetime format mismatch. Other categories: expires_at = NULL.
  const result = db.prepare(`
    INSERT INTO zombrains_library (title, content, category, source_file, tags, expires_at)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'error_pattern' THEN datetime('now', '+30 days') ELSE NULL END)
    ON CONFLICT(title) DO UPDATE SET
      content     = excluded.content,
      category    = excluded.category,
      source_file = excluded.source_file,
      tags        = excluded.tags,
      expires_at  = excluded.expires_at,
      updated_at  = datetime('now')
  `).run(
    String(title).slice(0, 200),
    String(content),
    cat,
    source_file ? String(source_file) : null,
    tags ? String(tags) : null,
    cat,
  );
  db.close();
  res.json({ ok: true, id: result.lastInsertRowid });
});

router.patch("/zombrains/library/:id", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const id = Number(req.params["id"]);
  const { content, category, tags, source_file } = req.body as {
    content?: string; category?: string; tags?: string; source_file?: string;
  };
  const db = getDb();
  const existing = db.prepare("SELECT * FROM zombrains_library WHERE id = ?").get(id) as LibraryRow | undefined;
  if (!existing) { db.close(); res.status(404).json({ error: "Not found" }); return; }
  // Recompute expires_at based on effective category after the patch:
  // error_pattern → set/refresh 30-day TTL; anything else → clear expires_at
  const effectiveCat = category ?? existing.category;
  db.prepare(`
    UPDATE zombrains_library
    SET content     = ?,
        category    = ?,
        tags        = ?,
        source_file = ?,
        expires_at  = CASE WHEN ? = 'error_pattern' THEN datetime('now', '+30 days') ELSE NULL END,
        updated_at  = datetime('now')
    WHERE id = ?
  `).run(
    content     ?? existing.content,
    effectiveCat,
    tags        ?? existing.tags,
    source_file ?? existing.source_file,
    effectiveCat,
    id,
  );
  db.close();
  res.json({ ok: true });
});

router.delete("/zombrains/library/:id", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const id = Number(req.params["id"]);
  const db = getDb();
  const info = db.prepare("DELETE FROM zombrains_library WHERE id = ?").run(id);
  db.close();
  if (info.changes === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

// ── POST /zombrains/library/prune-stale — delete expired error_pattern entries ─
// error_pattern entries written with expires_at (30-day TTL) are removed here.
// If > 3 are pruned in one pass, a synthesis entry records the maintenance event
// so ZomBrains knows its pattern library is being actively cleaned.
router.post("/zombrains/library/prune-stale", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const info = db.prepare(
    "DELETE FROM zombrains_library WHERE category = 'error_pattern' AND expires_at IS NOT NULL AND expires_at < datetime('now')"
  ).run();
  const pruned = info.changes;
  if (pruned > 3) {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO zombrains_library (title, content, category, tags)
      VALUES (?, ?, 'synthesis', 'prune,maintenance,error_pattern')
      ON CONFLICT(title) DO UPDATE SET
        content    = excluded.content,
        updated_at = datetime('now')
    `).run(
      `synthesis: error_pattern library pruned ${today}`,
      `Error patterns pruned: ${pruned} expired entries removed on ${today} — these recurring errors either resolved or became irrelevant over the 30-day TTL window. Pattern library is being maintained automatically.`,
    );
  }
  db.close();
  res.json({ ok: true, pruned });
});

// ── GET /zombrains/restart-frequency — proxy to Railway /restart-frequency ────
// Railway server writes restart events to /app/restart-log.json on every SIGTERM.
// This endpoint proxies the computed stats so the admin panel / getSystemHealth()
// can surface crash frequency without hitting Railway directly.
router.get("/zombrains/restart-frequency", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const RAILWAY_URL = "https://builder-agent-production.up.railway.app";
    const r = await fetch(`${RAILWAY_URL}/restart-frequency`, {
      headers: { "x-admin-secret": process.env["ADMIN_SECRET"] ?? "" },
    });
    if (!r.ok) { res.status(r.status).json({ error: "Railway fetch failed", status: r.status }); return; }
    const data = await r.json() as unknown;
    res.json(data);
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

router.get("/zombrains/library/stats", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const libCount  = (db.prepare("SELECT COUNT(*) AS n FROM zombrains_library").get() as { n: number }).n;
  const callCount = (db.prepare("SELECT COUNT(*) AS n FROM zombrains_calls").get() as { n: number }).n;
  const weekCalls = (db.prepare(
    "SELECT COUNT(*) AS n FROM zombrains_calls WHERE created_at > datetime('now', '-7 days')"
  ).get() as { n: number }).n;
  const topProviders = db.prepare(`
    SELECT provider, SUM(call_count) AS total
    FROM zombrains_provider_stats
    WHERE date >= date('now', '-7 days')
    GROUP BY provider ORDER BY total DESC LIMIT 5
  `).all() as { provider: string; total: number }[];
  const avgTokens = (db.prepare(
    "SELECT AVG(tokens_out) AS avg FROM zombrains_calls WHERE created_at > datetime('now', '-7 days')"
  ).get() as { avg: number | null }).avg;
  const stale = (db.prepare(
    "SELECT COUNT(*) AS n FROM zombrains_library WHERE updated_at < datetime('now', '-14 days')"
  ).get() as { n: number }).n;
  db.close();
  res.json({ ok: true, libCount, callCount, weekCalls, stale, avgTokensPerCall: avgTokens ? Math.round(avgTokens) : 0, topProviders });
});

// ── Library categories — distinct categories with entry counts ────────────────
// Used by get_library_categories tool in tools.js so dream_state and
// pattern_compression can discover what knowledge has been accumulated.
router.get("/zombrains/library/categories", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const categories = db.prepare(
      "SELECT category, COUNT(*) AS count FROM zombrains_library GROUP BY category ORDER BY count DESC"
    ).all() as { category: string; count: number }[];
    res.json({ ok: true, categories });
  } finally { db.close(); }
});

// ── Stage 3a: Daily change watcher — mark library entries stale ──────────────
// Called fire-and-forget by queue.js after every successful git push.
// Finds library entries whose source_file matches a changed file and appends
// "stale" to their tags so ZomBrains knows to refresh them on next pass.
router.post("/zombrains/library/stale-check", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { files } = req.body as { files?: string[] };
  if (!Array.isArray(files) || files.length === 0) { res.json({ ok: true, marked: 0 }); return; }
  const db = getDb();
  let marked = 0;
  for (const f of files.slice(0, 50)) {
    try {
      const rows = db.prepare(
        "SELECT id, tags FROM zombrains_library WHERE source_file = ?"
      ).all(f) as { id: number; tags: string | null }[];
      for (const row of rows) {
        const tags = row.tags ? row.tags.split(",").map((t: string) => t.trim()).filter(Boolean) : [];
        if (!tags.includes("stale")) {
          tags.push("stale");
          db.prepare("UPDATE zombrains_library SET tags = ?, updated_at = datetime('now') WHERE id = ?")
            .run(tags.join(","), row.id);
          marked++;
        }
      }
    } catch { /* non-fatal */ }
  }
  db.close();
  res.json({ ok: true, marked });
});

// ── Knowledge library — ZomBrains-facing CRUD aliases ────────────────────────
// remember / recall / forget / list_memories / store_memory / search_memory all
// call these routes. Thin wrappers over zombrains_library so tool URLs are
// stable and all memory paths converge on the same table.

router.post("/zombrains/knowledge", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { title, content, category, tags, source_file } = req.body as {
    title?: string; content: string; category?: string; tags?: string; source_file?: string;
  };
  if (!content) { res.status(400).json({ error: "content required" }); return; }
  const db = getDb();
  const t   = title ? String(title).slice(0, 200) : String(content).slice(0, 100).replace(/\n/g, " ");
  const cat = String(category ?? "knowledge");
  const result = db.prepare(`
    INSERT INTO zombrains_library (title, content, category, source_file, tags, expires_at)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'error_pattern' THEN datetime('now', '+30 days') ELSE NULL END)
    ON CONFLICT(title) DO UPDATE SET
      content     = excluded.content,
      category    = excluded.category,
      source_file = excluded.source_file,
      tags        = excluded.tags,
      expires_at  = excluded.expires_at,
      updated_at  = datetime('now')
  `).run(t, String(content), cat, source_file ?? null, tags ?? null, cat);
  db.close();
  res.json({ ok: true, id: result.lastInsertRowid });
});

router.post("/zombrains/knowledge/search", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { query, category, limit: limitQ } = req.body as { query: string; category?: string; limit?: number };
  if (!query) { res.status(400).json({ error: "query required" }); return; }
  const limit = Math.min(Number(limitQ ?? 20), 100);
  const db = getDb();
  let rows: LibraryRow[];
  if (category) {
    rows = db.prepare(`
      SELECT l.* FROM zombrains_library l
      JOIN zombrains_library_fts fts ON fts.rowid = l.id
      WHERE zombrains_library_fts MATCH ? AND l.category = ?
      ORDER BY rank LIMIT ?
    `).all(`${query}*`, category, limit) as LibraryRow[];
  } else {
    rows = db.prepare(`
      SELECT l.* FROM zombrains_library l
      JOIN zombrains_library_fts fts ON fts.rowid = l.id
      WHERE zombrains_library_fts MATCH ?
      ORDER BY rank LIMIT ?
    `).all(`${query}*`, limit) as LibraryRow[];
  }
  db.close();
  res.json({ ok: true, results: rows.map(addStalenessWarning), count: rows.length });
});

router.get("/zombrains/knowledge", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { category, limit: limitQ, offset: offsetQ } = req.query as Record<string, string | undefined>;
  const limit  = Math.min(Number(limitQ  ?? 20), 100);
  const offset = Number(offsetQ ?? 0);
  const db = getDb();
  const rows = category
    ? db.prepare("SELECT * FROM zombrains_library WHERE category = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(category, limit, offset) as LibraryRow[]
    : db.prepare("SELECT * FROM zombrains_library ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(limit, offset) as LibraryRow[];
  const total = (db.prepare("SELECT COUNT(*) AS n FROM zombrains_library").get() as { n: number }).n;
  db.close();
  res.json({ ok: true, total, entries: rows.map(addStalenessWarning) });
});

router.delete("/zombrains/knowledge/:id", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const id = Number(req.params["id"]);
  const db = getDb();
  const info = db.prepare("DELETE FROM zombrains_library WHERE id = ?").run(id);
  db.close();
  if (info.changes === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

// ── Per-tool registry — Railway syncs each validated tool here on add_tool ────
// On add_tool success ZomBrains POSTs the definition. On startup, Railway fetches
// the full list and re-registers any tools missing from the live TOOLS registry.
// Gives a validated per-tool inventory that survives Railway redeploys.

router.post("/zombrains/tools", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { name, description, parameters_schema, execute_code } = req.body as {
    name: string; description: string; parameters_schema: object; execute_code: string;
  };
  if (!name || !description || !parameters_schema || !execute_code) {
    res.status(400).json({ error: "name, description, parameters_schema, execute_code all required" }); return;
  }
  // Validate: execute_code must parse as callable JS before we accept it
  try { new Function(execute_code); } catch (e: any) {
    res.status(400).json({ error: `execute_code syntax error: ${e.message}` }); return;
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO zombrains_tools (name, description, parameters_schema, execute_code)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      description       = excluded.description,
      parameters_schema = excluded.parameters_schema,
      execute_code      = excluded.execute_code,
      verified          = 1,
      updated_at        = datetime('now')
  `).run(name, description, JSON.stringify(parameters_schema), execute_code);
  db.close();
  res.json({ ok: true, name });
});

router.get("/zombrains/tools", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const rows = db.prepare(
    "SELECT name, description, parameters_schema, execute_code, verified, created_at, updated_at FROM zombrains_tools ORDER BY name"
  ).all();
  db.close();
  res.json({ ok: true, tools: rows, count: rows.length });
});

router.delete("/zombrains/tools/:name", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { name } = req.params;
  const db = getDb();
  const info = db.prepare("DELETE FROM zombrains_tools WHERE name = ?").run(name);
  db.close();
  if (info.changes === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

// ── Tools: full live list extracted from tools.js ────────────────────────────
router.get("/zombrains/tools/all", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const toolsPath = path.resolve(process.cwd(), "..", "..", "builder-agent", "src", "tools.js");
    const src = fs.readFileSync(toolsPath, "utf8");
    const names = [...src.matchAll(/^TOOLS\.(\w+)\s*=/gm)].map(m => m[1]);
    const sorted = [...new Set(names)].sort();
    res.json({ ok: true, tools: sorted, count: sorted.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── Prompt Index: Monitor-side canonical codebook ─────────────────────────────
// ZomBrains fetches this on boot to sync his local prompt-index.json.
// propose endpoint validates, assigns, and stores new codes atomically.

// Namespace prefix rules (must match promptCodec.js algorithm exactly)
const VALID_NAMESPACES = new Set(['Ta','Td','Tf','Tg','Tk','Tm','Tp','Tr','Ts','Tt','Tw']);
const CODE_RE = /^T[a-z]_[a-z][a-z0-9]{0,5}$/;

/** Auto-bootstrap: load all codes from builder-agent/prompt-index.json into DB if table is empty. */
function bootstrapPromptIndex(db: Database.Database) {
  const count = (db.prepare("SELECT COUNT(*) as n FROM prompt_index").get() as { n: number }).n;
  if (count > 0) return;
  try {
    const jsonPath = path.resolve(process.cwd(), "..", "..", "builder-agent", "prompt-index.json");
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { version: number; codes: Record<string, string> };
    const ins = db.prepare(`INSERT OR IGNORE INTO prompt_index (code, full_name, namespace, version_added) VALUES (?, ?, ?, ?)`);
    const many = db.transaction((entries: [string,string,number][]) => {
      for (const [code, name, ver] of entries) ins.run(code, name, code.split("_")[0], ver);
    });
    const entries = Object.entries(raw.codes).map(([c, n]) => [c, n, raw.version] as [string,string,number]);
    many(entries);
    console.log(`[prompt-index] bootstrapped ${entries.length} codes from prompt-index.json`);
  } catch (e) {
    console.error("[prompt-index] bootstrap failed:", (e as Error).message);
  }
}

router.get("/zombrains/prompt-index", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const db = getDb();
    bootstrapPromptIndex(db);
    const rows = db.prepare("SELECT code, full_name, namespace, deprecated, deprecated_succ, version_added, usage_count FROM prompt_index ORDER BY code").all() as {
      code: string; full_name: string; namespace: string; deprecated: number; deprecated_succ: string | null; version_added: number; usage_count: number;
    }[];
    // Current version = max version_added in the table
    const verRow = db.prepare("SELECT MAX(version_added) as v FROM prompt_index").get() as { v: number | null };
    const version = verRow?.v ?? 1;
    const codes: Record<string, string> = {};
    for (const r of rows) if (!r.deprecated) codes[r.code] = r.full_name;
    res.json({ ok: true, version, count: Object.keys(codes).length, codes, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.post("/zombrains/prompt-index/propose", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { full_name, suggested_code } = req.body as { full_name: string; suggested_code?: string };
  if (!full_name) { res.status(400).json({ ok: false, error: "full_name required" }); return; }
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(full_name)) { res.status(400).json({ ok: false, error: "invalid full_name format" }); return; }
  try {
    const db = getDb();
    bootstrapPromptIndex(db);
    // Check if name is already coded
    const existing = db.prepare("SELECT code FROM prompt_index WHERE full_name = ?").get(full_name) as { code: string } | undefined;
    if (existing) { res.json({ ok: true, code: existing.code, already_existed: true }); return; }
    // Determine code to use
    let code = suggested_code?.trim() ?? "";
    if (code) {
      // Validate suggested code format
      if (!CODE_RE.test(code)) { res.status(400).json({ ok: false, error: `invalid code format '${code}' — must match T<ns>_<suffix> e.g. Tf_ap` }); return; }
      const ns = code.split("_")[0];
      if (!VALID_NAMESPACES.has(ns)) { res.status(400).json({ ok: false, error: `unknown namespace '${ns}'` }); return; }
      // Check collision
      const collision = db.prepare("SELECT full_name FROM prompt_index WHERE code = ?").get(code) as { full_name: string } | undefined;
      if (collision) { res.status(409).json({ ok: false, error: `code '${code}' already assigned to '${collision.full_name}'` }); return; }
    } else {
      // Auto-generate: derive namespace from name keywords, build suffix from initials
      const ns = (() => {
        if (/memory|knowledge|recall|remember|forget|teach_yourself|list_memories/.test(full_name)) return "Tk";
        if (/^callAI$|provider|open_router|fix_provider/.test(full_name)) return "Ta";
        if (/^self_|get_bot_|get_api_status|get_env_vars|get_process|get_workspace|monitor_bot|watch_bot|profile_bot/.test(full_name)) return "Ts";
        if (/propose_|plan_task|brainstorm|build_feature|journal_entry|^todo_|update_notes|generate_changelog|snapshot_project|request_tool_build/.test(full_name)) return "Tp";
        if (/add_tool|add_cluster|build_tool|auto_update_tools|tool_health|remove_tool|test_tool|toggle_kill|unquarantine/.test(full_name)) return "Tt";
        if (/railway_logs|run_command|run_replit_shell|start_process|stop_process|read_process|reload_module|^git_|get_git|project_git/.test(full_name)) return "Tr";
        if (/^http_|web_search|zb_api/.test(full_name)) return "Tw";
        if (/^grep$|^glob$|search_project|find_function|count_in_project|list_project_todos|project_schema|run_typecheck|validate_js|verify_js|write_bot_command/.test(full_name)) return "Tg";
        if (/report_to/.test(full_name)) return "Td";
        if (/file|directory|json|replit_api|read_project|write_project|batch_|diff_|copy_|rollback|outline_|multi_edit|replace_all|read_replit|count_lines/.test(full_name)) return "Tf";
        return "Tm";
      })();
      const NOISE = new Set(["project","file","files","tool","bot","memory","replit","railway","all","in","the","to","from","of"]);
      const parts = full_name.split("_");
      while (parts.length > 1 && NOISE.has(parts[parts.length - 1])) parts.pop();
      const meaningful = parts.filter((p, i) => i === 0 || !NOISE.has(p));
      let suffix = meaningful.slice(0, 3).map((p: string) => p[0]).join("");
      // Resolve collisions
      let candidate = `${ns}_${suffix}`;
      let n = 2;
      while (db.prepare("SELECT 1 FROM prompt_index WHERE code = ?").get(candidate)) {
        candidate = `${ns}_${suffix}${n++}`;
        if (n > 20) { res.status(500).json({ ok: false, error: "cannot assign unique code — namespace exhausted" }); return; }
      }
      code = candidate;
    }
    // Determine next version number
    const verRow = db.prepare("SELECT MAX(version_added) as v FROM prompt_index").get() as { v: number | null };
    const nextVer = (verRow?.v ?? 0) + 1;
    db.prepare("INSERT INTO prompt_index (code, full_name, namespace, version_added) VALUES (?, ?, ?, ?)").run(code, full_name, code.split("_")[0], nextVer);
    res.json({ ok: true, code, full_name, version: nextVer, already_existed: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.post("/zombrains/prompt-index/deprecate", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { code, successor } = req.body as { code: string; successor?: string };
  if (!code) { res.status(400).json({ ok: false, error: "code required" }); return; }
  try {
    const db = getDb();
    const row = db.prepare("SELECT full_name FROM prompt_index WHERE code = ?").get(code) as { full_name: string } | undefined;
    if (!row) { res.status(404).json({ ok: false, error: `code '${code}' not found` }); return; }
    db.prepare("UPDATE prompt_index SET deprecated = 1, deprecated_succ = ? WHERE code = ?").run(successor ?? null, code);
    res.json({ ok: true, deprecated: code, full_name: row.full_name, successor: successor ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.post("/zombrains/prompt-index/track-usage", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { codes } = req.body as { codes: string[] };
  if (!Array.isArray(codes) || codes.length === 0) { res.status(400).json({ ok: false, error: "codes[] required" }); return; }
  try {
    const db = getDb();
    const upd = db.prepare("UPDATE prompt_index SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE code = ?");
    const many = db.transaction((cs: string[]) => { for (const c of cs) upd.run(c); });
    many(codes);
    res.json({ ok: true, tracked: codes.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── Knowledge hit tracking ────────────────────────────────────────────────────
// Called by lookup_knowledge tool (tools.js) each time entries are retrieved.
// Upserts hit count + last_hit_at so /knowledge/hot and /knowledge/last-retrieved
// reflect real usage rather than insertion order.

router.post("/zombrains/knowledge/hit", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { title } = req.body as { title: string };
  if (!title) { res.status(400).json({ error: "title required" }); return; }
  const db = getDb();
  db.prepare(`
    INSERT INTO zb_knowledge_hits (title, hit_count, last_hit_at)
    VALUES (?, 1, datetime('now'))
    ON CONFLICT(title) DO UPDATE SET
      hit_count   = hit_count + 1,
      last_hit_at = datetime('now')
  `).run(String(title).slice(0, 200));
  db.close();
  res.json({ ok: true });
});

// Top 10 most-used knowledge entries — used by admin Brain tab + dream_state
router.get("/zombrains/knowledge/hot", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const rows = db.prepare(
    "SELECT title, hit_count, last_hit_at FROM zb_knowledge_hits ORDER BY hit_count DESC LIMIT 10"
  ).all() as { title: string; hit_count: number; last_hit_at: string }[];
  db.close();
  res.json({ ok: true, entries: rows });
});

// Top 10 most recently retrieved entries — used by admin Brain tab
router.get("/zombrains/knowledge/last-retrieved", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const rows = db.prepare(
    "SELECT title, hit_count, last_hit_at FROM zb_knowledge_hits ORDER BY last_hit_at DESC LIMIT 10"
  ).all() as { title: string; hit_count: number; last_hit_at: string }[];
  db.close();
  res.json({ ok: true, entries: rows });
});

// ── Ask endpoint ──────────────────────────────────────────────────────────────

router.post("/zombrains/ask", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  if (askState.count >= MAX_CONCURRENT_ASK) {
    res.status(429).json({ error: "Too many concurrent requests — try again in a moment." });
    return;
  }
  const { messages, prompt, hint, guildId, userId } = req.body as {
    messages?: Msg[]; prompt?: string; hint?: string; guildId?: string; userId?: string;
  };
  if (!messages && !prompt) { res.status(400).json({ error: "messages or prompt required" }); return; }

  const userMsgs: Msg[] = messages ?? [{ role: "user", content: String(prompt) }];

  // Context chaining: prepend up to 6 previous messages (3 pairs) for this guild channel
  const ctxKey = guildId ?? "default";
  const prevCtx = channelContext.get(ctxKey) ?? [];
  const fullMsgs: Msg[] = prevCtx.length ? [...prevCtx.slice(-6), ...userMsgs] : userMsgs;

  askState.count++;
  try {
    const { result, provider, tokens } = await callProviderAgentic(fullMsgs, hint ?? "api-server");

    // Update rolling context
    const lastUserMsg = userMsgs[userMsgs.length - 1];
    channelContext.set(ctxKey, [...prevCtx, lastUserMsg, { role: "assistant", content: result }].slice(-6));

    // Persist call + provider stats
    const db = getDb();
    const callRow = db.prepare(`
      INSERT INTO zombrains_calls (guild_id, user_id, prompt, response, provider, tokens_in, tokens_out)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(guildId ?? null, userId ?? null, lastUserMsg.content as string, result, provider, tokens ?? 0);
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO zombrains_provider_stats (provider, date, call_count, tokens_used) VALUES (?, ?, 1, ?)
      ON CONFLICT(provider, date) DO UPDATE SET
        call_count  = call_count + 1,
        tokens_used = tokens_used + excluded.tokens_used
    `).run(provider, today, tokens ?? 0);
    db.close();

    res.json({ ok: true, callId: Number(callRow.lastInsertRowid), response: result, provider, tokensIn: 0, tokensOut: tokens ?? 0 });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    askState.count--;
  }
});

// ── Cluster tools CRUD ────────────────────────────────────────────────────────
// ZomBrains and admins can register custom tools for the AI clusters to use.
// Built-in tools (search_web, calculate, etc.) cannot be modified via this API.

router.get("/zombrains/cluster-tools", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  res.json(listTools());
});

router.post("/zombrains/cluster-tools", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { name, description, parameters, code, created_by } = req.body as {
    name?: string; description?: string; parameters?: Record<string, unknown>;
    code?: string; created_by?: string;
  };
  if (!name || !description || !code) {
    res.status(400).json({ error: "name, description, and code are required" }); return;
  }
  try {
    clusterRegisterTool({ name, description, parameters: parameters ?? {}, code, created_by: created_by ?? "api" });
    res.json({ ok: true, name });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.delete("/zombrains/cluster-tools/:name", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { name } = req.params as { name: string };
  const removed = clusterRemoveTool(name);
  if (!removed) {
    res.status(404).json({ error: `Tool '${name}' not found or is a built-in tool (built-ins cannot be removed)` }); return;
  }
  res.json({ ok: true, name });
});

// ── Ghost Mode observation log ─────────────────────────────────────────────────
// queue.js posts one row per Ghost Mode task; crystalline evolver reads these to
// update specialist fitness scores over time. Fire-and-forget from Railway side —
// 400/500 errors are silently swallowed by the caller.

router.post("/zombrains/ghost-observations", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { specialist_id, task_id, task_type, specialist_plan, actual_outcome, failures, confidence } =
    req.body as {
      specialist_id?: string; task_id?: string; task_type?: string;
      specialist_plan?: unknown; actual_outcome?: string;
      failures?: unknown; confidence?: number;
    };
  if (!specialist_id || !task_id) {
    res.status(400).json({ error: "specialist_id and task_id are required" }); return;
  }
  const db = getDb();
  try {
    db.prepare(`INSERT INTO zombrains_ghost_observations
        (specialist_id, task_id, task_type, specialist_plan, actual_outcome, failures, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        specialist_id,
        task_id,
        task_type || "",
        specialist_plan !== undefined ? JSON.stringify(specialist_plan) : null,
        actual_outcome || "done",
        failures !== undefined ? JSON.stringify(failures) : null,
        confidence ?? 0,
      );
    res.json({ ok: true });
  } finally { db.close(); }
});

router.get("/zombrains/ghost-observations", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const limit = Math.min(parseInt((req.query.limit as string) || "100"), 500);
  const specialist_id = req.query.specialist_id as string | undefined;
  const db = getDb();
  try {
    const rows = specialist_id
      ? db.prepare("SELECT * FROM zombrains_ghost_observations WHERE specialist_id = ? ORDER BY id DESC LIMIT ?").all(specialist_id, limit)
      : db.prepare("SELECT * FROM zombrains_ghost_observations ORDER BY id DESC LIMIT ?").all(limit);
    res.json({ ok: true, rows });
  } finally { db.close(); }
});

// PATCH /zombrains/calls/:id/rating — set thumbs-up (1) / thumbs-down (-1) on a call
router.patch("/zombrains/calls/:id/rating", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const id     = Number(req.params["id"]);
  const { rating } = req.body as { rating: number };
  if (rating !== 1 && rating !== -1) { res.status(400).json({ error: "rating must be 1 or -1" }); return; }
  const db = getDb();
  const info = db.prepare("UPDATE zombrains_calls SET rating = ? WHERE id = ?").run(rating, id);
  db.close();
  if (info.changes === 0) { res.status(404).json({ error: "Call not found" }); return; }
  res.json({ ok: true });
});

// ── Dead-letter alerts (Railway → Replit → Discord DM) ───────────────────────

router.post("/zombrains/dead-letter-alert", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { taskId, prompt, reason, task_type } = req.body as { taskId: string; prompt: string; reason: string; task_type?: string };
  if (!taskId || !reason) { res.status(400).json({ error: "taskId and reason required" }); return; }
  const db = getDb();
  try {
    // Lazy migration: add task_type column if absent (idempotent — throws silently if already exists)
    try { db.prepare("ALTER TABLE zombrains_dead_letter_alerts ADD COLUMN task_type TEXT").run(); } catch (_) {}
    db.prepare(
      "INSERT INTO zombrains_dead_letter_alerts (task_id, prompt, reason, task_type) VALUES (?, ?, ?, ?)"
    ).run(taskId, prompt ?? "", reason, task_type ?? null);
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Dead-letter triage cycle log ──────────────────────────────────────────────
// ZomBrains posts one row after each dead_letter_review cycle for trend tracking.
router.post("/zombrains/dead-letter-triage-log", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const {
    cycle, pruned, rescued, skipped, total_before, crisis_mode, stale_pruned,
  } = req.body as {
    cycle?: number; pruned?: number; rescued?: number; skipped?: number;
    total_before?: number; crisis_mode?: boolean; stale_pruned?: number;
  };
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO dead_letter_triage_log
        (cycle, pruned, rescued, skipped, total_before, crisis_mode, stale_pruned)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      cycle        ?? 0,
      pruned       ?? 0,
      rescued      ?? 0,
      skipped      ?? 0,
      total_before ?? 0,
      (crisis_mode ? 1 : 0),
      stale_pruned ?? 0,
    );
    // Ring-buffer: keep last 500 triage rows
    db.prepare(`
      DELETE FROM dead_letter_triage_log WHERE id IN (
        SELECT id FROM dead_letter_triage_log ORDER BY id ASC
        LIMIT MAX(0, (SELECT COUNT(*) FROM dead_letter_triage_log) - 500)
      )
    `).run();
    res.json({ ok: true });
  } finally { db.close(); }
});

router.get("/zombrains/dead-letter-triage-log", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    type TriageRow = {
      id: number; cycle: number; pruned: number; rescued: number; skipped: number;
      total_before: number; crisis_mode: number; stale_pruned: number; created_at: string;
    };
    const rows = db.prepare(
      "SELECT * FROM dead_letter_triage_log ORDER BY id DESC LIMIT 50"
    ).all() as TriageRow[];
    res.json({ ok: true, rows });
  } finally { db.close(); }
});

// Poopy bot polls this to pick up pending DMs
router.get("/zombrains/dead-letter-alerts", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const rows = db.prepare(
      "SELECT * FROM zombrains_dead_letter_alerts WHERE sent_at IS NULL ORDER BY created_at ASC LIMIT 20"
    ).all() as { id: number; task_id: string; prompt: string; reason: string; created_at: string }[];
    res.json(rows);
  } finally { db.close(); }
});

router.patch("/zombrains/dead-letter-alerts/:id/sent", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const id = Number(req.params["id"]);
  const db = getDb();
  try {
    db.prepare("UPDATE zombrains_dead_letter_alerts SET sent_at = datetime('now') WHERE id = ?").run(id);
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Env report (Railway → Replit so admin panel can show STAGING badge) ───────

router.post("/zombrains/env-report", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { env, branch } = req.body as { env: string; branch: string };
  if (!env) { res.status(400).json({ error: "env required" }); return; }
  const db = getDb();
  try {
    db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('zombrains_env', ?)").run(env);
    if (branch) db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('zombrains_branch', ?)").run(branch);
    res.json({ ok: true });
  } finally { db.close(); }
});

router.get("/zombrains/env", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const envRow    = db.prepare("SELECT value FROM zombrains_settings WHERE key='zombrains_env'").get() as { value: string } | undefined;
    const branchRow = db.prepare("SELECT value FROM zombrains_settings WHERE key='zombrains_branch'").get() as { value: string } | undefined;
    res.json({ env: envRow?.value ?? "production", branch: branchRow?.value ?? "main" });
  } finally { db.close(); }
});

// ── Analytics report (P3C) ────────────────────────────────────────────────────

router.get("/zombrains/analytics", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const safeGet  = (sql: string, ...params: unknown[]) => { try { return db.prepare(sql).get(...params); } catch { return null; } };
    const safeAll  = (sql: string, ...params: unknown[]) => { try { return db.prepare(sql).all(...params); } catch { return []; } };

    const weekAgo     = new Date(Date.now() - 7  * 86_400_000).toISOString().slice(0, 10);
    const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);

    // Poopy usage: count poop events in last 7 days vs prior 7 days
    const thisWeekPoops = (safeGet(
      "SELECT COUNT(*) AS n FROM poops WHERE date(created_at) >= ?", weekAgo
    ) as { n: number } | null)?.n ?? 0;
    const lastWeekPoops = (safeGet(
      "SELECT COUNT(*) AS n FROM poops WHERE date(created_at) >= ? AND date(created_at) < ?", twoWeeksAgo, weekAgo
    ) as { n: number } | null)?.n ?? 0;

    // ZomBrains AI provider stats (this week)
    const providerStats = safeAll(
      `SELECT provider, COUNT(*) AS calls, SUM(tokens_in + tokens_out) AS tokens
       FROM zombrains_calls WHERE date(created_at) >= ? GROUP BY provider ORDER BY calls DESC LIMIT 6`,
      weekAgo,
    ) as { provider: string; calls: number; tokens: number }[];

    // ZomBrains call totals
    const zbCallTotal = (safeGet("SELECT COUNT(*) AS n FROM zombrains_calls") as { n: number } | null)?.n ?? 0;
    const zbCallWeek  = (safeGet("SELECT COUNT(*) AS n FROM zombrains_calls WHERE date(created_at) >= ?", weekAgo) as { n: number } | null)?.n ?? 0;

    // Thumbs-up ratio from Poopy AI feedback
    const thumbsTotal = (safeGet("SELECT COUNT(*) AS n FROM ai_feedback") as { n: number } | null)?.n ?? 0;
    const thumbsUp    = (safeGet("SELECT COUNT(*) AS n FROM ai_feedback WHERE feedback_type='thumbs_up'") as { n: number } | null)?.n ?? 0;

    // Library size + stale count
    const libCount = (safeGet("SELECT COUNT(*) AS n FROM zombrains_library") as { n: number } | null)?.n ?? 0;
    const libStale = (safeGet(
      "SELECT COUNT(*) AS n FROM zombrains_library WHERE julianday('now') - julianday(updated_at) >= 14"
    ) as { n: number } | null)?.n ?? 0;

    // Dead letter count — only unacknowledged/unsent alerts (sent_at IS NULL).
    // Cleared when admin clicks "Clear DL", which marks them all sent.
    const deadLetterCount = (safeGet("SELECT COUNT(*) AS n FROM zombrains_dead_letter_alerts WHERE sent_at IS NULL") as { n: number } | null)?.n ?? 0;

    // Failure log breakdown this week
    const failureTypes = safeAll(
      "SELECT failure_type, COUNT(*) AS cnt FROM zombrains_failure_log WHERE date(created_at) >= ? GROUP BY failure_type ORDER BY cnt DESC",
      weekAgo,
    ) as { failure_type: string; cnt: number }[];

    // Settings: last_report_at (for 10-min cooldown enforcement on bot side)
    const lastReportRow = db.prepare("SELECT value FROM zombrains_settings WHERE key='last_report_at'").get() as { value: string } | undefined;

    const weekChangePct = lastWeekPoops > 0
      ? Math.round(((thisWeekPoops - lastWeekPoops) / lastWeekPoops) * 100) : 0;
    const thumbsUpPct = thumbsTotal > 0 ? Math.round((thumbsUp / thumbsTotal) * 100) : 0;

    res.json({
      ok:          true,
      generatedAt: new Date().toISOString(),
      lastReportAt: lastReportRow?.value ?? null,
      poopy: { thisWeekPoops, lastWeekPoops, weekChangePct },
      zombrains: {
        callTotal: zbCallTotal, callWeek: zbCallWeek,
        providerStats, failureTypes, deadLetterCount,
        libraryEntries: libCount, libraryStale: libStale,
      },
      ai: { thumbsTotal, thumbsUpPct },
    });
  } finally { db.close(); }
});

// ── Worker queue helper — parse and save the main queue from SQLite ───────────
// The ZomBrains queue lives in SQLite (key='main'), stored as a JSON array of
// task objects. Saga tasks have additional fields:
//   steps:       Array<{ executor, prompt, status, retryCount, output? }>
//   currentStep: number (index into steps[])
//   workerLock:  null | { executor, lockedAt }
// Worker bots (Poopy, api-worker) poll GET /worker-queue and claim steps here.
// ZomBrains' queue.js pushes its local queue via POST /persist/queue, which
// merges incoming data to preserve active workerLocks (see persist/queue POST).
function getMainQueue(): unknown[] {
  const localDb = new Database(DB_PATH);
  try {
    const row = localDb.prepare("SELECT data FROM zombrains_queue WHERE key='main'").get() as { data: string } | undefined;
    if (!row?.data) return [];
    return JSON.parse(row.data) as unknown[];
  } catch { return []; }
  finally { localDb.close(); }
}

function saveMainQueue(queue: unknown[]): void {
  const localDb = new Database(DB_PATH);
  try {
    localDb.prepare(
      `INSERT INTO zombrains_queue (key, data, updated_at) VALUES ('main', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
    ).run(JSON.stringify(queue));
  } finally { localDb.close(); }
}

// Type guards for saga task shape
type SagaStep = {
  executor:    string;
  prompt:      string;
  status:      string;   // pending | running | done | failed
  retryCount?: number;
  output?:     string;
  completedAt?: string;
};

type SagaTask = {
  id:          string;
  prompt?:     string;
  status?:     string;
  steps:       SagaStep[];
  currentStep: number;
  workerLock:  null | { executor: string; lockedAt: number };
  stepState?:  Record<number, unknown>;
};

function isSagaTask(t: unknown): t is SagaTask {
  return (
    typeof t === "object" && t !== null &&
    Array.isArray((t as SagaTask).steps) &&
    typeof (t as SagaTask).currentStep === "number"
  );
}

// ── Fix #506 Step 3: seed local queue cache from Railway on api-server boot ────
// Called once from index.ts after startup. Non-fatal — if Railway is unreachable
// the local SQLite queue is used as-is (may be stale by up to 2 min).
export async function seedQueueFromRailway(): Promise<void> {
  const RAILWAY_URL = "https://builder-agent-production.up.railway.app";
  const r = await fetch(`${RAILWAY_URL}/queue-status`, {
    headers: { "x-admin-secret": process.env["ADMIN_SECRET"] ?? "" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) return;
  const data = await r.json() as unknown;
  // queue-status returns { queue: [...] } or just an array
  const arr = Array.isArray(data)
    ? data
    : (Array.isArray((data as { queue?: unknown[] }).queue) ? (data as { queue: unknown[] }).queue : null);
  if (!arr || !arr.length) return;
  // Only overwrite if Railway has more tasks than local cache — avoids nuking fresh work
  const local = getMainQueue();
  if (arr.length > local.length) {
    saveMainQueue(arr);
  }
}

// ── Fix #506 Step 5: push-ping endpoints ──────────────────────────────────────
// ZomBrains (Railway) calls POST /ping-worker when it creates a saga step for Poopy.
// Poopy polls GET /settings/worker-ping every 5s (cheap) and triggers an immediate
// work cycle the moment a new ping is detected — cuts wait from up to 30s to ≤5s.

const _workerPings: Record<string, number> = {}; // volatile — ok to lose on restart

router.post("/zombrains/ping-worker", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { executor, taskId } = req.body as { executor?: string; taskId?: string };
  if (!executor) { res.status(400).json({ ok: false, error: "executor required" }); return; }
  _workerPings[executor] = Date.now();
  res.json({ ok: true, executor, taskId: taskId ?? null });
});

router.get("/zombrains/settings/worker-ping", (req: Request, res: Response) => {
  if (!strictAuthCheck(req, res)) return;
  const executor = String(req.query["executor"] ?? "poopy");
  res.json({ ok: true, executor, pingAt: _workerPings[executor] ?? null });
});

// ── GET /api/zombrains/worker-queue ───────────────────────────────────────────
// Poopy polls this endpoint to claim a pending step assigned to it.
// Auth: x-zombrains-secret.
// Query param: executor (default "poopy")
//
// Returns { taskId, stepIndex, executor, prompt, stepState, totalSteps }
// or { task: null } if nothing is waiting.
//
// Safety rules:
//  - A step is only returned if workerLock is null (no double-claiming)
//  - Immediately sets workerLock to prevent race conditions
//  - Sets step status to "running" before returning
router.get("/zombrains/worker-queue", (req: Request, res: Response) => {
  if (!strictAuthCheck(req, res)) return;
  const executor = (req.query["executor"] as string | undefined) ?? "poopy";

  try {
    const queue = getMainQueue();
    let claimed: SagaTask | null = null;
    let claimedIdx = -1;

    for (let i = 0; i < queue.length; i++) {
      const task = queue[i];
      if (!isSagaTask(task)) continue;
      if (task.workerLock !== null) continue;       // already locked — skip
      if (task.status === "complete" || task.status === "dead_letter") continue;

      const stepIdx = task.currentStep;
      const step    = task.steps[stepIdx];
      if (!step) continue;
      if (step.executor !== executor) continue;
      if (step.status   !== "pending") continue;

      // Claim it
      task.workerLock       = { executor, lockedAt: Date.now() };
      task.steps[stepIdx]   = { ...step, status: "running" };
      claimed    = task;
      claimedIdx = i;
      queue[i]   = task;
      break;
    }

    if (!claimed || claimedIdx < 0) {
      res.json({ ok: true, task: null });
      return;
    }

    saveMainQueue(queue);
    const stepIdx   = claimed.currentStep;
    const rawPrompt = claimed.steps[stepIdx].prompt;

    // ── Step dedup: fingerprint on resolved content, not raw template ─────────
    // resolveWorkerPrompt mirrors client-side {{stepState.N}} substitution so two
    // steps with the same template but different stepState values get distinct keys.
    const resolvedForCache = resolveWorkerPrompt(rawPrompt, (claimed.stepState ?? {}) as Record<number, unknown>);
    const cachedOutput = stepCacheLookup(resolvedForCache);
    const claimedAny = claimed as Record<string, unknown>;
    if (cachedOutput !== null) {
      res.json({
        ok:          true,
        taskId:      claimed.id,
        stepIndex:   stepIdx,
        executor,
        prompt:      rawPrompt,
        stepState:   claimed.stepState ?? {},
        totalSteps:  claimed.steps.length,
        cacheHit:    true,
        cachedOutput,
        taskType:    (claimedAny["taskType"] as string | undefined) ?? null,
        taskDomain:  (claimedAny["taskDomain"] as string | undefined) ?? null,
      });
      return;
    }

    // ── Codec compression: compress tool names before handing to worker ───────
    const compressedPrompt = compressForWorker(rawPrompt);

    res.json({
      ok:         true,
      taskId:     claimed.id,
      stepIndex:  stepIdx,
      executor,
      prompt:     compressedPrompt,
      stepState:  claimed.stepState ?? {},
      totalSteps: claimed.steps.length,
      taskType:   (claimedAny["taskType"] as string | undefined) ?? null,
      taskDomain: (claimedAny["taskDomain"] as string | undefined) ?? null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ── POST /api/zombrains/worker-queue/:taskId/step-complete ────────────────────
// Called by any worker bot (Poopy, api-worker) when it finishes a step.
// Body: { stepIndex, output, executor, provider?, tokens?, latencyMs?, promptChars?, outputChars? }
// Auth: x-zombrains-secret or x-admin-secret.
//
// Safety: validates stepIndex matches currentStep and executor matches lock.
// Advances currentStep; if next step is zombrains, marks task pending.
// If no more steps: marks task done.
// Persists analytics to worker_step_events Postgres table (fire-and-forget).
router.post("/zombrains/worker-queue/:taskId/step-complete", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { taskId } = req.params;
  const { stepIndex, output, executor, provider, tokens, latencyMs, promptChars, outputChars } = req.body as {
    stepIndex?: number; output?: string; executor?: string;
    provider?: string; tokens?: number; latencyMs?: number;
    promptChars?: number; outputChars?: number;
  };

  if (typeof stepIndex !== "number" || !executor) {
    res.status(400).json({ ok: false, error: "stepIndex (number) and executor (string) required" });
    return;
  }

  try {
    const queue = getMainQueue();
    const taskPos = queue.findIndex(t => isSagaTask(t) && (t as SagaTask).id === taskId);
    if (taskPos < 0) {
      res.status(404).json({ ok: false, error: `Task ${taskId} not found in queue` });
      return;
    }

    const task = queue[taskPos] as SagaTask;

    // Validate step index matches currentStep
    if (task.currentStep !== stepIndex) {
      res.status(409).json({
        ok: false,
        error: `stepIndex mismatch: expected ${task.currentStep}, got ${stepIndex}`,
      });
      return;
    }

    // Validate executor matches lock
    if (!task.workerLock || task.workerLock.executor !== executor) {
      res.status(409).json({
        ok: false,
        error: `Lock mismatch: task is locked by ${task.workerLock?.executor ?? "nobody"}`,
      });
      return;
    }

    // Mark step done
    const step              = task.steps[stepIndex];
    const stepPrompt        = step.prompt ?? "";
    // Snapshot stepState *before* writing this step's output — mirrors what
    // the worker resolved when it executed the step (pre-completion context).
    const stepStateSnapshot = { ...(task.stepState ?? {}) } as Record<number, unknown>;
    task.steps[stepIndex] = {
      ...step,
      status:      "done",
      output:      output ?? "",
      completedAt: new Date().toISOString(),
    };

    // Store output in stepState for downstream steps to read
    if (!task.stepState) task.stepState = {};
    task.stepState[stepIndex] = output ?? "";

    // Clear lock and advance
    task.workerLock = null;
    task.currentStep = stepIndex + 1;

    // Accumulate saga step tokens (memory-only — used for task_log write when saga completes)
    if (typeof tokens === "number" && tokens > 0) {
      const _rec = task as unknown as Record<string, unknown>;
      _rec._sagaTokens = ((_rec._sagaTokens as number | undefined) ?? 0) + tokens;
    }

    // Determine next state
    if (task.currentStep >= task.steps.length) {
      // All steps complete — mark task done and aggregate tokens to task_log
      (task as unknown as Record<string, unknown>).status = "complete";
      const _totalSagaTokens = ((task as unknown as Record<string, unknown>)._sagaTokens as number | undefined) ?? 0;
      if (_totalSagaTokens > 0) {
        try {
          const mDb = getDb();
          try {
            mDb.prepare("UPDATE zombrains_task_log SET tokens_in = tokens_in + ? WHERE task_id = ?")
              .run(_totalSagaTokens, String(taskId));
          } finally { mDb.close(); }
        } catch (_) { /* non-fatal — task_log row may not exist yet for worker-bot sagas */ }
      }
    } else {
      // Next step exists — if it's zombrains, mark task pending so ZomBrains picks it up
      const nextStep = task.steps[task.currentStep];
      if (nextStep?.executor === "zombrains") {
        (task as unknown as Record<string, unknown>).status = "pending";
      }
    }

    queue[taskPos] = task;
    saveMainQueue(queue);

    // ── Dedup cache: store completed output for future Jaccard lookup ──────────
    // Use the resolved prompt (stepStateSnapshot taken before this step's output
    // was written) so the fingerprint matches the GET-side lookup exactly.
    stepCacheStore(resolveWorkerPrompt(stepPrompt, stepStateSnapshot), output ?? "");

    // Persist step event to Postgres (fire-and-forget — never block the response)
    db.insert(workerStepEventsTable).values({
      executor:     executor,
      task_id:      String(taskId),
      step_index:   stepIndex,
      outcome:      provider === "cache" ? "cache_hit" : "complete",
      provider:     provider ?? null,
      tokens:       tokens ?? null,
      latency_ms:   latencyMs ?? null,
      prompt_chars: promptChars ?? null,
      output_chars: outputChars ?? null,
      error_msg:    null,
    }).then(() => {
      // Ring-buffer: keep last 2000 rows
      return db.execute(sql`DELETE FROM worker_step_events WHERE id IN (SELECT id FROM worker_step_events ORDER BY ts ASC LIMIT GREATEST(0, (SELECT COUNT(*) FROM worker_step_events) - 2000))`);
    }).catch(() => { /* non-fatal */ });

    res.json({ ok: true, taskId, nextStep: task.currentStep, taskStatus: (task as unknown as Record<string, unknown>).status });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ── POST /api/zombrains/worker-queue/:taskId/step-failed ──────────────────────
// Called by any worker bot (Poopy, api-worker) when a step fails.
// Body: { stepIndex, error, executor, provider?, tokens?, latencyMs?, promptChars? }
// Auth: x-zombrains-secret or x-admin-secret.
//
// Safety: increments retryCount. If < 3: resets step to pending, clears lock.
// If >= 3: marks step and task dead_letter, clears lock.
// Persists analytics to worker_step_events Postgres table (fire-and-forget).
router.post("/zombrains/worker-queue/:taskId/step-failed", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { taskId } = req.params;
  const { stepIndex, error: stepError, executor, provider, tokens, latencyMs, promptChars } = req.body as {
    stepIndex?: number; error?: string; executor?: string;
    provider?: string; tokens?: number; latencyMs?: number; promptChars?: number;
  };

  if (typeof stepIndex !== "number" || !executor) {
    res.status(400).json({ ok: false, error: "stepIndex (number) and executor (string) required" });
    return;
  }

  try {
    const queue = getMainQueue();
    const taskPos = queue.findIndex(t => isSagaTask(t) && (t as SagaTask).id === taskId);
    if (taskPos < 0) {
      res.status(404).json({ ok: false, error: `Task ${taskId} not found` });
      return;
    }

    const task = queue[taskPos] as SagaTask;
    const step = task.steps[stepIndex];
    if (!step) {
      res.status(404).json({ ok: false, error: `Step ${stepIndex} not found on task ${taskId}` });
      return;
    }

    // Validate step index matches currentStep (mirror of step-complete safety check)
    if (task.currentStep !== stepIndex) {
      res.status(409).json({
        ok: false,
        error: `stepIndex mismatch: expected ${task.currentStep}, got ${stepIndex}`,
      });
      return;
    }

    // Validate executor matches lock (prevents stale/out-of-order failure reports)
    if (!task.workerLock || task.workerLock.executor !== executor) {
      res.status(409).json({
        ok: false,
        error: `Lock mismatch: task is locked by ${task.workerLock?.executor ?? "nobody"}`,
      });
      return;
    }

    const retryCount = (step.retryCount ?? 0) + 1;

    if (retryCount < 3) {
      // Retry: reset step to pending, clear lock
      task.steps[stepIndex] = { ...step, status: "pending", retryCount };
      task.workerLock = null;
    } else {
      // Dead letter: too many retries
      task.steps[stepIndex] = { ...step, status: "failed", retryCount };
      task.workerLock = null;
      (task as unknown as Record<string, unknown>).status = "dead_letter";
    }

    queue[taskPos] = task;
    saveMainQueue(queue);

    // Persist step event to Postgres (fire-and-forget)
    db.insert(workerStepEventsTable).values({
      executor:     executor,
      task_id:      String(taskId),
      step_index:   stepIndex,
      outcome:      "failed",
      provider:     provider ?? null,
      tokens:       tokens ?? null,
      latency_ms:   latencyMs ?? null,
      prompt_chars: promptChars ?? null,
      output_chars: null,
      error_msg:    stepError ? String(stepError).slice(0, 500) : null,
    }).then(() => {
      return db.execute(sql`DELETE FROM worker_step_events WHERE id IN (SELECT id FROM worker_step_events ORDER BY ts ASC LIMIT GREATEST(0, (SELECT COUNT(*) FROM worker_step_events) - 2000))`);
    }).catch(() => { /* non-fatal */ });

    res.json({
      ok:         true,
      taskId,
      stepIndex,
      retryCount,
      action:     retryCount < 3 ? "retrying" : "dead_lettered",
      taskStatus: (task as unknown as Record<string, unknown>).status,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

// Emergency AI proxy — canonical implementation is in aiProxy.ts (POST /api/ai/proxy/emergency).

// ── Memory telemetry — POST /api/zombrains/memory-stats/track ─────────────────
// Called fire-and-forget by recall_task_output + search_task_outputs tools.
// Upserts a daily call-count record and appends connection entries when matches found.
// Stored in zombrains_library under title=memory_telemetry:YYYY-MM-DD, category=memory_telemetry.
router.post("/zombrains/memory-stats/track", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { tool, taskId, topic, foundTaskIds } = req.body as {
    tool: string; taskId?: string; topic?: string; foundTaskIds?: string[];
  };
  if (!tool) { res.status(400).json({ error: "tool required" }); return; }
  const today = new Date().toISOString().slice(0, 10);
  const key = `memory_telemetry:${today}`;
  const db = getDb();
  try {
    const existing = db.prepare("SELECT content FROM zombrains_library WHERE title = ?").get(key) as { content: string } | undefined;
    let record: {
      date: string;
      calls: Record<string, number>;
      connections: Array<{ tool: string; taskId?: string; topic?: string; foundTaskIds?: string[]; timestamp: string }>;
    };
    if (existing) {
      try { record = JSON.parse(existing.content); } catch { record = { date: today, calls: {}, connections: [] }; }
    } else {
      record = { date: today, calls: {}, connections: [] };
    }
    record.calls[tool] = (record.calls[tool] ?? 0) + 1;
    if (foundTaskIds?.length || topic) {
      record.connections.push({ tool, taskId, topic, foundTaskIds, timestamp: new Date().toISOString() });
      if (record.connections.length > 200) record.connections = record.connections.slice(-200);
    }
    db.prepare(`
      INSERT INTO zombrains_library (title, content, category, source_file, tags, expires_at)
      VALUES (?, ?, 'memory_telemetry', NULL, NULL, datetime('now', '+8 days'))
      ON CONFLICT(title) DO UPDATE SET content = excluded.content, updated_at = datetime('now')
    `).run(key, JSON.stringify(record));
    db.close();
    res.json({ ok: true });
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── Memory telemetry — GET /api/zombrains/memory-stats ────────────────────────
// Returns last 7 days of memory_telemetry records: calls per tool per day + connection log.
// Auth-gated. Used by admin panel Knowledge section.
router.get("/zombrains/memory-stats", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT title, content, updated_at FROM zombrains_library
      WHERE category = 'memory_telemetry'
      ORDER BY updated_at DESC
      LIMIT 7
    `).all() as { title: string; content: string; updated_at: string }[];
    db.close();
    const days = rows.map(r => {
      try { return JSON.parse(r.content); }
      catch { return { date: r.title.replace("memory_telemetry:", ""), calls: {}, connections: [] }; }
    });
    res.json({ ok: true, days });
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── GET /api/zombrains/worker-queue/connectivity-check ────────────────────────
// Phase 0: Returns worker-bot connectivity data. `workerBotSeen: false` means
// step data has never reached Monitor — likely API_BASE_URL is still localhost.
router.get("/zombrains/worker-queue/connectivity-check", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const rows = await db.select({
      lastStepAt: sql<string>`MAX(${workerStepEventsTable.ts})::text`,
      totalSteps: sql<number>`COUNT(*)::int`,
    }).from(workerStepEventsTable);
    const row = rows[0];
    const totalSteps    = row?.totalSteps ?? 0;
    const workerBotSeen = totalSteps > 0;
    res.json({ ok: true, workerBotSeen, lastStepAt: row?.lastStepAt ?? null, totalSteps });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ── Fast-path toggle ──────────────────────────────────────────────────────────
// Stored as zombrains_settings key 'disable_fast_path'.
// ZomBrains polls this every 60s and applies it without a Railway restart.
// The env var DISABLE_FAST_PATH=true is still respected as a hard override.

router.get("/zombrains/settings/fast-path", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM zombrains_settings WHERE key='disable_fast_path'").get() as { value: string } | undefined;
    res.json({ ok: true, disabled: row?.value === "true" });
  } catch {
    res.json({ ok: true, disabled: false });
  } finally { db.close(); }
});

router.patch("/zombrains/settings/fast-path", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { disabled } = req.body as { disabled?: boolean };
  if (typeof disabled !== "boolean") { res.status(400).json({ ok: false, error: "disabled must be boolean" }); return; }
  const db = getDb();
  try {
    db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('disable_fast_path', ?)").run(disabled ? "true" : "false");
    res.json({ ok: true, disabled });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally { db.close(); }
});

export default router;
export { getLiveWorkers, getAllWorkers };
