import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger";

const ZOMBRAINS_URL = "https://builder-agent-production.up.railway.app";
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "..", "..", "poop_tracker.db");

function isModularizationDone(): boolean {
  try {
    const db = new Database(DB_PATH);
    const row = db.prepare(
      "SELECT id FROM zombrains_reports WHERE type = 'complete' AND task = 'index-modularize' ORDER BY id DESC LIMIT 1"
    ).get();
    db.close();
    return !!row;
  } catch {
    return false;
  }
}

// Report endpoint — override with ZOMBRAINS_REPORT_URL env var.
// Defaults to the stable Railway URL so ZomBrains always reports back here.
const REPORT_URL =
  process.env["ZOMBRAINS_REPORT_URL"] ??
  "https://api-ai-api-ai.up.railway.app/api/zombrains/report";

// ── Modularization task — one step per session, progress-tracked, no loops ───
const PROGRESS_URL = `${REPORT_URL.replace("/report", "/persist/progress/index-modularize")}`;

const RESUME_PROMPT =
`You are a self-improving AI agent working on ONE ongoing task: modularizing the Poopy Discord bot's index.js into clean separate modules.

PROVIDER NOTE: Prefer groq and cerebras. Avoid sambanova (model deprecated).

═══════════════════════════════════════════════════════════
REPORTING — do this after EVERY step (success or failure):
POST ${REPORT_URL}
Header: x-zombrains-secret: <your ADMIN_SECRET env var>
Body (JSON):
  { "type": "progress", "task": "index-modularize",
    "message": "<one sentence summary of what you did>",
    "data": { "step": <number or "DONE">, "details": "<any notes>" } }
═══════════════════════════════════════════════════════════

PROGRESS TRACKING — use the API, not a file in the repo:

  Check current step:
    GET ${PROGRESS_URL}
    Header: x-zombrains-secret: <your ADMIN_SECRET env var>
    → Returns { step: <number>, history: [...] } or 404 if not started.

  Save progress after each step:
    POST ${PROGRESS_URL}
    Header: x-zombrains-secret: <your ADMIN_SECRET env var>
    Body: { "step": <number>, "history": ["step N done: <one line summary>", ...] }

  404 (not started) → step is 0, begin Step 1.
  step >= 8 → POST a report with type "complete", message "Modularization complete.", then stop.
  Otherwise → resume from the returned step number + 1.

FIRST ACTION every session:
  1. POST a "started" report: { "type": "info", "task": "index-modularize", "message": "Starting step <N>" }
  2. GET the progress URL above to find current step.
  3. Do exactly that one step.
  4. Save progress via POST.
  5. POST a "progress" report with what you did.
  6. Stop.

THE 8 STEPS (do exactly ONE per session):

Step 1 — Audit pass
  Read index.js in sections. List: (a) dead/never-called functions, (b) superseded stopgaps like buildAiMemoryBatch, (c) db.prepare patterns repeated 3+ times. Save findings in history. No file changes yet.

Step 2 — Remove dead code
  Delete only the dead functions/blocks from Step 1. Run node --check index.js to confirm it parses. Commit.

Step 3 — Extract bot/db.js
  Create bot/db.js. Move into it: better-sqlite3 require, db instance, all CREATE TABLE statements, shared query helpers. Add module.exports. Replace usage in index.js with require('./bot/db'). Run node --check. Commit.

Step 4 — Extract bot/ai.js
  Create bot/ai.js. Move into it: handlePoopyAiChat, askPoopy, memory management, profile updates, token generation, feedback handlers, stripCharacterBreakingClauses. Run node --check. Commit.

Step 5 — Extract bot/game.js
  Create bot/game.js. Move into it: poop logging, XP/level/streak logic, leaderboard queries, throw mechanics, badge system. Run node --check. Commit.

Step 6 — Extract bot/utils.js
  Create bot/utils.js. Move into it: formatters, embed builders, emoji helpers, cooldown helpers. Run node --check. Commit.

Step 7 — Extract bot/commands.js
  Create bot/commands.js. Move into it: slash command registration arrays and interactionCreate dispatch. Run node --check. Commit.

Step 8 — Thin index.js
  index.js should now only contain: requires for bot/* modules, Discord client setup, event registration, bot startup. Run node --check. Commit. Then POST type "complete" report.

═══════════════════════════════════════════════════════════
AI CONSULTANT — use when you need guidance on a decision:
POST https://api-ai-api-ai.up.railway.app/api/agent/task
Header: x-zombrains-secret: <your ADMIN_SECRET env var>
Body (JSON):
  { "prompt": "<your question>", "context": "<relevant code or context>" }
The consultant will reply with { "ok": true, "result": "..." }.
═══════════════════════════════════════════════════════════
RULES:
• ONE step per session. Report + save progress + stop.
• On any error: POST a report with type "error", save progress, stop cleanly.
• Never skip a step. Never combine steps. Never change logic — structure only.
• No new features, no TypeScript, no framework changes.
═══════════════════════════════════════════════════════════`;

function isClusterEnabled(): boolean {
  try {
    const db = new Database(DB_PATH);
    const row = db.prepare("SELECT enabled FROM feature_flags WHERE flag='zombrains_cluster_enabled'").get() as { enabled: number } | undefined;
    db.close();
    return row ? row.enabled === 1 : true;
  } catch {
    return true;
  }
}

async function checkAndPoke(): Promise<void> {
  try {
    if (!isClusterEnabled()) {
      logger.info("ZomBrains cluster disabled via feature flag — skipping poke");
      return;
    }
    try {
      const db2 = new Database(DB_PATH);
      const pauseRow = db2.prepare("SELECT enabled FROM feature_flags WHERE flag='zombrains_tasks_paused'").get() as { enabled: number } | undefined;
      db2.close();
      if (pauseRow?.enabled === 1) {
        logger.info("ZomBrains tasks paused via feature flag — skipping poke");
        return;
      }
    } catch { /* non-fatal */ }
    if (isModularizationDone()) {
      logger.info("Modularization complete — watchdog standing down");
      return;
    }

    const res = await fetch(`${ZOMBRAINS_URL}/queue`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) { logger.warn("ZomBrains queue unreachable"); return; }

    const tasks = (await res.json()) as { status: string }[];
    const active = tasks.filter(t => t.status === "pending" || t.status === "running");

    if (active.length === 0) {
      logger.info("ZomBrains idle — poking with resume task");
      const poke = await fetch(`${ZOMBRAINS_URL}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: RESUME_PROMPT }),
        signal: AbortSignal.timeout(8000),
      });
      if (poke.ok) {
        logger.info("ZomBrains poked successfully");
      } else {
        logger.warn({ status: poke.status }, "ZomBrains poke failed");
      }
    } else {
      logger.info({ active: active.length }, "ZomBrains is busy — no poke needed");
    }
  } catch (err) {
    logger.warn({ err }, "ZomBrains watchdog check failed");
  }
}

export function startZombrainsWatchdog(): void {
  logger.info("ZomBrains watchdog started (2-min interval)");
  setTimeout(() => {
    checkAndPoke();
    setInterval(checkAndPoke, CHECK_INTERVAL_MS);
  }, 15_000);
}
