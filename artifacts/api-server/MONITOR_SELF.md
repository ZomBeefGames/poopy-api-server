# MONITOR_SELF.md — Monitor Complete Self-Reference

**Project: ZomBrains (builder-agent/ → Railway) + Poopy (index.js → Replit)**

The Monitor is `artifacts/api-server/src/routes/zombrains.ts` — a 6500+ line Express router
mounted at `/api` by the Replit api-server. It is the **source of truth** for everything
ZomBrains produces: queue backups, tool registry, knowledge library, proposals, prompt
codec, relay messages, goals, roadmap, analytics, and all owner communication.

---

## Identity

| Property | Value |
|---|---|
| File | `artifacts/api-server/src/routes/zombrains.ts` |
| Mount prefix | `/api` (Replit proxy) → full path e.g. `/api/zombrains/ping` |
| Database | SQLite `poop_tracker.db` — opened per-request via `getDb()`, closed in `finally` |
| DB path | `path.resolve(__dirname, "../../..", "poop_tracker.db")` |
| Workspace root | `REPLIT_FILE_WORKSPACE_ROOT = path.resolve(__dirname, "../../..")` |
| Railway URL | `https://builder-agent-production.up.railway.app` (const `ZOMBRAINS_URL`) |
| DB pattern | `CREATE TABLE IF NOT EXISTS` — all tables are idempotent on every connection open |

---

## Authentication

Three tiers — checked by `authCheck()` and `readonlyAuthCheck()`:

```
x-admin-secret: <ADMIN_SECRET>          → full write access (Railway always uses this)
x-zombrains-secret: <ADMIN_SECRET>      → same value, same access (ZomBrains alias)
x-viewer-secret: <viewer_secret>        → read-only; viewer_secret is one-time-use (burned on verify)
```

**Public endpoints** (no auth at all):
`/zombrains/ping`, `/zombrains/settings/runner-heartbeat`, `/zombrains/persist/queue-state` (GET),
`/zombrains/killswitch` (GET), `/zombrains/pulse-status` (POST), `/zombrains/cluster-flags` (GET),
`/zombrains/bot-uptime` (GET)

**Safety guard**: ZomBrains cannot set `zombrains_cluster_enabled=false` via
`x-zombrains-secret` — prevents self-shutdown on misdiagnosis.

---

## Database Schema (23 tables + 1 FTS virtual table)

### Core tables (in `getDb()` — created on every connection open)

```sql
zombrains_reports (
  id INTEGER PK AUTOINCREMENT,
  type TEXT DEFAULT 'info',         -- complete|error|info|verification|knowledge_seed
  task TEXT,                         -- task title (nullable)
  message TEXT NOT NULL,
  data TEXT,                         -- JSON blob (nullable)
  created_at TEXT DEFAULT datetime('now')
)

zombrains_queue (
  key TEXT PRIMARY KEY,              -- always 'main'
  data TEXT NOT NULL,                -- JSON array of task objects
  updated_at TEXT DEFAULT datetime('now')
)

zombrains_relay (
  id INTEGER PK AUTOINCREMENT,
  task_label TEXT NOT NULL,
  files_json TEXT NOT NULL,          -- JSON array of file paths
  sent INTEGER DEFAULT 0,
  ts TEXT NOT NULL,
  created_at TEXT DEFAULT datetime('now')
)

relay_outbox (
  id INTEGER PK AUTOINCREMENT,
  type TEXT DEFAULT 'patch',
  payload TEXT NOT NULL,             -- JSON message payload
  source TEXT DEFAULT 'replit',
  status TEXT DEFAULT 'pending',     -- pending|claimed|done
  created_at TEXT DEFAULT datetime('now'),
  claimed_at TEXT,
  done_at TEXT
)

zombrains_logs (
  id INTEGER PK AUTOINCREMENT,
  level TEXT NOT NULL,               -- info|warn|error
  module TEXT,                       -- source module name
  msg TEXT NOT NULL,
  detail TEXT,
  stack TEXT,
  ts TEXT NOT NULL,                  -- Railway-side timestamp
  created_at TEXT DEFAULT datetime('now')
)

zombrains_progress (
  task_id TEXT PRIMARY KEY,
  history TEXT NOT NULL,             -- JSON array of step records
  step INTEGER DEFAULT 0,
  work_dir TEXT,
  updated_at TEXT DEFAULT datetime('now')
)

zombrains_proposals (
  id INTEGER PK AUTOINCREMENT,
  title TEXT NOT NULL,               -- max 200 chars
  description TEXT NOT NULL,         -- max 3000 chars when auto-completed
  status TEXT DEFAULT 'pending',     -- pending|approved|completed|rejected|stale|queued
  revised_text TEXT,
  sort_order INTEGER DEFAULT 0,
  type TEXT DEFAULT 'task',          -- task|tool_promotion|queue_task
  tool_metadata TEXT,                -- JSON (for tool_promotion type)
  has_code INTEGER DEFAULT 0,        -- 1 if task produced code changes
  risk_tier TEXT DEFAULT 'medium',   -- low|medium|high
  reviewer_note TEXT,
  discord_message_id TEXT,
  discord_channel_id TEXT,
  created_at TEXT DEFAULT datetime('now'),
  updated_at TEXT DEFAULT datetime('now')
)

zombrains_failure_log (
  id INTEGER PK AUTOINCREMENT,
  task_id TEXT NOT NULL,
  task_prompt TEXT NOT NULL,
  error_msg TEXT NOT NULL,
  failure_type TEXT DEFAULT 'unknown',
  retry_count INTEGER DEFAULT 0,
  history TEXT,                      -- JSON execution history
  created_at TEXT DEFAULT datetime('now')
)

zombrains_library (
  id INTEGER PK AUTOINCREMENT,
  title TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  category TEXT DEFAULT 'knowledge', -- fact|pattern|lesson|error_pattern|procedure|taste|knowledge
  source_file TEXT,
  tags TEXT,                         -- JSON array of strings
  used_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT datetime('now'),
  updated_at TEXT DEFAULT datetime('now')
)

zombrains_library_fts            -- FTS5 virtual table (content=zombrains_library)
  title, content                 -- 3 triggers maintain sync: after INSERT, UPDATE, DELETE

zb_knowledge_hits (
  title TEXT PRIMARY KEY,
  hit_count INTEGER DEFAULT 1,
  last_hit_at TEXT DEFAULT datetime('now')
)

zombrains_calls (
  id INTEGER PK AUTOINCREMENT,
  guild_id TEXT,                     -- 'zombrains' for Railway tasks, Discord guild ID for pp calls
  user_id TEXT,
  prompt TEXT NOT NULL,
  response TEXT NOT NULL,
  provider TEXT NOT NULL,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  rating INTEGER,                    -- 1 (thumbs up) | -1 (thumbs down) | NULL
  response_ms INTEGER,               -- LLM latency in milliseconds
  created_at TEXT DEFAULT datetime('now')
)

zombrains_provider_stats (
  provider TEXT NOT NULL,
  date TEXT NOT NULL,                -- YYYY-MM-DD
  call_count INTEGER DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  PRIMARY KEY (provider, date)
)

zombrains_dead_letter_alerts (
  id INTEGER PK AUTOINCREMENT,
  task_id TEXT NOT NULL,
  prompt TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  sent_at TEXT,                      -- NULL = not yet sent to Discord
  created_at TEXT DEFAULT datetime('now')
)

zombrains_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
-- Key registry (partial — all stored as JSON strings unless noted):
-- 'admin_secret'         → plain string (bcrypt hash)
-- 'zombrains_view_secret'→ plain string (one-time viewer password)
-- 'runner_heartbeat'     → {"taskId":"...","ts":"ISO"}
-- 'queue_snapshot'       → {"pending":N,"running":N,"dead_letter":N,"paused":bool,"storedAt":"ISO"}
-- 'queue_status_snapshot'→ Railway queue-status response snapshot
-- 'last_pulse_result'    → T0 pulse result object
-- 'notes_content'        → ZomBrains' NOTES.md content (Railway side)
-- 'notes_pending_admin'  → admin edits not yet seen by ZomBrains
-- 'killswitches'         → {"add_tool":bool,"tool_verification":bool,"code_verification":bool,"verify_js":bool}
-- 'zb_inbox_latest'      → {"filename":"...","description":"...","receivedAt":"ISO","seen":bool}
-- 'note_<key>'           → arbitrary notes from persist/notes endpoint
-- 'snippet_<name>'       → {"code":"...","updatedAt":"ISO"}

zombrains_capability_gaps (
  id INTEGER PK AUTOINCREMENT,
  task_id TEXT NOT NULL,
  task_prompt TEXT DEFAULT '',
  gap_description TEXT DEFAULT '',
  feasibility_result TEXT DEFAULT 'unknown',
  feasibility_reason TEXT DEFAULT '',
  outcome TEXT DEFAULT '',
  dismissed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT datetime('now')
)

zombrains_goals (
  id INTEGER PK AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',      -- active|completed|paused|cancelled
  priority INTEGER DEFAULT 5,        -- 1=highest, 10=lowest
  source TEXT DEFAULT 'zombrains',   -- zombrains|owner
  progress_notes TEXT,
  created_at TEXT DEFAULT datetime('now'),
  updated_at TEXT DEFAULT datetime('now')
)
```

### Migration tables (created in startup block after `getDb()`)

```sql
zombrains_loop_events (
  id INTEGER PK AUTOINCREMENT,
  gap_id TEXT,
  task_id TEXT,
  event_type TEXT NOT NULL,          -- T0_tick|task_start|task_complete|task_fail
  tool_name TEXT,
  details TEXT,                      -- JSON
  created_at TEXT DEFAULT datetime('now')
)

zombrains_known_problems (
  id INTEGER PK AUTOINCREMENT,
  description TEXT NOT NULL,
  severity TEXT DEFAULT 'warning',   -- warning|error|critical
  context TEXT,
  fix_attempts INTEGER DEFAULT 0,
  resolved INTEGER DEFAULT 0,
  first_seen TEXT DEFAULT datetime('now'),
  last_seen TEXT DEFAULT datetime('now')
)

zombrains_tools (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  parameters_schema TEXT NOT NULL,   -- JSON Schema object
  execute_code TEXT NOT NULL,        -- JavaScript code string
  verified INTEGER DEFAULT 1,
  created_at TEXT DEFAULT datetime('now'),
  updated_at TEXT DEFAULT datetime('now')
)

prompt_index (
  code TEXT PRIMARY KEY,             -- e.g. 'Tf_a'
  full_name TEXT NOT NULL UNIQUE,    -- e.g. 'append_project_file'
  namespace TEXT NOT NULL,           -- e.g. 'Tf'
  deprecated INTEGER DEFAULT 0,
  deprecated_succ TEXT,              -- successor code if deprecated
  version_added INTEGER DEFAULT 1,
  usage_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT DEFAULT datetime('now')
)

zombrains_task_log (
  id INTEGER PK AUTOINCREMENT,
  task_id TEXT NOT NULL,
  prompt TEXT DEFAULT '',
  outcome TEXT DEFAULT 'unknown',    -- done|failed|dead_letter
  duration_ms INTEGER,
  provider TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  had_code INTEGER DEFAULT 0,
  tools_called TEXT,                 -- JSON array of tool names used
  error_msg TEXT,
  created_at TEXT DEFAULT datetime('now')
)

zb_ai_quality (
  id INTEGER PK AUTOINCREMENT,
  task_id TEXT NOT NULL,
  prompt TEXT DEFAULT '',
  diff_summary TEXT,
  outcome TEXT DEFAULT 'done',
  ai_score INTEGER,                  -- 0-100
  ai_reasoning TEXT,
  completion_score INTEGER,
  evaluated_at TEXT DEFAULT datetime('now')
)
```

---

## ZomBrains Data Structures Monitor Handles

### Queue Task Object
```js
{
  id: "1748901234567-abc123",   // timestamp + random suffix
  prompt: "task description",   // full task prompt string
  status: "pending",            // pending|running|paused|done|failed|dead_letter
  priority: 5,                  // 0=owner, "high"=front-of-queue, 5=normal
  source: "zombrains",          // zombrains|owner
  ownerTask: false,             // true for owner-injected tasks
  createdAt: "ISO datetime",
  updatedAt: "ISO datetime"
}
```

### Tool Definition Object (stored in `zombrains_tools`)
```js
{
  name: "tool_name",            // [a-z][a-z0-9_]{1,40}
  description: "...",
  parameters_schema: {          // JSON Schema
    type: "object",
    properties: {
      param_name: { type: "string", description: "..." }
    },
    required: ["param_name"]
  },
  execute_code: "...",          // JS code string; last expression = return value
  verified: 1                   // 0|1 — set by add_tool verify pipeline
}
```

### Proposal Object (all DB columns)
```js
{
  id, title, description,
  status,           // pending|approved|completed|rejected|stale|queued
  revised_text,
  sort_order,
  type,             // task|tool_promotion|queue_task
  tool_metadata,    // JSON string (for tool_promotion)
  has_code,         // 0|1
  risk_tier,        // low|medium|high
  reviewer_note,
  discord_message_id,
  discord_channel_id,
  created_at, updated_at
}
```

### Prompt Codec Entry
```js
{
  code: "Tf_a",                 // T<namespace>_<suffix>
  full_name: "append_project_file",
  namespace: "Tf",
  deprecated: 0,                // 0|1 — never recycled once deprecated
  deprecated_succ: null,        // successor code if deprecated
  version_added: 1,
  usage_count: 0,
  last_used_at: null,
  created_at: "ISO"
}
```

### FILE_ACCESS_NOTE
Prepended to every task injected from an approved proposal (auto or manual):
```
IMPORTANT — FILE ACCESS:
The Poopy Discord bot codebase lives in the Replit workspace, NOT on Railway.
• To READ files:  use read_project_file({ path: "index.js" })
• To WRITE files: use write_project_file({ path: "index.js", content: "..." })
• To SEARCH:      use search_project_files({ pattern: "...", path: "." })
Do NOT use read_file, write_file, or shell commands for Replit files — they will fail.
When done, call report_to_replit with type=complete, then call propose_task with a summary.
```

---

## Auto-Approve Logic (`scoreProposal`)

Called on every `POST /zombrains/proposals`. Rules applied in order, first match wins:

```
1. type=tool_promotion          → NEVER (manual review always)
2. risk_tier=high               → NEVER
3. Any BLOCK keyword in text    → NEVER
   BLOCK = ["src/", "index.js", "birthday-bot", "birthday_bot",
            "drop table", "delete from", "truncate table", "schema change",
            "migration", "deploy", "restart bot", "bot restart",
            "railway restart", "restart railway", "propose_code_change",
            "production database", "poop_tracker"]
4. risk_tier=low + no blocks    → APPROVE
5. risk_tier=medium + SAFE_MEDIUM keyword → APPROVE
   SAFE_MEDIUM = ["notes.md", "journal", "tools_guide", "tools guide",
                  "self.md", "knowledge library", "bot_knowledge",
                  "self-audit", "self audit", "health check", "uptime check",
                  "monitoring", "error pattern", "log scan", "self diagnose",
                  "documentation update", "error_memory"]
6. Everything else              → DENY (hold for human)
```

Auto-approve is gated by `feature_flags` table key `zombrains_auto_approve_enabled = 1`.
When approved: task injected to Railway via `POST /queue` with FILE_ACCESS_NOTE prepended.

---

## How ZomBrains Calls Monitor

From `builder-agent/src/tools.js`, ZomBrains uses `rs()` (Replit session helper) which adds
`x-admin-secret: <ADMIN_SECRET>` and prefixes the Replit base URL automatically:

```js
rs().replitGet('/zombrains/path?query=value')
rs().replitPost('/zombrains/path', { body: "object" })
rs().replitPatch('/zombrains/path', { body: "object" })
```

These map directly to Monitor routes without the `/api` prefix — the Replit proxy adds it.

### Tool → Monitor Route Mapping (file proxy tools)

| ZomBrains tool | Method | Monitor route | Notes |
|---|---|---|---|
| `replit_api` (op:read) | GET | `/zombrains/files/read` | `?path=...&offset=N&limit=N` |
| `replit_api` (op:write) | POST | `/zombrains/files/write` | `{path, content}` |
| `replit_api` (op:append) | POST | `/zombrains/files/write` | `{path, content, mode:"append"}` |
| `replit_api` (op:search) | POST | `/zombrains/files/search` | `{pattern, path, file_glob}` |
| `read_project_file` | GET | `/zombrains/files/read` | `?path=...` |
| `read_project_file_range` | GET | `/zombrains/files/read` | `?path=...&offset=N&limit=N` |
| `write_project_file` | POST | `/zombrains/files/write` | `{path, content}` |
| `append_project_file` | POST | `/zombrains/files/write` | `{path, content, mode:"append"}` |
| `search_project_files` | POST | `/zombrains/files/search` | `{pattern, path}` |
| `grep` | POST | `/zombrains/files/search` | `{pattern, path, file_glob}` |
| `count_in_project` | POST | `/zombrains/files/count` | `{pattern, path, file_glob}` |
| `batch_edit_project_files` | POST | `/zombrains/files/batch-edit` | `{edits:[{path,old_string,new_string}]}` |
| `multi_edit_file` | POST | `/zombrains/files/batch-edit` | `{edits:[...]}` |
| `run_typecheck` | POST | `/zombrains/shell/typecheck` | `{package?}` |
| `add_snippet` | POST | `/zombrains/snippets` | `{name, code}` |
| `get_snippet` | GET | `/zombrains/snippets/:name` | |
| `list_snippets` | GET | `/zombrains/snippets` | |
| `web_search` | POST | `/zombrains/internet/search` | `{query, max_results?}` → Tavily |
| `get_railway_logs` | POST | `/zombrains/railway/logs` | `{limit, filter, previous}` → Railway proxy |
| `propose_code_change` | POST | `/zombrains/proposals/submit` → `/zombrains/inbox/file` | filename+content |
| `propose_code` | POST | `/zombrains/prompt-index/propose` | `{full_name, suggested_code?}` |
| `report_to_replit` | POST | `/zombrains/report` | `{type, task, message, data}` |
| `journal_entry` | POST | `/zombrains/journal` | `{message, level}` |
| `remember` | POST | `/zombrains/knowledge` | `{content, tags, category}` |
| `lookup_knowledge` / `search_memory` | POST | `/zombrains/knowledge/search` | `{query, tags, limit}` |
| `forget` | DELETE | `/zombrains/knowledge/:id` | |
| `store_memory` | POST | `/zombrains/knowledge` | same as remember |
| `recall` | POST | `/zombrains/knowledge/search` | same as search_memory |
| `teach_yourself` | POST | `/zombrains/library` | `{title, content, category, tags}` |
| `propose_task` | POST | `/zombrains/proposals` | `{title, description, risk_tier}` |
| `plan_task` → inject | POST | `/zombrains/task/inject` | `{prompt, priority}` |

---

## Railway HTTP API (Outbound — Monitor → Railway)

Monitor calls Railway at `https://builder-agent-production.up.railway.app`:

| Method | Railway endpoint | Called from Monitor route | Purpose |
|---|---|---|---|
| POST | `/queue` | `POST /proposals` (auto-approve) | Inject approved proposal as task |
| POST | `/queue/owner` | `POST /task/inject`, `POST /outbox/process` | Owner-priority task injection |
| GET | `/queue-status` | `POST /task/inject` (exclusive mode) | Get live queue to find pending tasks |
| GET | `/queue` | `GET /live`, `GET /control/queue` | Full queue contents |
| POST | `/queue/:id/dead-letter` | `POST /task/inject` (exclusive), `POST /queue/:id/dead-letter` | Dead-letter a task |
| POST | `/queue/kick` | `POST /queue/kick` | Kick stuck running task |
| POST | `/queue/housekeep` | `POST /queue/housekeep` | Retire legacy tasks |
| GET | `/safe-to-push` | `GET /live` | Push lock check |
| GET | `/providers` | `GET /live` | Provider health status |
| GET | `/logs?limit=N` | `GET /live`, `POST /railway/logs` | Recent Railway log lines |
| GET | `/tokens` | `GET /live` | Token usage stats |
| GET | `/git-stats` | `GET /code-stats` | Git commit count |
| POST | `/push-lock` | `PATCH /cluster-flags` (push_lock change) | Immediately sync push-lock to Railway |

**Auth**: Railway calls use `x-zombrains-secret: <ADMIN_SECRET>` or `x-admin-secret: <ADMIN_SECRET>`.
All outbound Railway calls use `AbortSignal.timeout(N)` — never hang indefinitely.

---

## External APIs Monitor Calls

| API | URL | Used by | Env var needed |
|---|---|---|---|
| Discord | `https://discord.com/api/v10` | `postTaskCompletedToDiscord()`, proposal channel creation | `BOT_TOKEN` (from `bot_settings`) |
| Tavily | `https://api.tavily.com/search` | `POST /zombrains/internet/search`, `POST /zombrains/search` | `TAVILY_API_KEY` |
| Groq | `https://api.groq.com/openai/v1/chat/completions` | `POST /zombrains/task/refine`, `POST /zombrains/quality/ai-eval` | `GROQ_API_KEY` |
| Railway GraphQL | `https://backboard.railway.app/graphql/v2` | `POST /zombrains/restart-bot` | `RAILWAY_TOKEN` |
| ai-proxy (Replit) | `POST /ai/call-event` | AI call logging self-route | internal |

---

## Filesystem Paths Monitor Touches

All relative to `REPLIT_FILE_WORKSPACE_ROOT = /home/runner/workspace`:

| Path | What Monitor does with it |
|---|---|
| `builder-agent/JOURNAL.md` | Appends lines via `POST /zombrains/journal` |
| `builder-agent/src/tools.js` | Read/write via `/persist/tools-source` (backup + restore) |
| `builder-agent/prompt-index.json` | Read on first `/zombrains/prompt-index` call to bootstrap DB |
| `builder-agent/zb-inbox/` | Writes proposed code files via `POST /zombrains/inbox/file` |
| `builder-agent/zb-outbox/` | Reads `.md/.txt/.json` files via `POST /zombrains/outbox/process`, moves to `zb-outbox/sent/` after queuing |
| `builder-agent/SELF.md` | Read/written via `GET /zombrains/self` and `POST /zombrains/self` |
| `builder-agent/SECRETS_GUIDE.md` | Regenerated by `POST /zombrains/refresh-secrets-guide` |
| `builder-agent/NOTES.md` | Read/written via `GET|PATCH /zombrains/notes` |
| Any workspace file | Read via `GET /zombrains/files/read`, written via `POST /zombrains/files/write` |

Path safety: every file operation resolves the full path and verifies it starts with
`REPLIT_FILE_WORKSPACE_ROOT + path.sep` before reading or writing. Escape attempts return 403.

---

## All Routes (141 total — grouped by responsibility)

### Health & Systems
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/ping` | public | Liveness check → `{ok,ts}` |
| GET | `/zombrains/bot-health` | auth | Uptime + memory + last commit for Poopy + Birthday bots |
| GET | `/zombrains/bot-memory` | auth | Memory (`/proc/pid/status`) for running bot processes |
| GET | `/zombrains/bot-uptime` | public | Uptime data from loop-events + heartbeat |
| GET | `/zombrains/live` | readonly | Proxy: 5 Railway calls + Monitor DB data merged |
| **GET** | **`/systems/health`** | **auth** | **All 5 systems in one call — ZomBrains heartbeat + Poopy/Birthday /proc check + admin-panel heartbeat + Monitor DB ping. No Railway proxy, never hangs.** |
| **POST** | **`/zombrains/admin-heartbeat`** | **auth** | **Admin panel pings every 30s. Writes `admin_heartbeat` to settings. Proves Replit is alive.** |
| **POST** | **`/systems/error`** | **auth** | **Any system reports an error. Body: `{system, level?, message, context?}`. Stored in `zombrains_reports` with `type=system_error`.** |
| **GET** | **`/systems/errors`** | **auth** | **Query aggregated system errors. Query: `system`, `limit`, `since`.** |
| **GET** | **`/systems/index`** | **auth** | **Live discovery index — all systems, tool count, codec size, library size, queue snapshot, self-doc paths.** |
| **GET** | **`/systems/provider-stats`** | **auth** | **Per-provider success rates from last 500 task_log rows, grouped by provider+role. ZomBrains calls this on boot to seed ai.js perf history so rankings survive Railway restarts.** |
| **GET** | **`/systems/token-stats-history`** | **auth** | **Per-provider token totals (prompt+completion) from task_log last 7 days. ZomBrains calls this on boot to seed ai.js tokenStats so load-factor calculation is accurate from task 1.** |

### Auth management
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/view-secret` | auth | Whether viewer secret is configured (not the value) |
| PUT | `/zombrains/view-secret` | auth | Set/rotate viewer secret |
| DELETE | `/zombrains/view-secret` | auth | Remove viewer secret |
| POST | `/zombrains/verify-view-secret` | public | Validate + burn viewer secret (one-time use) |

### Task lifecycle
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/zombrains/report` | auth | Append task report; `type=complete` → Discord #completed-tasks |
| GET | `/zombrains/reports` | auth | List reports; query: `limit`, `since`, `type` |
| DELETE | `/zombrains/reports` | auth | Purge reports older than 7 days |
| POST | `/zombrains/journal` | auth | Append line to JOURNAL.md |
| POST | `/zombrains/runner/heartbeat` | auth | ZomBrains alive signal (every 30s during task) |
| GET | `/zombrains/settings/runner-heartbeat` | public | Last heartbeat `{ts, taskId}` — Poopy reads this |
| POST | `/zombrains/task-log` | auth | Record completed/failed task in `zombrains_task_log` |
| POST | `/zombrains/task/feedback` | auth | Owner 👍/👎 on completed task → knowledge library taste entry |
| POST | `/zombrains/loop-events` | auth | Record scheduler loop event |
| GET | `/zombrains/loop-events` | auth | List loop events; query: `limit`, `since` |

### Queue persistence
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/persist/queue` | auth | Restore full queue array (Railway reads on boot) |
| POST | `/zombrains/persist/queue` | auth | Save full queue array (Railway saves on every mutation) |
| GET | `/zombrains/persist/queue-state` | public | Last lightweight snapshot `{pending,running,dead_letter,paused}` |
| POST | `/zombrains/persist/queue-state` | auth | Save lightweight snapshot (max every 30s from tick loop) |
| GET | `/zombrains/idle-state` | auth | Last T0 pulse result for admin panel + `pp zb cycle` |
| POST | `/zombrains/queue/housekeep` | auth | Proxy → Railway `/queue/housekeep` |
| POST | `/zombrains/queue/inject` | auth | Inject task into Railway live queue; fallback: write to DB |
| POST | `/zombrains/queue/think` | auth | Trigger ZomBrains ideation from goals + knowledge |
| POST | `/zombrains/task/inject` | auth | Alias for `/queue/inject` with `exclusive` mode support |
| POST | `/zombrains/task/refine` | auth | Groq-refine task description before injection |
| POST | `/zombrains/queue/:id/dead-letter` | auth | Proxy → Railway dead-letter a specific task |
| POST | `/zombrains/queue/kick` | auth | Proxy → Railway kick stuck running task |

### Proposals
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/zombrains/proposals` | auth | Create proposal; runs auto-approve scorer |
| GET | `/zombrains/proposals` | auth | List; query: `status`, `limit`, `offset` |
| PATCH | `/zombrains/proposals/:id` | auth | Update status/fields |
| POST | `/zombrains/proposals/archive-stale` | auth | Mark >7-day-old pending proposals stale |
| GET | `/zombrains/proposals/pending-discord` | auth | Poopy polls for proposals not yet posted |
| PATCH | `/zombrains/proposals/:id/discord-posted` | auth | Mark proposal posted to Discord |
| POST | `/zombrains/proposals/:id/verify` | auth | Run verification on a proposal |
| GET | `/zombrains/proposals/auto-approvable` | auth | Proposals that would pass scorer but weren't auto-approved |
| GET | `/zombrains/proposals/feedback` | auth | Owner feedback history for ranking |

### Knowledge & Library
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/zombrains/library` | auth | Add library entry |
| GET | `/zombrains/library` | auth | List; query: `category`, `tag`, `limit`, `offset` |
| PATCH | `/zombrains/library/:id` | auth | Update entry |
| DELETE | `/zombrains/library/:id` | auth | Remove entry |
| GET | `/zombrains/library/stats` | auth | Entry counts by category |
| POST | `/zombrains/library/stale-check` | auth | Flag entries not retrieved in >30 days |
| POST | `/zombrains/search` | auth | FTS5 search: `{q, limit}` |
| POST | `/zombrains/knowledge` | auth | Add knowledge entry (`remember`) |
| POST | `/zombrains/knowledge/search` | auth | Search: `{q, tags, limit}` |
| GET | `/zombrains/knowledge` | auth | List; query: `tag`, `limit` |
| DELETE | `/zombrains/knowledge/:id` | auth | Remove entry (`forget`) |
| POST | `/zombrains/knowledge/hit` | auth | Record retrieval hit: `{entryId}` |
| GET | `/zombrains/knowledge/hot` | auth | Top 10 most-retrieved entries |
| GET | `/zombrains/knowledge/last-retrieved` | auth | Most recently accessed entries |
| GET | `/zombrains/knowledge-base` | auth | Full knowledge base summary |

### Prompt Codec
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/prompt-index` | auth | Full canonical index; auto-bootstraps from `prompt-index.json` |
| POST | `/zombrains/prompt-index/propose` | auth | Register new code: `{full_name, suggested_code?}` |
| POST | `/zombrains/prompt-index/deprecate` | auth | Retire code permanently: `{code, successor?}` |
| POST | `/zombrains/prompt-index/track-usage` | auth | Increment usage counts: `{codes:[]}` |

### Tool registry
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/zombrains/tools` | auth | Sync tool to DB (survives Railway restart) |
| GET | `/zombrains/tools` | auth | All registered tools from DB |
| DELETE | `/zombrains/tools/:name` | auth | Remove tool from DB |
| GET | `/zombrains/tools/all` | auth | Parse live `tools.js` source via regex |
| POST | `/zombrains/cluster-tools` | auth | Register cluster tool (available to Poopy) |
| GET | `/zombrains/cluster-tools` | auth | List all cluster tools |
| DELETE | `/zombrains/cluster-tools/:name` | auth | Remove cluster tool |

### File proxy (NEW — added to match ZomBrains tools.js call patterns)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/files/read` | auth | Read workspace file; query: `path`, `offset`, `limit` |
| POST | `/zombrains/files/write` | auth | Write/append workspace file: `{path, content, mode?}` |
| POST | `/zombrains/files/search` | auth | Grep search: `{pattern, path?, file_glob?}` |
| POST | `/zombrains/files/count` | auth | Count pattern matches: `{pattern, path?, file_glob?}` |
| POST | `/zombrains/files/batch-edit` | auth | Apply targeted replacements: `{edits:[{path,old_string,new_string,replace_all?}]}` |
| GET | `/zombrains/files/todos` | auth | Grep TODO/FIXME/HACK/XXX across workspace |
| POST | `/zombrains/files/batch-read` | auth | Read multiple files: `{paths:[]}` max 20 |
| GET | `/zombrains/replit-file` | auth | Alias read (older tools) |
| POST | `/zombrains/replit-file` | auth | Alias write (older tools) |
| GET | `/zombrains/replit-file-search` | auth | Alias search (older tools) |

### Shell & Build
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/zombrains/shell` | auth | Execute shell command in Replit workspace |
| POST | `/zombrains/shell/typecheck` | auth | Run pnpm typecheck: `{package?}` |
| GET | `/zombrains/workflow-logs` | auth | Recent Replit workflow logs |
| GET | `/zombrains/workspace/stats` | auth | File count + size by directory |
| GET | `/zombrains/npm/deps` | auth | Node.js dependency tree |
| GET | `/zombrains/npm/outdated` | auth | Outdated npm packages |
| POST | `/zombrains/npm/install` | auth | Install npm package |

### Git
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/git/log` | auth | Git log; query: `limit`, `branch` |
| GET | `/zombrains/git/diff` | auth | Git diff; query: `ref`, `path` |
| POST | `/zombrains/git/rollback` | auth | Rollback file: `{path, ref}` |
| GET | `/zombrains/github-config` | auth | Git remote config (no credentials) |
| POST | `/zombrains/github-push` | auth | Trigger git add/commit/push via push-to-railway.sh |
| POST | `/zombrains/git-push` | auth | Push Replit state to Railway branch |
| GET | `/zombrains/bot-uptime` | public | Uptime |
| GET | `/zombrains/db/query` | auth | Read-only SQL query: `?q=SELECT...` |

### Snippets
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/snippets` | auth | List all snippets (`snippet_*` from settings) |
| GET | `/zombrains/snippets/:name` | auth | Get one snippet |
| POST | `/zombrains/snippets` | auth | Store snippet: `{name, code}` |
| DELETE | `/zombrains/snippets/:name` | auth | Delete snippet |

### Internet / Search
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/zombrains/internet/search` | auth | Tavily web search: `{query, max_results?}` |
| POST | `/zombrains/search` | auth | FTS5 library search |

### Railway proxy (read)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/zombrains/railway/logs` | auth | Proxy Railway `/logs`: `{limit, filter, previous}` |
| GET | `/zombrains/live` | readonly | 5-call Railway aggregate |
| GET | `/zombrains/control/status` | auth | Railway queue depth + current task |
| GET | `/zombrains/control/queue` | auth | Railway live queue |
| POST | `/zombrains/control/restart` | auth | Railway service restart (GraphQL) |
| POST | `/zombrains/control/fix` | auth | Send fix directive to running task |
| GET | `/zombrains/control/diagnose` | auth | Run Railway self-diagnosis |

### Relay & Discord
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/zombrains/relay/upload` | auth | File upload for Discord relay |
| POST | `/zombrains/relay/stage` | auth | Stage text message for Discord |
| GET | `/zombrains/relay/pending` | auth | Poopy polls for relay messages |
| POST | `/zombrains/relay/ack` | auth | Confirm relay message delivered |
| GET | `/zombrains/relay/outbox` | auth | List pending outbox messages |
| GET | `/zombrains/relay/logs/since` | auth | Relay log since timestamp |
| POST | `/zombrains/owner-report` | auth | Queue owner DM via Poopy |
| GET | `/zombrains/owner-report/pending` | auth | Poopy polls for owner DMs |
| POST | `/zombrains/owner-report/mark-sent` | auth | Mark owner DM sent |
| POST | `/zombrains/failure-alert` | auth | Queue dead-letter/crash alert |
| POST | `/zombrains/dead-letter-alert` | auth | Record dead-letter event |
| GET | `/zombrains/dead-letter-alerts` | auth | Unsent dead-letter alerts |
| PATCH | `/zombrains/dead-letter-alerts/:id/sent` | auth | Mark alert sent |
| GET | `/zombrains/alerts/pending` | auth | All pending alerts (consolidated) |
| POST | `/zombrains/alerts/mark-sent` | auth | Mark alerts sent: `{ids:[]}` |

### Inbox / Outbox (ZomBrains ↔ Poopy file relay)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/zombrains/inbox/file` | auth | ZomBrains sends proposed file change → `zb-inbox/` |
| GET | `/zombrains/inbox/pending` | public | Poopy checks for unseen inbox file |
| POST | `/zombrains/inbox/mark-seen` | public | Poopy marks inbox consumed |
| POST | `/zombrains/outbox/process` | public | Poopy reads `zb-outbox/*.md`, queues each as Railway owner task |
| GET | `/zombrains/outbox/pending` | public | List files waiting in outbox |

### Settings & Control
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/cluster-flags` | public | All flags incl `tasks_paused`, `push_lock`, `auto_approve_low_risk` |
| PATCH | `/zombrains/cluster-flags` | auth | Update flags; ZomBrains blocked from disabling own cluster |
| GET | `/zombrains/tasks-paused` | auth | Quick pause state check |
| GET | `/zombrains/killswitch` | public | Current killswitch states |
| POST | `/zombrains/killswitch` | auth | Toggle: `{system, enabled}` — valid: `add_tool`,`tool_verification`,`code_verification`,`verify_js` |
| GET | `/zombrains/settings/provider-overrides` | auth | Provider override settings |
| PATCH | `/zombrains/settings/provider-overrides` | auth | Update overrides: `{groq_mode, disabled_providers}` |
| GET | `/zombrains/env` | auth | Env var keys (no values) |
| POST | `/zombrains/env-report` | auth | ZomBrains reports its env state |
| POST | `/zombrains/refresh-secrets-guide` | auth | Regenerate SECRETS_GUIDE.md |

### Analytics & Quality
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/analytics` | auth | Full analytics dashboard |
| GET | `/zombrains/code-stats` | auth | Code output stats |
| GET | `/zombrains/analytics/tasks-history` | auth | Per-day task completion counts |
| POST | `/zombrains/analytics/mark-reported` | auth | Mark events reported |
| POST | `/zombrains/quality/ai-eval` | auth | Record AI quality evaluation |
| GET | `/zombrains/quality/recent` | auth | Recent quality scores |
| PATCH | `/zombrains/calls/:id/rating` | auth | Owner rating on AI call: `{rating: 1|-1}` |
| POST | `/ai/call-event` | auth | Log AI call: `{provider, model, tokens_in, tokens_out, response_ms}` |
| GET | `/poopy/infer` | auth | AI inference via Poopy cluster slot |

### Self, Goals, Known Problems
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/self` | auth | ZomBrains self-model (SELF.md content) |
| POST | `/zombrains/self` | auth | Update self-model |
| GET | `/zombrains/reflections` | auth | Stored end-of-day retrospectives |
| GET | `/zombrains/goals` | auth | Active goals list |
| POST | `/zombrains/goals` | auth | Add goal: `{title, description, priority}` |
| PATCH | `/zombrains/goals/:id` | auth | Update goal status/notes |
| GET | `/zombrains/known-problems` | auth | Unresolved known problems |
| POST | `/zombrains/known-problems` | auth | Log problem (upserts by description) |
| PATCH | `/zombrains/known-problems/:id/resolve` | auth | Mark resolved |
| DELETE | `/zombrains/known-problems/:id` | auth | Remove |
| GET | `/zombrains/capability-gaps` | auth | Tool/capability gaps |
| POST | `/zombrains/capability-gaps` | auth | Log gap |
| PATCH | `/zombrains/capability-gaps/:id/dismiss` | auth | Dismiss gap |
| POST | `/zombrains/capability-gaps/:id/force-build` | auth | Escalate gap to proposal |

### Roadmap
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/roadmap/stats` | auth | Completion stats per stage |
| GET | `/zombrains/roadmap/next` | auth | Next undone item |
| POST | `/zombrains/roadmap/complete` | auth | Mark complete: `{id, notes}` |
| POST | `/zombrains/roadmap/skip` | auth | Skip: `{id, reason}` |

### Personality Queue
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/personality-queue/stats` | auth | Queue depths + last-run times |
| GET | `/zombrains/personality-queue/next` | auth | Next personality task |
| POST | `/zombrains/personality-queue/complete` | auth | Mark complete |
| POST | `/zombrains/personality-queue/timeout` | auth | Record timeout |
| POST | `/zombrains/personality-queue/skip` | auth | Skip |

### Notes
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/notes` | auth | `{content, pendingAdminEdit}` from settings |
| PATCH | `/zombrains/notes` | auth | `{content, source}` — source=zombrains → `notes_content`; else → `notes_pending_admin` |
| POST | `/zombrains/persist/notes` | auth | Store note by key: `{key, value}` → `note_<key>` in settings |

### Misc
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/zombrains/agent-briefing` | auth | Boot briefing: health, queue, proposals, performance, failures, goals, problems |
| POST | `/zombrains/pulse-status` | public | Railway T0 pulse result → `last_pulse_result` setting |
| POST | `/zombrains/ask` | auth | Route question to Railway `/ask` |
| GET | `/zombrains/poopy-feedback-summary` | auth | 👍/👎 summary for quality scoring |
| POST | `/zombrains/bot-smoketest` | auth | Send minimal test task, await response |
| POST | `/zombrains/restart-bot` | auth | Railway service restart via Railway GraphQL API |
| POST | `/zombrains/guest-chat` | auth | Route guest chat through Railway runner |

### Persistence (tools + logs)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/zombrains/persist/tools-source` | auth | Save tools.js: syntax-checked before write |
| GET | `/zombrains/persist/tools-source` | auth | Restore tools.js backup |
| POST | `/zombrains/persist/logs` | auth | Bulk upload Railway logs: `[{level,module,msg,detail,stack,ts}]` |
| GET | `/zombrains/persist/logs` | auth | Query stored logs |
| POST | `/zombrains/persist/failure-log` | auth | Log task failure |
| GET | `/zombrains/persist/failure-log` | auth | Failure history |
| GET | `/zombrains/persist/progress/:taskId` | auth | Mid-task checkpoint |
| POST | `/zombrains/persist/progress/:taskId` | auth | Save checkpoint |
| DELETE | `/zombrains/persist/progress/:taskId` | auth | Clear checkpoint on completion |

---

## Key Invariants

1. **Every `getDb()` call is paired with `db.close()` in a `finally` block.** Never leave a connection open.
2. **Path escape check on every file operation.** `fullPath.startsWith(REPLIT_FILE_WORKSPACE_ROOT + path.sep)` — return 403 if violated.
3. **tools-source write is syntax-checked.** `new Function(content)` before `writeFileSync`. Never overwrite a good backup with broken JS.
4. **Deprecated prompt_index codes are never recycled.** Mark deprecated, set optional successor, stop there.
5. **ZomBrains cannot disable `zombrains_cluster_enabled`.** Safety guard in PATCH /cluster-flags — `x-zombrains-secret`-only requests that set this flag to false are silently blocked.
6. **Auto-approve BLOCK keywords are a hard veto.** Even `risk_tier=low` is denied if any BLOCK keyword appears in title+description.
7. **Viewer secret is one-time-use.** Burned immediately on `POST /verify-view-secret` success.
8. **All Railway proxy calls use `AbortSignal.timeout(N)`.** Never hang indefinitely waiting for Railway.
9. **`type=complete` reports auto-create a `queue_task` proposal row.** This is how "Tasks Done" counts increase in analytics.
10. **Outbox files are moved to `zb-outbox/sent/` after successful queue injection.** Never re-queued.
