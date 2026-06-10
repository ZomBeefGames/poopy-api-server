import { Router, type IRouter, type Request, type Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { callProvider, type Msg } from "../lib/providers.js";
import { db, errorLogTable, testRunsTable, eq, desc, gt } from "@workspace/db";
import {
  getDb, DB_PATH,
  authCheck, strictAuthCheck,
  REPLIT_FILE_WORKSPACE_ROOT,
} from "./zombrains-shared.js";

const router: IRouter = Router();

// They were absent from Monitor; added here to close the gap.
// ══════════════════════════════════════════════════════════════════════════════

// ── File proxy: READ ──────────────────────────────────────────────────────────
// Called by replit_api (op:read), read_project_file, read_project_file_range,
// read_replit_file, outline_file (via list-lines probe).
// Query: path (required), offset (1-based line number), limit (line count)
router.get("/zombrains/files/read", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const rawPath = req.query["path"] as string | undefined;
  if (!rawPath) { res.status(400).json({ error: "path is required" }); return; }
  const normalised = rawPath.replace(/^\/+/, "");
  const fullPath = path.resolve(REPLIT_FILE_WORKSPACE_ROOT, normalised);
  if (!fullPath.startsWith(REPLIT_FILE_WORKSPACE_ROOT + path.sep) && fullPath !== REPLIT_FILE_WORKSPACE_ROOT) {
    res.status(403).json({ error: "path escape not allowed" }); return;
  }
  try {
    const raw = fs.readFileSync(fullPath, "utf8");
    const lines = raw.split("\n");
    const offset = req.query["offset"] ? Math.max(1, Number(req.query["offset"])) : 1;
    const limit  = req.query["limit"]  ? Math.min(5000, Math.max(1, Number(req.query["limit"]))) : undefined;
    const slice  = limit ? lines.slice(offset - 1, offset - 1 + limit) : lines.slice(offset - 1);
    res.json({ ok: true, content: slice.join("\n"), totalLines: lines.length, returnedLines: slice.length, path: normalised });
  } catch (e: any) {
    const status = e.code === "ENOENT" ? 404 : 500;
    res.status(status).json({ error: e.message });
  }
});

// ── File proxy: WRITE ─────────────────────────────────────────────────────────
// Called by replit_api (op:write/append), write_project_file, append_project_file,
// patch_project_file, rollback_project_file.
// Body: { path, content, mode? } — mode defaults to "write"; "append" appends.
router.post("/zombrains/files/write", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { path: rawPath, content, mode = "write" } = req.body as { path?: string; content?: string; mode?: string };
  if (!rawPath || content === undefined) { res.status(400).json({ error: "path and content required" }); return; }
  const normalised = rawPath.replace(/^\/+/, "");
  const fullPath = path.resolve(REPLIT_FILE_WORKSPACE_ROOT, normalised);
  if (!fullPath.startsWith(REPLIT_FILE_WORKSPACE_ROOT + path.sep) && fullPath !== REPLIT_FILE_WORKSPACE_ROOT) {
    res.status(403).json({ error: "path escape not allowed" }); return;
  }
  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (mode === "append") {
      fs.appendFileSync(fullPath, content, "utf8");
    } else {
      fs.writeFileSync(fullPath, content, "utf8");
    }
    res.json({ ok: true, bytes: Buffer.byteLength(content, "utf8"), path: normalised });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── File proxy: SEARCH (grep) ─────────────────────────────────────────────────
// Called by replit_api (op:search), search_project_files, grep, count_in_project.
// Body: { pattern, path?, file_glob? }
router.post("/zombrains/files/search", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { pattern, path: rawPath, file_glob } = req.body as { pattern?: string; path?: string; file_glob?: string };
  if (!pattern) { res.status(400).json({ error: "pattern is required" }); return; }
  const searchRoot = rawPath
    ? (() => {
        const n = (rawPath as string).replace(/^\/+/, "");
        const fp = path.resolve(REPLIT_FILE_WORKSPACE_ROOT, n);
        return fp.startsWith(REPLIT_FILE_WORKSPACE_ROOT) ? fp : REPLIT_FILE_WORKSPACE_ROOT;
      })()
    : REPLIT_FILE_WORKSPACE_ROOT;
  try {
    const globArg = file_glob ? `--include="${file_glob}"` : "";
    const cmd = `grep -rn --max-count=50 -E ${JSON.stringify(pattern)} ${globArg} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist . 2>/dev/null | head -200`;
    const raw = execSync(cmd, { cwd: searchRoot, stdio: "pipe", timeout: 15_000, encoding: "utf8" });
    const results = raw.trim().split("\n").filter(Boolean).map(line => {
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) return { line };
      return { file: m[1], lineNumber: Number(m[2]), text: m[3] };
    });
    res.json({ ok: true, results, count: results.length });
  } catch (e: any) {
    if (e.status === 1) { res.json({ ok: true, results: [], count: 0 }); return; } // grep no match
    res.status(500).json({ error: e.message });
  }
});

// ── File proxy: COUNT (pattern occurrences) ───────────────────────────────────
// Called by count_in_project. Body: { pattern, path?, file_glob? }
router.post("/zombrains/files/count", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { pattern, path: rawPath, file_glob } = req.body as { pattern?: string; path?: string; file_glob?: string };
  if (!pattern) { res.status(400).json({ error: "pattern is required" }); return; }
  const searchRoot = rawPath
    ? (() => {
        const n = (rawPath as string).replace(/^\/+/, "");
        const fp = path.resolve(REPLIT_FILE_WORKSPACE_ROOT, n);
        return fp.startsWith(REPLIT_FILE_WORKSPACE_ROOT) ? fp : REPLIT_FILE_WORKSPACE_ROOT;
      })()
    : REPLIT_FILE_WORKSPACE_ROOT;
  try {
    const globArg = file_glob ? `--include="${file_glob}"` : "";
    const cmd = `grep -rn -E ${JSON.stringify(pattern)} ${globArg} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist . 2>/dev/null | wc -l`;
    const count = Number(execSync(cmd, { cwd: searchRoot, stdio: "pipe", timeout: 10_000, encoding: "utf8" }).trim());
    res.json({ ok: true, count });
  } catch {
    res.json({ ok: true, count: 0 });
  }
});

// ── File proxy: BATCH-EDIT (targeted string replacements) ─────────────────────
// Called by batch_edit_project_files, multi_edit_file, replace_all_in_file.
// Body: { edits: [{ path, old_string, new_string, replace_all? }] }
// Each edit: read file → replace old_string with new_string → write back.
// Fails fast on the first edit that can't find old_string (unless replace_all).
router.post("/zombrains/files/batch-edit", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { edits } = req.body as { edits?: { path: string; old_string: string; new_string: string; replace_all?: boolean }[] };
  if (!Array.isArray(edits) || edits.length === 0) { res.status(400).json({ error: "edits array required" }); return; }
  if (edits.length > 30) { res.status(400).json({ error: "max 30 edits per call" }); return; }
  const results: { path: string; ok: boolean; error?: string; changed?: boolean }[] = [];
  for (const edit of edits) {
    const normalised = String(edit.path ?? "").replace(/^\/+/, "");
    const fullPath = path.resolve(REPLIT_FILE_WORKSPACE_ROOT, normalised);
    if (!fullPath.startsWith(REPLIT_FILE_WORKSPACE_ROOT + path.sep)) {
      results.push({ path: normalised, ok: false, error: "path escape not allowed" }); continue;
    }
    try {
      const original = fs.readFileSync(fullPath, "utf8");
      if (!original.includes(edit.old_string)) {
        results.push({ path: normalised, ok: false, error: "old_string not found in file" }); continue;
      }
      const updated = edit.replace_all
        ? original.split(edit.old_string).join(edit.new_string)
        : original.replace(edit.old_string, edit.new_string);
      fs.writeFileSync(fullPath, updated, "utf8");
      results.push({ path: normalised, ok: true, changed: updated !== original });
    } catch (e: any) {
      results.push({ path: normalised, ok: false, error: e.message });
    }
  }
  const allOk = results.every(r => r.ok);
  res.status(allOk ? 200 : 207).json({ ok: allOk, results });
});

// ── Shell: typecheck ──────────────────────────────────────────────────────────
// Called by run_typecheck. Runs pnpm typecheck for the workspace.
// Body: { package? } — optional package name e.g. "api-server". Defaults to full workspace.
router.post("/zombrains/shell/typecheck", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { package: pkg } = req.body as { package?: string };
  try {
    const cmd = pkg
      ? `pnpm --filter @workspace/${pkg} run typecheck 2>&1 | head -100`
      : `pnpm run typecheck 2>&1 | head -200`;
    const output = execSync(cmd, { cwd: REPLIT_FILE_WORKSPACE_ROOT, stdio: "pipe", timeout: 60_000, encoding: "utf8" });
    res.json({ ok: true, output: output.trim(), passed: !output.includes("error TS") });
  } catch (e: any) {
    const output = (e.stdout ?? "") + (e.stderr ?? "") + (e.message ?? "");
    res.json({ ok: false, output: String(output).slice(0, 5000), passed: false });
  }
});

// ── Snippets: store / retrieve / list ─────────────────────────────────────────
// Called by add_snippet, get_snippet, list_snippets.
// Snippets are code fragments stored in zombrains_settings as key=snippet_<name>.

router.get("/zombrains/snippets", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const rows = db.prepare("SELECT key, value FROM zombrains_settings WHERE key LIKE 'snippet_%' ORDER BY key").all() as { key: string; value: string }[];
    const snippets = rows.map(r => ({
      name: r.key.replace(/^snippet_/, ""),
      code: (() => { try { return JSON.parse(r.value).code ?? r.value; } catch { return r.value; } })(),
      updatedAt: (() => { try { return JSON.parse(r.value).updatedAt ?? null; } catch { return null; } })(),
    }));
    res.json({ ok: true, snippets, count: snippets.length });
  } finally { db.close(); }
});

router.get("/zombrains/snippets/:name", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const name = String(req.params["name"]).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!name) { res.status(400).json({ error: "invalid snippet name" }); return; }
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM zombrains_settings WHERE key = ?").get(`snippet_${name}`) as { value: string } | null;
    if (!row) { res.status(404).json({ error: "snippet not found" }); return; }
    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      res.json({ ok: true, name, code: parsed.code ?? row.value, updatedAt: parsed.updatedAt ?? null });
    } catch { res.json({ ok: true, name, code: row.value, updatedAt: null }); }
  } finally { db.close(); }
});

router.post("/zombrains/snippets", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { name, code } = req.body as { name?: string; code?: string };
  if (!name || typeof code !== "string") { res.status(400).json({ error: "name and code required" }); return; }
  const safeName = String(name).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!safeName) { res.status(400).json({ error: "invalid snippet name" }); return; }
  const db = getDb();
  try {
    const value = JSON.stringify({ code, updatedAt: new Date().toISOString() });
    db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES (?, ?)").run(`snippet_${safeName}`, value);
    res.json({ ok: true, name: safeName });
  } finally { db.close(); }
});

router.delete("/zombrains/snippets/:name", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const name = String(req.params["name"]).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!name) { res.status(400).json({ error: "invalid snippet name" }); return; }
  const db = getDb();
  try {
    const info = db.prepare("DELETE FROM zombrains_settings WHERE key = ?").run(`snippet_${name}`);
    res.json({ ok: true, deleted: info.changes > 0 });
  } finally { db.close(); }
});

// ── Internet search (Tavily) ──────────────────────────────────────────────────
// Called by web_search (Tw_ws). Body: { query, max_results? }
router.post("/zombrains/internet/search", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { query, max_results = 5 } = req.body as { query?: string; max_results?: number };
  if (!query?.trim()) { res.status(400).json({ error: "query is required" }); return; }
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) { res.status(503).json({ error: "TAVILY_API_KEY not configured" }); return; }
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query: query.trim(), max_results: Math.min(Number(max_results), 10), search_depth: "basic" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) { res.status(502).json({ error: `Tavily HTTP ${resp.status}` }); return; }
    const data = await resp.json() as { results?: { title: string; url: string; content: string }[]; answer?: string };
    res.json({ ok: true, query, results: data.results ?? [], answer: data.answer ?? null });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// ── Railway logs proxy ────────────────────────────────────────────────────────
// Called by get_railway_logs (Tr_gl). Body: { limit?, filter?, previous? }
// Proxies to Railway's /logs endpoint and returns structured results.
router.post("/zombrains/railway/logs", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { limit = 80, filter, previous = false } = req.body as { limit?: number; filter?: string; previous?: boolean };
  const RAILWAY_URL = "https://builder-agent-production.up.railway.app";
  const secret = process.env.ADMIN_SECRET ?? "";
  try {
    const url = `${RAILWAY_URL}/logs?limit=${Math.min(Number(limit), 200)}${previous ? "&previous=true" : ""}`;
    const r = await fetch(url, {
      headers: { "x-admin-secret": secret },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) { res.status(502).json({ ok: false, error: `Railway HTTP ${r.status}` }); return; }
    const data = await r.json() as { logs?: string[] | { msg: string; ts: string }[]; lines?: string[] };
    let lines: string[] = [];
    if (Array.isArray(data.logs)) {
      lines = (data.logs as unknown[]).map(l => typeof l === "string" ? l : JSON.stringify(l));
    } else if (Array.isArray(data.lines)) {
      lines = data.lines;
    }
    if (filter) {
      const re = new RegExp(filter, "i");
      lines = lines.filter(l => re.test(l));
    }
    res.json({ ok: true, lines, count: lines.length });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: e.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PART 1 — Error visibility
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/zombrains/logs/recent ────────────────────────────────────────────
// Returns the latest rows from the Postgres error_log ring buffer.
// Auth: x-zombrains-secret OR x-admin-secret.
// Query params:
//   limit — max rows to return (default 20, max 100)
//   since — ISO timestamp; only rows newer than this (optional)
//
// Safety: reads from Postgres (durable), not from in-memory state.
// ZomBrains' DIAGNOSTICIAN generator calls this to find actionable errors.
// The `pp logs` Discord command also calls this for the owner.
router.get("/zombrains/logs/recent", async (req: Request, res: Response) => {
  if (!strictAuthCheck(req, res)) return;
  const limitRaw = Number(req.query["limit"] ?? 20);
  const limit    = Math.min(isNaN(limitRaw) ? 20 : limitRaw, 100);
  const since    = req.query["since"] as string | undefined;

  try {
    let rows;
    if (since) {
      const sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) {
        res.status(400).json({ ok: false, error: "Invalid 'since' timestamp" });
        return;
      }
      rows = await db
        .select({
          id:          errorLogTable.id,
          timestamp:   errorLogTable.timestamp,
          route:       errorLogTable.route,
          method:      errorLogTable.method,
          message:     errorLogTable.message,
          stack:       errorLogTable.stack,
          status_code: errorLogTable.status_code,
          source:      errorLogTable.source,
        })
        .from(errorLogTable)
        .where(gt(errorLogTable.timestamp, sinceDate))
        .orderBy(desc(errorLogTable.timestamp))
        .limit(limit);
    } else {
      rows = await db
        .select({
          id:          errorLogTable.id,
          timestamp:   errorLogTable.timestamp,
          route:       errorLogTable.route,
          method:      errorLogTable.method,
          message:     errorLogTable.message,
          stack:       errorLogTable.stack,
          status_code: errorLogTable.status_code,
          source:      errorLogTable.source,
        })
        .from(errorLogTable)
        .orderBy(desc(errorLogTable.timestamp))
        .limit(limit);
    }

    // Truncate stack traces for the wire — full stacks live in Postgres.
    // ZomBrains gets enough context (500 chars) to identify the problem;
    // the owner can query Postgres directly for the full stack if needed.
    const trimmed = rows.map(r => ({
      ...r,
      stack: r.stack ? r.stack.slice(0, 500) : null,
    }));

    res.json({ ok: true, count: trimmed.length, errors: trimmed });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 2 — Test harness (async smoke-test for ZomBrains & owner)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Rate-limit tracker for autonomous test calls ──────────────────────────────
// Soft limit: ZomBrains may only trigger test runs autonomously once per 30 min.
// Owner-initiated calls (x-admin-secret header, no x-source: zombrains-autonomous)
// have no rate limit. Resets on restart — acceptable for a cost-control soft gate.
let _lastAutonomousTestAt = 0;
const AUTONOMOUS_TEST_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// ── Simplified persona detection stub (enhanced by #356 when deployed) ────────
// Keyword-based classification: identifies the most likely ZomBrains persona
// so the test harness can confirm persona routing before #356 is deployed.
function detectPersonaStub(prompt: string): string {
  const p = prompt.toLowerCase();
  if (/error|bug|crash|fail|broken|fix|diagnostic|self.*check/.test(p))           return "DIAGNOSTICIAN";
  if (/api.*server|route|endpoint|monitor|maintain|repair/.test(p))                return "MAINTAINER";
  if (/code|implement.*function|write.*function|coding|parse.*json|algorithm/.test(p)) return "CODER";
  if (/build|implement|create|write.*code|add.*feature|refactor/.test(p))         return "BUILDER";
  if (/review|audit|check.*code|security|quality/.test(p))                        return "REVIEWER";
  return "DEFAULT";
}

// ── POST /api/zombrains/test/run ──────────────────────────────────────────────
// Creates a test_runs row (status=pending), returns { jobId } immediately.
// Async runner: detects persona, builds a system prompt preview, makes one
// real LLM call (no file writes), writes results back. Poll with GET /:jobId.
//
// Auth: x-zombrains-secret OR x-admin-secret.
// Body: { prompt: string, maxSteps?: number (default 3, max 6) }
// Source override: set x-source: zombrains-autonomous to apply the 30-min rate gate.
router.post("/zombrains/test/run", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { prompt, maxSteps } = req.body as { prompt?: string; maxSteps?: number };
  if (!prompt || typeof prompt !== "string" || prompt.trim().length < 5) {
    res.status(400).json({ ok: false, error: "prompt is required (min 5 chars)" });
    return;
  }

  // Rate gate for autonomous ZomBrains calls
  const source = (req.headers["x-source"] as string | undefined) ?? "owner";
  if (source === "zombrains-autonomous") {
    const elapsed = Date.now() - _lastAutonomousTestAt;
    if (elapsed < AUTONOMOUS_TEST_COOLDOWN_MS) {
      const retryAfter = Math.ceil((AUTONOMOUS_TEST_COOLDOWN_MS - elapsed) / 1000);
      res.status(429).json({
        ok: false,
        error: "Autonomous test cooldown active",
        retry_after_seconds: retryAfter,
      });
      return;
    }
    _lastAutonomousTestAt = Date.now();
  }

  const stepBudget = Math.min(Math.max(Number(maxSteps ?? 3), 1), 6);

  try {
    // Create the job row immediately so we can return the jobId without blocking
    const [row] = await db.insert(testRunsTable).values({
      prompt: prompt.trim(),
      status: "pending",
    }).returning({ id: testRunsTable.id });

    if (!row) {
      res.status(500).json({ ok: false, error: "Failed to create test run row" });
      return;
    }

    const jobId = row.id;
    res.json({ ok: true, jobId });

    // ── Async execution — runs after response is sent ─────────────────────────
    // Errors here are swallowed at the Promise boundary; they write to the DB row.
    void (async () => {
      try {
        // Mark running
        await db.update(testRunsTable)
          .set({ status: "running" })
          .where(eq(testRunsTable.id, jobId));

        // Persona detection (stub until #356 deploys detectPersona())
        const personaDetected = detectPersonaStub(prompt);

        // System prompt preview — a minimal version for smoke-testing
        const systemPromptPreview = [
          `## IDENTITY\nYou are ZomBrains, an autonomous AI coding agent.`,
          `## PERSONA: ${personaDetected}`,
          `## TASK (${stepBudget}-step budget)\n${prompt.slice(0, 400)}`,
          `\n(This is a smoke-test call. Do not write files. Describe what you would do.)`
        ].join("\n\n");

        // Tool filtering — keywords → predicted tool set
        // Full filtering from toolFilter.js runs in ZomBrains' Railway process;
        // here we use keyword-based heuristics for the smoke test report.
        const toolsFilteredGuess: string[] = [];
        const pl = prompt.toLowerCase();
        if (/error|journal|log/.test(pl))          toolsFilteredGuess.push("read_file", "journal_entry");
        if (/write|fix|edit|implement/.test(pl))   toolsFilteredGuess.push("write_file", "edit_file", "validate_js_syntax");
        if (/search|find|grep/.test(pl))           toolsFilteredGuess.push("grep", "glob");
        if (/web|search.*internet|browse/.test(pl)) toolsFilteredGuess.push("web_search");
        if (/remember|library|knowledge/.test(pl))  toolsFilteredGuess.push("remember", "recall");
        if (toolsFilteredGuess.length === 0)        toolsFilteredGuess.push("read_file", "write_file");

        // One real LLM call — captures what ZomBrains would say given this prompt.
        // maxSteps is communicated as context, not enforced (smoke test, not full agent).
        const messages: Msg[] = [
          { role: "system", content: systemPromptPreview },
          { role: "user",   content: `${prompt}\n\n(Smoke test — describe your plan in max ${stepBudget} steps. Do NOT call write_file. End with: SMOKE TEST COMPLETE)` },
        ];
        const llmResult = await callProvider(messages, undefined, { source: "api-server" });

        // Reviewer trigger heuristic: would the Reviewer have flagged this output?
        // Full logic added by #356; for now: flag if output is very short or empty.
        const reviewerWouldTrigger = !llmResult.result || llmResult.result.length < 20;

        // Write results
        await db.update(testRunsTable).set({
          status:                "complete",
          persona_detected:      personaDetected,
          system_prompt_preview: systemPromptPreview.slice(0, 800),
          tools_filtered:        toolsFilteredGuess,
          llm_output:            llmResult.result.slice(0, 1000),
          reviewer_would_trigger: reviewerWouldTrigger,
          completed_at:          new Date(),
        }).where(eq(testRunsTable.id, jobId));

      } catch (runErr: unknown) {
        const msg = runErr instanceof Error ? runErr.message : String(runErr);
        await db.update(testRunsTable).set({
          status:       "failed",
          error:        msg.slice(0, 1000),
          completed_at: new Date(),
        }).where(eq(testRunsTable.id, jobId)).catch(() => {});
      }
    })();

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ── GET /api/zombrains/test/run/:jobId ────────────────────────────────────────
// Poll for test run results. Returns the full test_runs row.
// If status is pending/running: client should poll again after 5s.
// If status is complete: includes persona, system prompt preview, tools, llm output.
// Auth: x-zombrains-secret OR x-admin-secret.
router.get("/zombrains/test/run/:jobId", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { jobId } = req.params;
  if (!jobId || typeof jobId !== "string") {
    res.status(400).json({ ok: false, error: "jobId required" });
    return;
  }

  try {
    const [row] = await db
      .select()
      .from(testRunsTable)
      .where(eq(testRunsTable.id, jobId))
      .limit(1);

    if (!row) {
      res.status(404).json({ ok: false, error: "Test run not found" });
      return;
    }

    const payload: Record<string, unknown> = {
      ok:         true,
      jobId:      row.id,
      status:     row.status,
      created_at: row.created_at,
    };

    if (row.status === "pending" || row.status === "running") {
      payload.hint = "Poll again in 5s";
    } else if (row.status === "complete") {
      payload.persona_detected       = row.persona_detected;
      payload.system_prompt_preview  = row.system_prompt_preview;
      payload.tools_filtered_count   = Array.isArray(row.tools_filtered) ? row.tools_filtered.length : 0;
      payload.tools_filtered         = row.tools_filtered;
      payload.llm_output             = row.llm_output;
      payload.reviewer_would_trigger = row.reviewer_would_trigger;
      payload.completed_at           = row.completed_at;
    } else if (row.status === "failed") {
      payload.error        = row.error;
      payload.completed_at = row.completed_at;
    }

    res.json(payload);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 3 — Worker bot API routes
// ═══════════════════════════════════════════════════════════════════════════════



export default router;
