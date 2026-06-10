// ══════════════════════════════════════════════════════════════════════════════
// zombrains-shared.ts — Shared helpers, DB, auth, and constants
// Imported by zombrains.ts, zombrains-workers.ts, zombrains-quality.ts,
// zombrains-files.ts. Nothing else should import from this module.
// ══════════════════════════════════════════════════════════════════════════════
import { type Request, type Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { callProvider, type Msg } from "../lib/providers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH;
export const DB_PATH = _volumeRoot
  ? path.join(_volumeRoot, "poop_tracker.db")
  : path.resolve(__dirname, "..", "..", "..", "poop_tracker.db");

function getDb() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS zombrains_reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT    NOT NULL DEFAULT 'info',
      task        TEXT,
      message     TEXT    NOT NULL,
      data        TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS zombrains_queue (
      key        TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS zombrains_relay (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_label  TEXT    NOT NULL,
      files_json  TEXT    NOT NULL,
      sent        INTEGER NOT NULL DEFAULT 0,
      ts          TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS relay_outbox (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL DEFAULT 'patch',
      payload    TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'replit',
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at TEXT,
      done_at    TEXT
    );
    CREATE TABLE IF NOT EXISTS zombrains_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      level      TEXT NOT NULL,
      module     TEXT,
      msg        TEXT NOT NULL,
      detail     TEXT,
      stack      TEXT,
      ts         TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS zombrains_progress (
      task_id    TEXT PRIMARY KEY,
      history    TEXT NOT NULL,
      step       INTEGER NOT NULL DEFAULT 0,
      work_dir   TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS zombrains_proposals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT    NOT NULL,
      description  TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      revised_text TEXT,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    /* sort_order added via migration below */
    CREATE TABLE IF NOT EXISTS zombrains_failure_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      TEXT    NOT NULL,
      task_prompt  TEXT    NOT NULL,
      error_msg    TEXT    NOT NULL,
      failure_type TEXT    NOT NULL DEFAULT 'unknown',
      retry_count  INTEGER NOT NULL DEFAULT 0,
      history      TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS zombrains_library (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL UNIQUE,
      content     TEXT    NOT NULL,
      category    TEXT    NOT NULL DEFAULT 'knowledge',
      source_file TEXT,
      tags        TEXT,
      used_count  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS zombrains_library_fts
      USING fts5(title, content, content=zombrains_library, content_rowid=id);
    CREATE TRIGGER IF NOT EXISTS zl_ai AFTER INSERT ON zombrains_library BEGIN
      INSERT INTO zombrains_library_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS zl_au AFTER UPDATE ON zombrains_library BEGIN
      INSERT INTO zombrains_library_fts(zombrains_library_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
      INSERT INTO zombrains_library_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS zl_ad AFTER DELETE ON zombrains_library BEGIN
      INSERT INTO zombrains_library_fts(zombrains_library_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
    END;
    CREATE TABLE IF NOT EXISTS zb_knowledge_hits (
      title       TEXT    PRIMARY KEY,
      hit_count   INTEGER NOT NULL DEFAULT 1,
      last_hit_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS zombrains_calls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id    TEXT,
      user_id     TEXT,
      prompt      TEXT    NOT NULL,
      response    TEXT    NOT NULL,
      provider    TEXT    NOT NULL,
      tokens_in   INTEGER NOT NULL DEFAULT 0,
      tokens_out  INTEGER NOT NULL DEFAULT 0,
      rating      INTEGER,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS zombrains_provider_stats (
      provider    TEXT NOT NULL,
      date        TEXT NOT NULL,
      call_count  INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider, date)
    );
    CREATE TABLE IF NOT EXISTS zombrains_dead_letter_alerts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL,
      prompt     TEXT NOT NULL DEFAULT '',
      reason     TEXT NOT NULL DEFAULT '',
      sent_at    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS zombrains_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS zombrains_capability_gaps (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id            TEXT    NOT NULL,
      task_prompt        TEXT    NOT NULL DEFAULT '',
      gap_description    TEXT    NOT NULL DEFAULT '',
      feasibility_result TEXT    NOT NULL DEFAULT 'unknown',
      feasibility_reason TEXT    NOT NULL DEFAULT '',
      outcome            TEXT    NOT NULL DEFAULT '',
      dismissed          INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS zombrains_goals (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title          TEXT    NOT NULL,
      description    TEXT,
      status         TEXT    NOT NULL DEFAULT 'active',
      priority       INTEGER NOT NULL DEFAULT 5,
      source         TEXT    NOT NULL DEFAULT 'zombrains',
      progress_notes TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// ── Schema migrations (idempotent) ────────────────────────────────────────────
{
  const _db = new Database(DB_PATH);
  try { _db.exec("ALTER TABLE zombrains_proposals ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
  try { _db.exec("ALTER TABLE zombrains_proposals ADD COLUMN type TEXT NOT NULL DEFAULT 'task'"); } catch (_) {}
  try { _db.exec("ALTER TABLE zombrains_proposals ADD COLUMN tool_metadata TEXT"); } catch (_) {}
  try { _db.exec("ALTER TABLE zombrains_proposals ADD COLUMN has_code INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
  try { _db.exec("ALTER TABLE zombrains_proposals ADD COLUMN discord_message_id TEXT"); } catch (_) {}
  try { _db.exec("ALTER TABLE zombrains_proposals ADD COLUMN discord_channel_id TEXT"); } catch (_) {}
  try {
    _db.exec(`CREATE TABLE IF NOT EXISTS zombrains_loop_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      gap_id      TEXT,
      task_id     TEXT,
      event_type  TEXT NOT NULL,
      tool_name   TEXT,
      details     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  } catch (_) {}
  // Known-problems table (from self-diagnosis / task #302)
  try {
    _db.exec(`CREATE TABLE IF NOT EXISTS zombrains_known_problems (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      description  TEXT NOT NULL,
      severity     TEXT NOT NULL DEFAULT 'warning',
      context      TEXT,
      fix_attempts INTEGER NOT NULL DEFAULT 0,
      resolved     INTEGER NOT NULL DEFAULT 0,
      first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen    TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  } catch (_) {}
  // zombrains_tools: per-tool registry synced from Railway — survives Railway redeploys
  try {
    _db.exec(`CREATE TABLE IF NOT EXISTS zombrains_tools (
      name              TEXT PRIMARY KEY,
      description       TEXT NOT NULL,
      parameters_schema TEXT NOT NULL,
      execute_code      TEXT NOT NULL,
      verified          INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  } catch (_) {}
  // prompt_index: canonical prompt compression codebook — namespace codes → tool names.
  // ZomBrains syncs this on boot; Monitor (api-server) is the source of truth.
  try {
    _db.exec(`CREATE TABLE IF NOT EXISTS prompt_index (
      code              TEXT PRIMARY KEY,
      full_name         TEXT NOT NULL UNIQUE,
      namespace         TEXT NOT NULL,
      deprecated        INTEGER NOT NULL DEFAULT 0,
      deprecated_succ   TEXT,
      version_added     INTEGER NOT NULL DEFAULT 1,
      usage_count       INTEGER NOT NULL DEFAULT 0,
      last_used_at      TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  } catch (_) {}
  // risk_tier: low = auto-approve eligible, medium = human review, high = always wait
  try { _db.exec("ALTER TABLE zombrains_proposals ADD COLUMN risk_tier TEXT NOT NULL DEFAULT 'medium'"); } catch (_) {}
  try { _db.exec("ALTER TABLE zombrains_proposals ADD COLUMN reviewer_note TEXT"); } catch (_) {}
  // requires_replit_change: 1 when the proposal needs Replit-side code (routes/admin/schema) before ZomBrains can execute
  try { _db.exec("ALTER TABLE zombrains_proposals ADD COLUMN requires_replit_change INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
  try { _db.exec("ALTER TABLE zombrains_proposals ADD COLUMN replit_notes TEXT"); } catch (_) {}
  // response_ms: per-call LLM latency (already computed in ai.js, now persisted)
  try { _db.exec("ALTER TABLE zombrains_calls ADD COLUMN response_ms INTEGER"); } catch (_) {}
  // zombrains_task_log: one row per completed/failed/dead-lettered task
  try {
    _db.exec(`CREATE TABLE IF NOT EXISTS zombrains_task_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      TEXT    NOT NULL,
      prompt       TEXT    NOT NULL DEFAULT '',
      outcome      TEXT    NOT NULL DEFAULT 'unknown',
      duration_ms  INTEGER,
      provider     TEXT,
      tokens_in    INTEGER NOT NULL DEFAULT 0,
      tokens_out   INTEGER NOT NULL DEFAULT 0,
      had_code     INTEGER NOT NULL DEFAULT 0,
      tools_called TEXT,
      error_msg    TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    )`);
  } catch (_) {}
  try {
    _db.exec(`CREATE TABLE IF NOT EXISTS zb_ai_quality (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id          TEXT    NOT NULL,
      prompt           TEXT    NOT NULL DEFAULT '',
      diff_summary     TEXT,
      outcome          TEXT    NOT NULL DEFAULT 'done',
      ai_score         INTEGER,
      ai_reasoning     TEXT,
      completion_score INTEGER,
      evaluated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    )`);
  } catch (_) {}
  try { _db.exec("ALTER TABLE zb_ai_quality ADD COLUMN deploy_healthy INTEGER"); } catch (_) {}
  try { _db.exec("ALTER TABLE zb_ai_quality ADD COLUMN task_domain TEXT"); } catch (_) {}
  // expires_at: error_pattern entries auto-expire after 30 days; other categories leave it null
  try { _db.exec("ALTER TABLE zombrains_library ADD COLUMN expires_at TEXT"); } catch (_) {}
  // dl_type_counts: persist dead-letter failure type counts across Railway restarts/deploys
  _db.exec(`CREATE TABLE IF NOT EXISTS zombrains_dl_type_counts (
    type_key   TEXT PRIMARY KEY,
    count      INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  // restart_log: persist Railway restart history across container resets (fresh deploys wipe /app/)
  _db.exec(`CREATE TABLE IF NOT EXISTS zombrains_restart_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT UNIQUE NOT NULL,
    uptime_ms INTEGER
  )`);
  // ghost_observations: one row per Ghost Mode task — specialist performance data consumed by crystalline evolver
  _db.exec(`CREATE TABLE IF NOT EXISTS zombrains_ghost_observations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    specialist_id   TEXT    NOT NULL,
    task_id         TEXT    NOT NULL,
    task_type       TEXT    NOT NULL DEFAULT '',
    specialist_plan TEXT,
    actual_outcome  TEXT    NOT NULL DEFAULT 'done',
    failures        TEXT,
    confidence      REAL    NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  // zombeef_render_jobs: ZomBrains queues music video render jobs here;
  // ZomBeef Suite bot polls for pending jobs and processes them via renderVisualizer.
  // Fresh installs get the full schema; upgrades get the new columns added idempotently.
  _db.exec(`CREATE TABLE IF NOT EXISTS zombeef_render_jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_url             TEXT    NOT NULL,
    background_url        TEXT    NOT NULL DEFAULT '',
    title                 TEXT    NOT NULL,
    artist                TEXT    NOT NULL DEFAULT '',
    style                 TEXT    NOT NULL DEFAULT 'frequency_bars',
    color                 TEXT    NOT NULL DEFAULT 'D39A45',
    format                TEXT    NOT NULL DEFAULT 'landscape',
    normalize             INTEGER NOT NULL DEFAULT 0,
    requester_discord_id  TEXT,
    status                TEXT    NOT NULL DEFAULT 'pending',
    result_url            TEXT,
    error_msg             TEXT,
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  // Additive migrations for installs that have the old schema (background_url/format/
  // requester_discord_id/result_url may be absent if the table was created before this fix).
  for (const col of [
    "background_url        TEXT NOT NULL DEFAULT ''",
    "format                TEXT NOT NULL DEFAULT 'landscape'",
    "requester_discord_id  TEXT",
    "result_url            TEXT",
    "email_sent            INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { _db.exec(`ALTER TABLE zombeef_render_jobs ADD COLUMN ${col}`); } catch { /* already exists */ }
  }
  // failure_crystals: per-error-signature failure crystal ring buffer (Task #450)
  // 90-day TTL + 500-entry cap enforced at write time. Deduplication by errorSignature within 24h.
  _db.exec(`CREATE TABLE IF NOT EXISTS failure_crystals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    error_signature TEXT    NOT NULL UNIQUE,
    pattern         TEXT    NOT NULL DEFAULT '',
    task_domain     TEXT    NOT NULL DEFAULT 'general',
    failure_type    TEXT    NOT NULL DEFAULT 'unknown',
    provider        TEXT    NOT NULL DEFAULT 'unknown',
    count           INTEGER NOT NULL DEFAULT 1,
    last_seen       TEXT    NOT NULL DEFAULT (datetime('now')),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  // anti_crystals: patterns to exclude from Boot Compiler specialist synthesis (Task #450)
  // Written when persistent error patterns have no corresponding successes in 14 days.
  _db.exec(`CREATE TABLE IF NOT EXISTS anti_crystals (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern           TEXT    NOT NULL,
    task_domain       TEXT    NOT NULL DEFAULT 'general',
    suspended_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    suspend_reason    TEXT    NOT NULL DEFAULT 'persistent_error_pattern',
    failure_count     INTEGER NOT NULL DEFAULT 1,
    quality_score_avg REAL,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  // session_crystals: ring buffer of success/failure/anti crystals written on SIGTERM + 4h checkpoint.
  // type column added by #445b — idempotent ALTER TABLE guards missing column.
  try { _db.exec("ALTER TABLE session_crystals ADD COLUMN type TEXT NOT NULL DEFAULT 'success'"); } catch (_) {}
  // domain/quality_gate/error_class added by #668 — idempotent guards.
  try { _db.exec("ALTER TABLE session_crystals ADD COLUMN domain TEXT"); } catch (_) {}
  try { _db.exec("ALTER TABLE session_crystals ADD COLUMN quality_gate INTEGER DEFAULT 1"); } catch (_) {}
  try { _db.exec("ALTER TABLE session_crystals ADD COLUMN error_class TEXT"); } catch (_) {}

  // session_crystals: ring buffer of success crystals written on SIGTERM + 4h checkpoint.
  // 90-day TTL + 500-entry cap per executor enforced at write time by Monitor POST endpoint.
  _db.exec(`CREATE TABLE IF NOT EXISTS session_crystals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    executor     TEXT    NOT NULL DEFAULT 'zombrains',
    timestamp    TEXT    NOT NULL,
    interim      INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT    NOT NULL,
    prev_hash    TEXT,
    payload      TEXT    NOT NULL,
    domain       TEXT,
    quality_gate INTEGER DEFAULT 1,
    error_class  TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  try { _db.exec("ALTER TABLE zombrains_task_log ADD COLUMN task_type TEXT"); } catch (_) {}
  _db.exec(`CREATE TABLE IF NOT EXISTS compression_baseline (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id            TEXT    NOT NULL,
    task_type          TEXT    NOT NULL DEFAULT 'general',
    llm_call_count     INTEGER NOT NULL DEFAULT 0,
    tool_call_count    INTEGER NOT NULL DEFAULT 0,
    tokens_in          INTEGER NOT NULL DEFAULT 0,
    tokens_out         INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    provider           TEXT,
    outcome            TEXT    NOT NULL DEFAULT 'unknown',
    source             TEXT    NOT NULL DEFAULT 'llm',
    created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  // ── Crystalline Phase 2: Ghost Mode observations + compiled specialists ───────
  _db.exec(`CREATE TABLE IF NOT EXISTS ghost_observations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    specialist_id   TEXT    NOT NULL,
    task_id         TEXT    NOT NULL,
    task_type       TEXT    NOT NULL DEFAULT '',
    specialist_plan TEXT    NOT NULL DEFAULT '[]',
    actual_outcome  TEXT    NOT NULL DEFAULT 'unknown',
    failures        TEXT    NOT NULL DEFAULT '[]',
    confidence      REAL    NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  _db.exec(`CREATE TABLE IF NOT EXISTS specialists (
    specialist_id         TEXT    PRIMARY KEY,
    task_type             TEXT    NOT NULL,
    version               INTEGER NOT NULL DEFAULT 1,
    status                TEXT    NOT NULL DEFAULT 'ghost',
    confidence            REAL    NOT NULL DEFAULT 0,
    evidence_count        INTEGER NOT NULL DEFAULT 0,
    failure_rate          REAL    NOT NULL DEFAULT 0,
    execution_plan        TEXT    NOT NULL DEFAULT '[]',
    causal_evidence       TEXT    NOT NULL DEFAULT '{}',
    behavioral_state_hash TEXT,
    compiled_at           TEXT,
    last_used_at          TEXT,
    expiration_date       TEXT,
    created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  // dead_letter_triage_log: one row per triage cycle — feeds admin history + trend detection.
  _db.exec(`CREATE TABLE IF NOT EXISTS dead_letter_triage_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle        INTEGER NOT NULL DEFAULT 0,
    pruned       INTEGER NOT NULL DEFAULT 0,
    rescued      INTEGER NOT NULL DEFAULT 0,
    skipped      INTEGER NOT NULL DEFAULT 0,
    total_before INTEGER NOT NULL DEFAULT 0,
    crisis_mode  INTEGER NOT NULL DEFAULT 0,
    stale_pruned INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);
  // ── Crystal persistence ledger (Task #620) ────────────────────────────────────
  // crystal_ledger: one row per unique crystal hash, ever. Append-only at row level.
  _db.exec(`CREATE TABLE IF NOT EXISTS crystal_ledger (
    hash                  TEXT PRIMARY KEY,
    type                  TEXT NOT NULL,
    domain                TEXT,
    source_type           TEXT,
    provider              TEXT,
    quality_score         REAL,
    token_count           INTEGER,
    latency_ms            INTEGER,
    tools_used            TEXT,
    persona               TEXT,
    task_id               TEXT,
    tags                  TEXT NOT NULL DEFAULT '[]',
    activation_count      INTEGER DEFAULT 0,
    relevance_score       REAL DEFAULT 0,
    entanglement_count    INTEGER DEFAULT 0,
    entanglement_tier_max INTEGER DEFAULT 0,
    created_at            TEXT NOT NULL,
    last_activated        TEXT,
    payload               TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_type     ON crystal_ledger(type);
  CREATE INDEX IF NOT EXISTS idx_ledger_domain   ON crystal_ledger(domain);
  CREATE INDEX IF NOT EXISTS idx_ledger_provider ON crystal_ledger(provider);
  CREATE INDEX IF NOT EXISTS idx_ledger_created  ON crystal_ledger(created_at);
  CREATE INDEX IF NOT EXISTS idx_ledger_quality  ON crystal_ledger(quality_score DESC);
  CREATE INDEX IF NOT EXISTS idx_ledger_relevance ON crystal_ledger(relevance_score DESC)`);
  // crystal_combinations: one row per co-activation pair (hash_a < hash_b always).
  _db.exec(`CREATE TABLE IF NOT EXISTS crystal_combinations (
    hash_a              TEXT NOT NULL,
    hash_b              TEXT NOT NULL,
    co_activation_count INTEGER DEFAULT 1,
    score               REAL DEFAULT 0,
    tier                INTEGER DEFAULT 1,
    tier_label          TEXT DEFAULT 'T1:OBSERVED',
    process             TEXT NOT NULL,
    domain_a            TEXT,
    domain_b            TEXT,
    cross_domain        INTEGER DEFAULT 0,
    first_seen          TEXT NOT NULL,
    last_seen           TEXT NOT NULL,
    last_context        TEXT,
    PRIMARY KEY (hash_a, hash_b)
  );
  CREATE INDEX IF NOT EXISTS idx_comb_hash_a  ON crystal_combinations(hash_a, score DESC);
  CREATE INDEX IF NOT EXISTS idx_comb_hash_b  ON crystal_combinations(hash_b, score DESC);
  CREATE INDEX IF NOT EXISTS idx_comb_tier    ON crystal_combinations(tier DESC);
  CREATE INDEX IF NOT EXISTS idx_comb_process ON crystal_combinations(process);
  CREATE INDEX IF NOT EXISTS idx_comb_cross   ON crystal_combinations(cross_domain, tier DESC)`);
  // crystal_events: full audit log of every state change. Append-only, never updated.
  _db.exec(`CREATE TABLE IF NOT EXISTS crystal_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type   TEXT NOT NULL,
    crystal_hash TEXT NOT NULL,
    related_hash TEXT,
    tier_before  INTEGER,
    tier_after   INTEGER,
    event_data   TEXT,
    timestamp    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_hash      ON crystal_events(crystal_hash);
  CREATE INDEX IF NOT EXISTS idx_events_type      ON crystal_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON crystal_events(timestamp)`);
  // crystal_patterns: materialized pattern analysis, refreshed every 6h by api-server.
  _db.exec(`CREATE TABLE IF NOT EXISTS crystal_patterns (
    id           TEXT PRIMARY KEY,
    pattern_type TEXT NOT NULL,
    domain       TEXT,
    confidence   REAL,
    sample_size  INTEGER,
    pattern_data TEXT NOT NULL,
    computed_at  TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  )`);
  // idle_task_log: ring buffer for idle generator distribution monitoring (30-day TTL, 2000 row cap).
  _db.exec(`CREATE TABLE IF NOT EXISTS idle_task_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT    NOT NULL,
    task_domain TEXT    NOT NULL DEFAULT '',
    ts          TEXT    NOT NULL DEFAULT (datetime('now')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_idle_task_log_created ON idle_task_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_idle_task_log_domain  ON idle_task_log(task_domain)`);
  // worker_outcome_log: ring buffer of per-step outcomes from Poopy and Birthday Bot
  // (1000 rows per executor, 30-day TTL, enforced on write by the POST endpoint).
  _db.exec(`CREATE TABLE IF NOT EXISTS worker_outcome_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    executor       TEXT    NOT NULL,
    task_type      TEXT,
    task_domain    TEXT,
    outcome        TEXT    NOT NULL,
    latency_ms     INTEGER,
    provider       TEXT,
    failure_reason TEXT,
    logged_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_worker_outcome_executor ON worker_outcome_log(executor);
  CREATE INDEX IF NOT EXISTS idx_worker_outcome_logged   ON worker_outcome_log(logged_at)`);
  _db.close();
}

// ── Library helpers ────────────────────────────────────────────────────────────

type LibraryRow = {
  id: number; title: string; content: string; category: string;
  source_file: string | null; tags: string | null;
  used_count: number; created_at: string; updated_at: string;
  expires_at: string | null;
};

function addStalenessWarning(entry: LibraryRow): LibraryRow {
  const daysAgo = Math.floor((Date.now() - new Date(entry.updated_at).getTime()) / 86_400_000);
  if (daysAgo >= 14) {
    return { ...entry, content: `${entry.content}\n\n[STALE — last updated ${daysAgo} days ago]` };
  }
  return entry;
}

function getExpectedSecret(): string | null {
  try {
    const db = new Database(DB_PATH);
    const row = db.prepare("SELECT value FROM bot_settings WHERE key='admin_secret'").get() as { value: string } | undefined;
    db.close();
    if (row?.value) return row.value;
  } catch { /* fall through */ }
  return process.env["ADMIN_SECRET"] ?? null;
}

function getExpectedViewSecret(): string | null {
  try {
    const db = new Database(DB_PATH);
    const row = db.prepare("SELECT value FROM bot_settings WHERE key='zombrains_view_secret'").get() as { value: string } | undefined;
    db.close();
    return row?.value ?? null;
  } catch { return null; }
}

function authCheck(req: Request, res: Response): boolean {
  const expected = getExpectedSecret();
  if (!expected) return true;
  const token = (req.headers["x-zombrains-secret"] ?? req.headers["x-admin-secret"] ?? req.headers["authorization"]?.replace("Bearer ", "")) as string | undefined;
  if (token === expected) return true;
  // GET requests also accept the viewer secret (read-only access)
  if (req.method === "GET") {
    const viewSecret = getExpectedViewSecret();
    if (viewSecret && token === viewSecret) return true;
  }
  res.status(401).json({ error: "Unauthorized" });
  return false;
}

// Strict admin-only auth — never accepts viewer secret regardless of HTTP method.
// Use for endpoints that expose sensitive internals (error stacks, logs, secrets).
function strictAuthCheck(req: Request, res: Response): boolean {
  const expected = getExpectedSecret();
  if (!expected) return true;
  const token = (req.headers["x-zombrains-secret"] ?? req.headers["x-admin-secret"] ?? req.headers["authorization"]?.replace("Bearer ", "")) as string | undefined;
  if (token === expected) return true;
  res.status(401).json({ error: "Unauthorized" });
  return false;
}

// Read-only auth: no token = view access allowed; wrong non-empty token = 401.
// Use this for GET endpoints that should be visible in the VIEW ONLY panel.
function readonlyAuthCheck(req: Request, res: Response): boolean {
  const expected = getExpectedSecret();
  if (!expected) return true;
  const token = (req.headers["x-zombrains-secret"] ?? req.headers["x-admin-secret"] ?? req.headers["authorization"]?.replace("Bearer ", "")) as string | undefined;
  // No token at all → allow (view-only mode)
  if (!token || token === "") return true;
  // Token present → must be valid admin or viewer secret
  if (token === expected) return true;
  const viewSecret = getExpectedViewSecret();
  if (viewSecret && token === viewSecret) return true;
  res.status(401).json({ error: "Unauthorized" });
  return false;
}


// ── Shared ask-concurrency state (used by zombrains.ts core + zombrains-workers.ts) ─
export const askState = { count: 0 };
export const MAX_CONCURRENT_ASK = 3;
export const channelContext = new Map<string, Msg[]>();
export const activeAskGuilds = new Set<string>();

const DISCORD_API_BASE = "https://discord.com/api/v10";

async function postTaskCompletedToDiscord(
  taskId: string,
  summary: string,
  hasCode: boolean,
): Promise<void> {
  const token   = process.env["DISCORD_TOKEN"];
  const guildId = process.env["GUILD_ID"];
  if (!token || !guildId) return;

  try {
    // Fetch all channels for the guild
    const chRes = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!chRes.ok) return;

    const channels = await chRes.json() as Array<{ id: string; name: string; type: number }>;
    // Find a text channel (type 0) named "completed tasks" or "completed-tasks"
    let target = channels.find(
      (c) => c.type === 0 && /^completed[\s_-]?tasks?$/i.test(c.name),
    );

    // Channel doesn't exist — create it
    if (!target) {
      const createRes = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/channels`, {
        method: "POST",
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "completed-tasks",
          type: 0,
          topic: "ZomBrains task completions — posted automatically when a Railway task finishes.",
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!createRes.ok) return;
      target = await createRes.json() as { id: string; name: string; type: number };
    }

    const embed = {
      title: "✅ Task Completed",
      description: summary.slice(0, 900),
      color: 0x22c55e,
      fields: [
        {
          name: "Task ID",
          value: `\`${String(taskId).slice(0, 80)}\``,
          inline: true,
        },
        {
          name: "Code changed",
          value: hasCode ? "Yes 📝" : "No",
          inline: true,
        },
      ],
      footer: { text: "ZomBrains · Railway" },
      timestamp: new Date().toISOString(),
    };

    await fetch(`${DISCORD_API_BASE}/channels/${target.id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Non-fatal — never let Discord posting break the report endpoint
  }
}

const REPLIT_FILE_WORKSPACE_ROOT = path.resolve(__dirname, "../../..");

const REPLIT_FILE_ALLOWED_PREFIXES = [
  "artifacts/api-server/src/",
  "artifacts/admin/src/",
  "lib/",
  "birthday-bot/",
  "builder-agent/",
  "zombeef-suite/",
  "scripts/",
];

// Root-level .js files ZomBrains is allowed to read/write (e.g. the Poopy bot)
const REPLIT_FILE_ALLOWED_ROOT_FILES = new Set([
  "index.js",
]);

function isReplitFileAllowed(filePath: string): { ok: boolean; reason?: string } {
  // Reject any traversal attempt immediately
  if (filePath.includes("..")) {
    return { ok: false, reason: "Path traversal (../) is not allowed." };
  }
  // Normalise: strip leading slash or ./ so prefix checks work uniformly
  const normalised = filePath.replace(/^[./]+/, "");

  // Blocklist — sensitive or binary files
  const blocked: Array<[RegExp, string]> = [
    [/(?:^|\/)\.env(?:\.|$)/, ".env files are not accessible"],
    [/node_modules(?:\/|$)/, "node_modules/ is not accessible"],
    [/(?:^|\/)dist(?:\/|$)/, "dist/ build output is not accessible"],
    [/\.db$/, ".db database files are not accessible"],
    [/\.key$/, ".key files are not accessible"],
    [/\.pem$/, ".pem files are not accessible"],
    [/\.secret$/, ".secret files are not accessible"],
  ];
  for (const [pattern, reason] of blocked) {
    if (pattern.test(normalised)) return { ok: false, reason };
  }

  // Allowlist — must start with one of the permitted path prefixes OR be an allowed root file
  const allowed =
    REPLIT_FILE_ALLOWED_PREFIXES.some(prefix => normalised.startsWith(prefix)) ||
    REPLIT_FILE_ALLOWED_ROOT_FILES.has(normalised);
  if (!allowed) {
    return {
      ok: false,
      reason: `Path "${normalised}" is outside the allowed directories. Allowed: ${REPLIT_FILE_ALLOWED_PREFIXES.join(", ")}, and root files: ${[...REPLIT_FILE_ALLOWED_ROOT_FILES].join(", ")}`,
    };
  }

  return { ok: true };
}

// ── Named exports ─────────────────────────────────────────────────────────────
export {
  getDb,
  addStalenessWarning,
  getExpectedSecret,
  getExpectedViewSecret,
  authCheck,
  strictAuthCheck,
  readonlyAuthCheck,
  DISCORD_API_BASE,
  postTaskCompletedToDiscord,
  REPLIT_FILE_WORKSPACE_ROOT,
  REPLIT_FILE_ALLOWED_PREFIXES,
  REPLIT_FILE_ALLOWED_ROOT_FILES,
  isReplitFileAllowed,
};
export const CODE_STATS_WORKSPACE = path.resolve(__dirname, "..", "..", "..", "..");
export type { LibraryRow };
