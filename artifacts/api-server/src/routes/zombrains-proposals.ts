// ══════════════════════════════════════════════════════════════════════════════
// zombrains-proposals.ts — Proposals, code-stats, loop-events, capability-gaps,
//   proposal-verify, poopy/infer, and embedded worker proxy endpoints.
// Extracted from zombrains.ts (was lines 936-1615).
// ══════════════════════════════════════════════════════════════════════════════
import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { callProvider, type Msg, getWorkerStats, getActiveSlotNames } from "../lib/providers.js";
import { getLiveWorkers } from "./zombrains-workers.js";
import {
  getDb, authCheck, readonlyAuthCheck,
} from "./zombrains-shared.js";

const router: IRouter = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Proposals ─────────────────────────────────────────────────────────────────

// FILE_ACCESS_NOTE prepended to every task injected from an approved proposal.
const FILE_ACCESS_NOTE = `IMPORTANT — FILE ACCESS:
The Poopy Discord bot codebase lives in the Replit workspace, NOT on Railway.
• To READ files:  use read_project_file({ path: "index.js" })
• To WRITE files: use write_project_file({ path: "index.js", content: "..." })
• To SEARCH:      use search_project_files({ pattern: "...", path: "." })
Do NOT use read_file, write_file, or shell commands for Replit files — they will fail.
When done, call report_to_replit with type=complete, then call propose_task with a summary.

`;

/**
 * Daily cap for code-adjacent MEDIUM auto-approvals.
 * Resets each UTC day. Prevents overnight bursts of tool/config proposals
 * from executing without any human visibility.
 */
const _dailyCodeCapCounts = new Map<string, number>();
const DAILY_CODE_CAP = 3;
const CODE_ADJACENT_KEYWORDS = ["config", "tool", "agent", "rules", "prompt", "queue", "worker"];

function getDailyCodeCapCount(): number {
  const today = new Date().toISOString().slice(0, 10);
  for (const k of _dailyCodeCapCounts.keys()) { if (k !== today) _dailyCodeCapCounts.delete(k); }
  return _dailyCodeCapCounts.get(today) ?? 0;
}
function incrementDailyCodeCap(): void {
  const today = new Date().toISOString().slice(0, 10);
  _dailyCodeCapCounts.set(today, getDailyCodeCapCount() + 1);
}

/**
 * Server-side proposal risk scorer — runs independently of ZomBrains' self-reported
 * risk_tier so the tier can be trusted as a floor, not a ceiling.
 *
 * Rules applied in order (first match wins):
 *  1. Tool promotion proposals → never auto-approve (need human verification)
 *  2. risk_tier=high → never
 *  3. Hard block keywords → never (catches mis-labeled dangerous tasks)
 *  4. risk_tier=low + no blocks → approve
 *  5. risk_tier=medium + code-adjacent + daily cap not hit → approve (counted toward cap)
 *  6. risk_tier=medium + code-adjacent + cap hit → hold for human
 *  7. risk_tier=medium + not code-adjacent + not blocked → approve (no cap)
 *  8. Everything else → no
 *
 * Note: the zombrains_auto_approve_enabled flag is checked at the CALL SITE
 * (POST /zombrains/proposals handler), not here — keeps this function pure/testable.
 */
function scoreProposal(title: string, description: string, riskTier: string, proposalType: string, dailyCap = DAILY_CODE_CAP): { autoApprove: boolean; reason: string } {
  const text = `${title} ${description}`.toLowerCase();
  if (proposalType === "tool_promotion") return { autoApprove: false, reason: "tool promotions always require human review" };
  if (riskTier === "high") return { autoApprove: false, reason: "high risk tier" };
  const HARD_BLOCK = ["delete all", "drop table", "rm -rf", "format disk", "wipe", "nuclear", "destroy", "irreversible"];
  if (HARD_BLOCK.some(kw => text.includes(kw))) return { autoApprove: false, reason: "hard-block keyword detected" };
  if (riskTier === "low") return { autoApprove: true, reason: "low risk tier" };
  if (riskTier === "medium") {
    const isCodeAdjacent = CODE_ADJACENT_KEYWORDS.some(kw => text.includes(kw));
    if (isCodeAdjacent) {
      if (getDailyCodeCapCount() >= dailyCap) {
        return { autoApprove: false, reason: `daily code-adjacent cap (${dailyCap}) reached` };
      }
      incrementDailyCodeCap();
      return { autoApprove: true, reason: `medium code-adjacent — daily cap ${getDailyCodeCapCount()}/${dailyCap}` };
    }
    return { autoApprove: true, reason: "medium risk, no block" };
  }
  return { autoApprove: false, reason: "no auto-approve rule matched" };
}

const ZOMBRAINS_URL = "https://builder-agent-production.up.railway.app";

// ── Lazy schema migrations ─────────────────────────────────────────────────────
{
  const _mdb = getDb();
  try { _mdb.prepare("ALTER TABLE zombrains_proposals ADD COLUMN auto_approved INTEGER DEFAULT 0").run(); } catch {}
  try { _mdb.prepare("ALTER TABLE zombrains_proposals ADD COLUMN auto_approve_reason TEXT").run(); } catch {}
  try { _mdb.prepare("ALTER TABLE zombrains_proposals ADD COLUMN complexity_hint TEXT").run(); } catch {}
  _mdb.close();
}

router.post("/zombrains/proposals", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const {
    title, description, type = "task", risk_tier = "medium",
    tool_metadata, sort_order, complexity_hint,
  } = req.body as {
    title?: string; description?: string; type?: string; risk_tier?: string;
    tool_metadata?: unknown; sort_order?: number; complexity_hint?: string;
  };
  if (!title?.trim() || !description?.trim()) {
    res.status(400).json({ error: "title and description required" }); return;
  }
  const db = getDb();

  // Dedup: reject identical (title+description) proposals that are still pending
  const existing = db.prepare(
    "SELECT id FROM zombrains_proposals WHERE title=? AND description=? AND status='pending' LIMIT 1"
  ).get(title.trim(), description.trim()) as { id: number } | undefined;
  if (existing) {
    db.close();
    res.status(409).json({ ok: false, duplicate: true, id: existing.id, message: "identical pending proposal already exists" });
    return;
  }

  // Task-plans-only gate: when this mode is active, reject all autonomously-generated
  // proposals. Only owner-injected tasks (source=owner / ownerTask=true) are allowed.
  // This lets the owner clear the queue and run only their specific task plans.
  const tpoRow = db.prepare("SELECT enabled FROM feature_flags WHERE flag='zombrains_task_plans_only'").get() as { enabled: number } | undefined;
  if (tpoRow?.enabled === 1) {
    const isOwnerSource = (req.headers["x-admin-secret"] ?? req.headers["x-zombrains-admin"]) === (process.env["ADMIN_SECRET"] ?? "");
    if (!isOwnerSource) {
      db.close();
      res.status(423).json({ ok: false, blocked: true, reason: "task-plans-only mode active — autonomous proposals are blocked" });
      return;
    }
  }

  // Auto-approve scoring — gated behind the zombrains_auto_approve_enabled flag.
  // When the owner turns auto-approve OFF in the admin panel, all proposals stay
  // pending regardless of risk tier. The flag check lives here (not inside
  // scoreProposal) so the scoring function stays pure and testable.
  const autoApproveFlag = db.prepare(
    "SELECT enabled FROM feature_flags WHERE flag='zombrains_auto_approve_enabled'"
  ).get() as { enabled: number } | undefined;
  const flagOn = autoApproveFlag?.enabled === 1;
  const capRow = db.prepare("SELECT value FROM zombrains_settings WHERE key='auto_approve_daily_cap'").get() as { value: string } | undefined;
  const dynamicCap = capRow ? (Number(capRow.value) || DAILY_CODE_CAP) : DAILY_CODE_CAP;
  const { autoApprove, reason } = flagOn
    ? scoreProposal(title, description, risk_tier, type, dynamicCap)
    : { autoApprove: false, reason: "auto-approve disabled" };
  const initialStatus = autoApprove ? "approved" : "pending";

  const result = db.prepare(
    `INSERT INTO zombrains_proposals (title, description, type, risk_tier, tool_metadata, sort_order, status, auto_approved, auto_approve_reason, complexity_hint, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    title.trim(), description.trim(), type, risk_tier,
    tool_metadata ? JSON.stringify(tool_metadata) : null,
    sort_order ?? 0,
    initialStatus,
    autoApprove ? 1 : 0,
    reason,
    complexity_hint ?? null,
  );
  const id = result.lastInsertRowid;

  // If auto-approved, immediately inject into ZomBrains' queue
  if (autoApprove) {
    const prompt = `${FILE_ACCESS_NOTE}AUTO-APPROVED TASK: ${title}\n\n${description}\n\nFollow the FILE ACCESS instructions above exactly.`;
    fetch(`${ZOMBRAINS_URL}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, ...(complexity_hint ? { complexity_hint } : {}) }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
  }

  db.close();
  res.json({ ok: true, id, status: initialStatus, autoApproved: autoApprove, autoApproveReason: reason });
});

router.get("/zombrains/proposals/pending-discord", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const rows = db.prepare("SELECT * FROM zombrains_proposals WHERE discord_message_id IS NULL AND status='pending' ORDER BY id DESC LIMIT 20").all();
  db.close();
  res.json(rows as unknown[]);
});

router.patch("/zombrains/proposals/:id/discord-posted", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { id, discord_message_id, discord_channel_id } = req.body as { id?: number; discord_message_id?: string; discord_channel_id?: string };
  if (!id || !discord_message_id || !discord_channel_id) {
    res.status(400).json({ error: "id, discord_message_id, discord_channel_id required" }); return;
  }
  const db = getDb();
  db.prepare("UPDATE zombrains_proposals SET discord_message_id=?, discord_channel_id=? WHERE id=?").run(discord_message_id, discord_channel_id, id);
  db.close();
  res.json({ ok: true });
});

router.get("/zombrains/proposals", (req: Request, res: Response) => {
  if (!readonlyAuthCheck(req, res)) return;
  const status = req.query["status"] as string | undefined;
  const db = getDb();
  const rows = status
    ? db.prepare("SELECT * FROM zombrains_proposals WHERE status = ? ORDER BY sort_order DESC, id DESC LIMIT 50").all(status)
    : db.prepare("SELECT * FROM zombrains_proposals ORDER BY sort_order DESC, id DESC LIMIT 50").all();
  db.close();
  res.json(rows as unknown[]);
});

// ── GET /zombrains/proposals/pending ─────────────────────────────────────────
// Lightweight list of currently-pending proposals for dedup checks.
// ZomBrains' propose_task tool calls this before submitting to detect fuzzy duplicates.
router.get("/zombrains/proposals/pending", (req: Request, res: Response) => {
  if (!readonlyAuthCheck(req, res)) return;
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, title, description, created_at FROM zombrains_proposals WHERE status='pending' ORDER BY id DESC LIMIT 100"
  ).all();
  db.close();
  res.json(rows as unknown[]);
});

router.patch("/zombrains/proposals/:id", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const id = Number(req.params["id"]);
  const { action, text, reviewer_note } = req.body as { action: "approve" | "reject" | "revise"; text?: string; reviewer_note?: string };
  if (!action) { res.status(400).json({ error: "action required" }); return; }

  const db = getDb();
  const proposal = db.prepare("SELECT * FROM zombrains_proposals WHERE id = ?").get(id) as
    { id: number; title: string; description: string; status: string; type: string; tool_metadata: string | null; complexity_hint: string | null } | undefined;
  if (!proposal) { db.close(); res.status(404).json({ error: "Not found" }); return; }

  if (action === "reject") {
    db.prepare("UPDATE zombrains_proposals SET status='rejected', updated_at=datetime('now') WHERE id=?").run(id);
    // ── Taste model: record rejection ─────────────────────────────────────────
    try {
      const _text  = `${proposal.title} ${proposal.description || ""}`.toLowerCase();
      const _scope = /fix|bug|broken|crash/.test(_text) ? "bugfix"
                   : /add|implement|build|feature/.test(_text) ? "feature"
                   : /refactor|clean/.test(_text) ? "refactor"
                   : /tool|capability/.test(_text) ? "tool"
                   : /readme|comment|document/.test(_text) ? "docs"
                   : "other";
      const _d = new Date().toISOString().slice(0, 10);
      db.prepare(`INSERT INTO zombrains_library (title, content, category, tags) VALUES (?, ?, 'taste', ?)
        ON CONFLICT(title) DO UPDATE SET content=excluded.content, tags=excluded.tags, updated_at=datetime('now')`)
        .run(`Taste[${_d}]: reject — ${proposal.title.slice(0, 60)}`,
             JSON.stringify({ action: "reject", scope: _scope, title: proposal.title, date: _d }),
             `action:reject,scope:${_scope}`);
    } catch { /* non-fatal */ }
    db.close();
    res.json({ ok: true, status: "rejected" });
    return;
  }

  if (action === "approve" || action === "revise") {
    const finalText = (action === "revise" && text) ? text : proposal.description;
    if (action === "revise") {
      db.prepare("UPDATE zombrains_proposals SET status='approved', revised_text=?, reviewer_note=?, updated_at=datetime('now') WHERE id=?").run(text ?? null, reviewer_note ?? null, id);
    } else {
      db.prepare("UPDATE zombrains_proposals SET status='approved', reviewer_note=?, updated_at=datetime('now') WHERE id=?").run(reviewer_note ?? null, id);
    }
    const reviewNote = (reviewer_note ?? "").trim();
    const prompt = `${FILE_ACCESS_NOTE}APPROVED TASK: ${proposal.title}\n\n${finalText}${reviewNote ? `\n\nOWNER NOTE: ${reviewNote}` : ""}\n\nFollow the FILE ACCESS instructions above exactly.`;

    // ── Tool promotion: queue a dedicated promote-tool task ────────────────
    if (proposal.type === "tool_promotion") {
      const meta = (() => { try { return JSON.parse(proposal.tool_metadata ?? "{}"); } catch { return {}; } })() as Record<string, unknown>;
      const taskId = `tool-promote-${id}-${Date.now()}`;
      const toolName = String(meta.toolName ?? "unknownTool");
      const toolCode = String(meta.toolCode ?? "// no code provided");
      const gapId    = String(meta.gapId ?? "");
      const toolPrompt = `TOOL PROMOTION APPROVED by admin.

Tool name: ${toolName}
Gap filled: ${gapId}

Write the following tool permanently to builder-agent/tools/${toolName}.js:

\`\`\`javascript
${toolCode}
\`\`\`

After writing the file, register the tool in your tool registry / CAPABILITY_MANIFEST.json. Then call propose_task with a brief summary confirming the promotion.`;
      const queueRow = db.prepare("SELECT data FROM zombrains_queue WHERE key='main'").get() as { data: string } | undefined;
      const currentQueue: unknown[] = queueRow ? (() => { try { return JSON.parse(queueRow.data); } catch { return []; } })() : [];
      currentQueue.push({
        id: taskId, prompt: toolPrompt, status: "pending",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        source: "tool_promotion", proposalId: id,
      });
      db.prepare(`INSERT INTO zombrains_queue (key, data, updated_at) VALUES ('main', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
      ).run(JSON.stringify(currentQueue));
      db.close();
      res.json({ ok: true, status: "queued", taskId, toolName });
      return;
    }

    // ── Regular task proposal: push directly to ZomBrains' queue ─────────────
    const taskId = `proposal-${id}-${Date.now()}`;
    db.close();

    // Fire-and-forget: push task directly to ZomBrains' Railway /queue endpoint
    const _hint = proposal.complexity_hint;
    fetch(`${ZOMBRAINS_URL}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, ...(_hint ? { complexity_hint: _hint } : {}) }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => { /* non-fatal — ZomBrains will pick it up on next poll */ });

    res.json({ ok: true, status: "queued", taskId });
    return;
  }

  if (action === "queue") {
    db.prepare("UPDATE zombrains_proposals SET status='queued', updated_at=datetime('now') WHERE id=?").run(id);
    db.close();
    res.json({ ok: true, status: "queued" });
    return;
  }

  if (action === "complete") {
    const note = text ?? null;
    db.prepare("UPDATE zombrains_proposals SET status='completed', revised_text=COALESCE(?,revised_text), updated_at=datetime('now') WHERE id=?").run(note, id);
    db.close();
    res.json({ ok: true, status: "completed" });
    return;
  }

  if (action === "cancel") {
    // Reset to pending and sink to bottom of the list by decrementing sort_order
    db.prepare("UPDATE zombrains_proposals SET status='pending', sort_order=sort_order-1, updated_at=datetime('now') WHERE id=?").run(id);
    db.close();
    res.json({ ok: true, status: "pending", deferred: true });
    return;
  }

  db.close();
  res.status(400).json({ error: "unknown action" });
});

// ── Code stats (cached — git lock-safe) ──────────────────────────────────────

const CODE_STATS_WORKSPACE = path.resolve(__dirname, "..", "..", "..");

interface GitAuthorStats { commits: number; linesAdded: number; linesDeleted: number; topFiles: { file: string; added: number }[]; }
interface CodeStatsPayload {
  replitAgent: GitAuthorStats;
  zombrainsReplit: GitAuthorStats;
  user: GitAuthorStats;
  computedAt: string;
}

let _gitStatsCache: CodeStatsPayload | null = null;
let _gitStatsCachedAt = 0;
const GIT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function _gitNumstat(author: string): { added: number; deleted: number } {
  try {
    const raw = execSync(
      `git --no-optional-locks log --author="${author}" --pretty=tformat: --numstat`,
      { cwd: CODE_STATS_WORKSPACE, encoding: "utf8", stdio: "pipe", timeout: 30000 }
    );
    let added = 0, deleted = 0;
    for (const line of raw.split("\n")) {
      const parts = line.trim().split("\t");
      if (parts.length === 3 && parts[0] !== "-" && parts[1] !== "-") {
        added   += parseInt(parts[0]) || 0;
        deleted += parseInt(parts[1]) || 0;
      }
    }
    return { added, deleted };
  } catch (e) {
    console.error("[code-stats] numstat failed for", author, String(e));
    return { added: 0, deleted: 0 };
  }
}

function _gitCommitCount(author: string): number {
  try {
    const out = execSync(
      `git --no-optional-locks log --author="${author}" --oneline`,
      { cwd: CODE_STATS_WORKSPACE, encoding: "utf8", stdio: "pipe", timeout: 15000 }
    ).trim();
    return out ? out.split("\n").length : 0;
  } catch (e) {
    console.error("[code-stats] commitCount failed for", author, String(e));
    return 0;
  }
}

function _gitTopFiles(authors: string[]): { file: string; added: number }[] {
  try {
    const totals: Record<string, number> = {};
    for (const author of authors) {
      const raw = execSync(
        `git --no-optional-locks log --author="${author}" --pretty=tformat: --numstat`,
        { cwd: CODE_STATS_WORKSPACE, encoding: "utf8", stdio: "pipe", timeout: 30000 }
      );
      for (const line of raw.split("\n")) {
        const parts = line.trim().split("\t");
        if (parts.length === 3 && parts[0] !== "-" && parts[1] !== "-") {
          const added = parseInt(parts[0]) || 0;
          if (added > 0) totals[parts[2]] = (totals[parts[2]] ?? 0) + added;
        }
      }
    }
    return Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([file, added]) => ({ file, added }));
  } catch { return []; }
}

function _computeGitStats(): CodeStatsPayload {
  const agentAuthors = ["Replit Agent", "Agent", "agent"];
  let agentAdded = 0, agentDeleted = 0, agentCommits = 0;
  for (const a of agentAuthors) {
    const ns = _gitNumstat(a);
    agentAdded   += ns.added;
    agentDeleted += ns.deleted;
    agentCommits += _gitCommitCount(a);
  }
  const zbNs      = _gitNumstat("zb01");
  const zbCommits = _gitCommitCount("zb01");
  const userNs      = _gitNumstat("zombeef01");
  const userCommits = _gitCommitCount("zombeef01");
  return {
    replitAgent:     { commits: agentCommits, linesAdded: agentAdded, linesDeleted: agentDeleted, topFiles: _gitTopFiles(agentAuthors) },
    zombrainsReplit: { commits: zbCommits,    linesAdded: zbNs.added, linesDeleted: zbNs.deleted, topFiles: _gitTopFiles(["zb01"]) },
    user:            { commits: userCommits,  linesAdded: userNs.added, linesDeleted: userNs.deleted, topFiles: [] },
    computedAt: new Date().toISOString(),
  };
}

function getGitStats(force = false): CodeStatsPayload {
  const now = Date.now();
  if (!force && _gitStatsCache && (now - _gitStatsCachedAt) < GIT_CACHE_TTL_MS) {
    return _gitStatsCache;
  }
  _gitStatsCache = _computeGitStats();
  _gitStatsCachedAt = now;
  return _gitStatsCache;
}

// Warm the cache at startup so first request is instant
setTimeout(() => { try { getGitStats(); } catch { /* non-fatal */ } }, 5000);

router.get("/zombrains/code-stats", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;

  const forceRefresh = req.query["refresh"] === "1";
  const gitStats = getGitStats(forceRefresh);

  // Task completion counts from DB
  const db = getDb();
  const completedTasks = (db.prepare(
    "SELECT COUNT(*) as cnt FROM zombrains_proposals WHERE status='completed' AND type='task'"
  ).get() as { cnt: number }).cnt;
  const totalProposals = (db.prepare(
    "SELECT COUNT(*) as cnt FROM zombrains_proposals WHERE type='task'"
  ).get() as { cnt: number }).cnt;
  const completedTools = (db.prepare(
    "SELECT COUNT(*) as cnt FROM zombrains_proposals WHERE status='completed' AND type='tool_promotion'"
  ).get() as { cnt: number }).cnt;
  // ZomBrains Railway queue task completions (recorded by POST /report with type='complete')
  const zbQueueDone = (db.prepare(
    "SELECT COUNT(*) as cnt FROM zombrains_proposals WHERE status='completed' AND type='queue_task'"
  ).get() as { cnt: number }).cnt;
  const zbQueueWithCode = (db.prepare(
    "SELECT COUNT(*) as cnt FROM zombrains_proposals WHERE status='completed' AND type='queue_task' AND has_code=1"
  ).get() as { cnt: number }).cnt;

  const linesAcrossTasks =
    gitStats.replitAgent.linesAdded +
    gitStats.zombrainsReplit.linesAdded;

  const agentLinesAdded = gitStats.replitAgent.linesAdded;
  const zbLinesAdded = gitStats.zombrainsReplit.linesAdded;

  db.close();

  // Fetch ZomBrains' Railway git stats (non-blocking)
  let railwayStats: Record<string, unknown> | null = null;
  try {
    const r = await fetch("https://builder-agent-production.up.railway.app/git-stats", {
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) railwayStats = await r.json() as Record<string, unknown>;
  } catch { /* Railway may be cold or redeploying */ }

  res.json({
    replitAgent:      gitStats.replitAgent,
    zombrainsReplit:  gitStats.zombrainsReplit,
    user:             gitStats.user,
    zombrainsRailway: railwayStats ?? null,
    tasks: {
      completed: completedTasks,
      total:     totalProposals,
      toolsBuilt: completedTools,
      linesAcrossTasks,
      zbQueueDone,
      zbQueueWithCode,
      agentLinesAdded,
      zbLinesAdded,
    },
    computedAt:  gitStats.computedAt,
    generatedAt: new Date().toISOString(),
  });
});

// ── Loop events ───────────────────────────────────────────────────────────────

router.post("/zombrains/loop-events", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { gap_id, task_id, event_type, tool_name, details } = req.body as {
    gap_id?: string; task_id?: string; event_type: string;
    tool_name?: string; details?: Record<string, unknown>;
  };
  if (!event_type) { res.status(400).json({ error: "event_type required" }); return; }
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO zombrains_loop_events (gap_id, task_id, event_type, tool_name, details) VALUES (?,?,?,?,?)"
  ).run(gap_id ?? null, task_id ?? null, String(event_type), tool_name ?? null, details ? JSON.stringify(details) : null);
  db.close();
  res.json({ ok: true, id: result.lastInsertRowid });
});

router.get("/zombrains/loop-events", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM zombrains_loop_events ORDER BY id DESC LIMIT ?"
  ).all(limit);
  db.close();
  res.json(rows as unknown[]);
});

// ── Capability gaps ───────────────────────────────────────────────────────────

router.post("/zombrains/capability-gaps", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { task_id, task_prompt, gap_description, feasibility_result, feasibility_reason, outcome } =
    req.body as Record<string, string>;
  if (!task_id) { res.status(400).json({ error: "task_id required" }); return; }
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO zombrains_capability_gaps (task_id, task_prompt, gap_description, feasibility_result, feasibility_reason, outcome) VALUES (?,?,?,?,?,?)"
  ).run(String(task_id), String(task_prompt ?? ""), String(gap_description ?? ""), String(feasibility_result ?? "unknown"), String(feasibility_reason ?? ""), String(outcome ?? ""));
  db.close();
  res.json({ ok: true, id: result.lastInsertRowid });
});

router.get("/zombrains/capability-gaps", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  const rows = db.prepare("SELECT * FROM zombrains_capability_gaps ORDER BY id DESC LIMIT 60").all();
  db.close();
  res.json(rows as unknown[]);
});

router.patch("/zombrains/capability-gaps/:id/dismiss", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const id = Number(req.params["id"]);
  const db = getDb();
  db.prepare("UPDATE zombrains_capability_gaps SET dismissed=1 WHERE id=?").run(id);
  db.close();
  res.json({ ok: true });
});

router.post("/zombrains/capability-gaps/:id/force-build", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const id = Number(req.params["id"]);
  const db = getDb();
  const gap = db.prepare("SELECT * FROM zombrains_capability_gaps WHERE id=?").get(id) as
    { task_id: string; task_prompt: string; gap_description: string } | undefined;
  if (!gap) { db.close(); res.status(404).json({ error: "Gap not found" }); return; }
  db.prepare("UPDATE zombrains_capability_gaps SET outcome='force_build_requested', dismissed=0 WHERE id=?").run(id);
  db.prepare("INSERT INTO zombrains_proposals (title, description) VALUES (?,?)").run(
    `[FORCE-BUILD] ${gap.gap_description.slice(0, 80)}`,
    `Human override: build the missing capability for task ${gap.task_id}.\n\n${gap.task_prompt}`,
  );
  db.close();
  res.json({ ok: true });
});

// ── Proposal verify (no-AI codebase check) ────────────────────────────────────

const WORKSPACE = path.resolve(__dirname, "..", "..", "..", "..");

function shellSafe(cmd: string): string {
  try { return execSync(cmd, { cwd: WORKSPACE, timeout: 8000 }).toString().trim(); }
  catch (e: unknown) { return (e as { stdout?: Buffer; message?: string }).stdout?.toString().trim() ?? String((e as { message?: string }).message ?? ""); }
}

// ── Auto-approvable endpoint — proposals that crystal-trust recommends ───────
// Returns proposals whose task domain has earned 'auto-approve' recommendation
// from crystal history. Proposals without crystal data stay in human review.
// Query: proposals in status 'pending' or 'hold' that are NOT high-risk.
router.get("/zombrains/proposals/auto-approvable", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    type ProposalRow = { id: number; title: string; description: string; type: string; risk_tier: string; complexity_hint: string | null; created_at: string };
    const pending = db.prepare(
      "SELECT id, title, description, type, risk_tier, complexity_hint, created_at FROM zombrains_proposals WHERE status = 'pending' AND risk_tier != 'high' AND (auto_approved IS NULL OR auto_approved = 0) ORDER BY id DESC LIMIT 50"
    ).all() as ProposalRow[];
    db.close();

    if (pending.length === 0) { res.json({ ok: true, proposals: [], total: 0 }); return; }

    // Fetch trust for each proposal's type (used as taskDomain proxy).
    // Fire requests in parallel — if any fail, that proposal is excluded (safe default).
    const DB_BASE = process.env.NODE_ENV !== "production" ? "http://localhost" : `https://${process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() ?? ""}`;
    const secret  = process.env.ZOMBRAINS_SECRET ?? process.env.ADMIN_SECRET ?? "";

    const trustChecks = pending.map(async (p) => {
      const domain = (p.type ?? "general").trim() || "general";
      try {
        const r = await fetch(`${DB_BASE}/api/zombrains/persist/crystal-trust?taskDomain=${encodeURIComponent(domain)}`, {
          headers: { "Authorization": `Bearer ${secret}` },
          signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) return null;
        const data = await r.json() as { ok: boolean; recommendation: string; trustScore: number; avgQuality: number; sampleTasks: number };
        if (!data.ok || data.recommendation !== "auto-approve") return null;
        return { proposal: p, trust: { trustScore: data.trustScore, avgQuality: data.avgQuality, sampleTasks: data.sampleTasks, taskDomain: domain } };
      } catch { return null; }
    });

    const results = await Promise.all(trustChecks);
    const autoApprovable = results.filter((r): r is NonNullable<typeof r> => r !== null);
    res.json({ ok: true, proposals: autoApprovable, total: autoApprovable.length });
  } catch (e) {
    res.status(500).json({ error: "internal error", detail: (e as Error).message });
  }
});

// ── Daily auto-approve cap — read / write ────────────────────────────────────
router.get("/zombrains/proposals/daily-cap", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const capRow = db.prepare("SELECT value FROM zombrains_settings WHERE key='auto_approve_daily_cap'").get() as { value: string } | undefined;
    const cap = capRow ? (Number(capRow.value) || DAILY_CODE_CAP) : DAILY_CODE_CAP;
    res.json({ ok: true, cap, current: getDailyCodeCapCount() });
  } finally { db.close(); }
});

router.patch("/zombrains/proposals/daily-cap", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { cap } = req.body as { cap?: number };
  if (typeof cap !== "number" || cap < 0 || cap > 50) {
    res.status(400).json({ error: "cap must be a number 0–50" }); return;
  }
  const db = getDb();
  try {
    db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('auto_approve_daily_cap', ?)").run(String(cap));
    res.json({ ok: true, cap });
  } finally { db.close(); }
});

// ── Auto-approved audit log ───────────────────────────────────────────────────
router.get("/zombrains/proposals/auto-approved-log", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const rows = db.prepare(
      "SELECT id, title, risk_tier, auto_approve_reason, complexity_hint, created_at FROM zombrains_proposals WHERE auto_approved=1 ORDER BY id DESC LIMIT 30"
    ).all();
    res.json({ ok: true, log: rows });
  } finally { db.close(); }
});

router.post("/zombrains/proposals/:id/verify", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const id = Number(req.params["id"]);
  const db = getDb();
  const proposal = db.prepare("SELECT * FROM zombrains_proposals WHERE id=?").get(id) as
    { id: number; title: string; description: string; status: string; updated_at: string } | undefined;
  db.close();
  if (!proposal) { res.status(404).json({ error: "Not found" }); return; }

  const text = `${proposal.title} ${proposal.description}`;

  // Extract candidate identifiers without AI
  const backticked   = [...text.matchAll(/`([^`\n]{2,60})`/g)].map(m => m[1]);
  const snakeCase    = (text.match(/\b[a-z][a-z0-9]*(?:_[a-z][a-z0-9]+)+\b/g) ?? ([] as string[])).filter(w => w.length > 6);
  const camelCase    = (text.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+\b/g) ?? ([] as string[])).filter(w => w.length > 5);
  const filePaths    = (text.match(/[\w./\\-]+\.(?:ts|js|tsx|jsx|json|md)\b/g) ?? []);
  const allTerms     = [...new Set([...backticked, ...snakeCase, ...camelCase, ...filePaths])].slice(0, 12);

  // Grep builder-agent src for each term
  const grepResults = allTerms.map(term => {
    const escaped = term.replace(/['"\\]/g, "\\$&");
    const out = shellSafe(
      `grep -rl "${escaped}" builder-agent/src artifacts/api-server/src 2>/dev/null || true`
    );
    const files = out.split("\n").filter(Boolean);
    return { term, found: files.length > 0, files: files.slice(0, 5) };
  });

  // Recent git log
  const gitLog = shellSafe("git log --oneline -12");

  // Files changed in last 2 commits
  const recentFiles = shellSafe("git diff --name-only HEAD~2 HEAD 2>/dev/null || git diff --name-only HEAD 2>/dev/null || true");

  // Check specific builder-agent tool registrations
  const toolNames = allTerms.filter(t => t.includes("_") || t.match(/[A-Z]/));
  const toolRegistered = toolNames.map(t => {
    const out = shellSafe(`grep -c "${t}" builder-agent/src/tools.js 2>/dev/null || echo 0`);
    return { tool: t, count: parseInt(out) || 0 };
  });

  res.json({
    proposal: { id: proposal.id, title: proposal.title, status: proposal.status, completed_at: proposal.updated_at },
    terms: allTerms,
    grepResults,
    toolRegistered,
    gitLog,
    recentFiles: recentFiles.split("\n").filter(Boolean),
  });
});

// ── Poopy Bot inference endpoint ───────────────────────────────────────────────
// Lets the Poopy Discord bot delegate AI calls to the cluster's callProvider()
// waterfall instead of calling a single provider directly.  Separate from the
// ZomBrains worker/run path so Poopy traffic is distinguishable in logs/stats.

router.post("/poopy/infer", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  // Server-side cluster gate — mirrors the client-side check in the Discord bot
  // so the flag is enforced even if called directly (e.g. from a worker).
  const db0 = getDb();
  const clusterRow = db0.prepare("SELECT enabled FROM feature_flags WHERE flag='poopy_cluster_enabled'").get() as { enabled: number } | undefined;
  db0.close();
  if (clusterRow !== undefined && clusterRow.enabled === 0) {
    res.status(503).json({ ok: false, error: "Poopy cluster disabled" });
    return;
  }
  const { messages: rawMessages, prompt } = req.body as { messages?: Msg[]; prompt?: string };
  if (!rawMessages && !prompt) { res.status(400).json({ error: "messages or prompt required" }); return; }
  const messages: Msg[] = rawMessages ?? [{ role: "user", content: String(prompt) }];
  try {
    const { result, provider, tokens } = await callProvider(messages, "poopy-groq", { source: "poopy" });
    res.json({ ok: true, result, provider, tokens });
  } catch (e) {
    res.status(503).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Embedded worker endpoint ───────────────────────────────────────────────────

router.post("/zombrains/worker/run", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { prompt, messages: rawMessages } = req.body as { prompt?: string; messages?: Msg[] };
  if (!prompt && !rawMessages) { res.status(400).json({ error: "prompt or messages required" }); return; }
  const messages = rawMessages ?? [{ role: "user", content: String(prompt) }];
  try {
    const { result, provider, tokens } = await callProvider(messages);
    res.json({ ok: true, result, provider, tokens });
  } catch (e) {
    res.status(503).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.get("/zombrains/worker/health", (_req: Request, res: Response) => {
  const providers = getActiveSlotNames();
  const workers   = getLiveWorkers();
  res.json({ ok: true, label: "poopy-bot", providers, workers, ts: new Date().toISOString() });
});

router.get("/zombrains/worker/stats", (_req: Request, res: Response) => {
  const stats = getWorkerStats();
  const allTotal = [...stats.byProvider.values()].reduce((s, b) => s + b.total, 0);
  const byProvider = [...stats.byProvider.entries()].map(([name, b]) => ({
    name, ...b,
    pct: allTotal > 0 ? Math.round((b.total / allTotal) * 100) : 0,
  })).sort((a, b) => b.total - a.total);
  const session = {
    prompt:     byProvider.reduce((s, b) => s + b.prompt, 0),
    completion: byProvider.reduce((s, b) => s + b.completion, 0),
    total:      allTotal,
    calls:      byProvider.reduce((s, b) => s + b.calls, 0),
  };
  const activeProviders = getActiveSlotNames();
  const workers         = getLiveWorkers();
  res.json({ ok: true, label: "poopy-bot", session, byProvider, activeProviders, workers, resetAt: stats.resetAt });
});

export default router;
