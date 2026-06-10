import { Router, type IRouter, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import Database from "better-sqlite3";

const router: IRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..");
const DB_PATH = path.resolve(__dirname, "..", "..", "..", "poop_tracker.db");

function getFilesToken(): string | null {
  // Prefer dedicated FILES_TOKEN, fall back to admin secret from DB or env
  if (process.env["FILES_TOKEN"]) return process.env["FILES_TOKEN"];
  try {
    const db = new Database(DB_PATH);
    const row = db.prepare("SELECT value FROM bot_settings WHERE key='admin_secret'").get() as { value: string } | undefined;
    db.close();
    if (row?.value) return row.value;
  } catch { /* fall through */ }
  return process.env["ADMIN_SECRET"] ?? null;
}

function authCheck(req: Request, res: Response): boolean {
  const primary = getFilesToken();
  const fallback = process.env["ADMIN_SECRET"] ?? null;
  if (!primary && !fallback) {
    res.status(500).json({ error: "FILES_TOKEN not configured — set it in Replit secrets" });
    return false;
  }
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7)
    : (req.headers["x-zombrains-secret"] as string ?? (req.query.secret as string ?? ""));
  // Accept either FILES_TOKEN or ADMIN_SECRET so Railway clients work without a separate FILES_TOKEN
  if (token !== primary && token !== fallback) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function safePath(requestedPath: string): string | null {
  const resolved = path.resolve(WORKSPACE_ROOT, requestedPath);
  if (!resolved.startsWith(WORKSPACE_ROOT)) return null;
  return resolved;
}

// Files ZomBrains may NEVER overwrite regardless of any other rule.
const WRITE_BLOCKED_PATHS = [
  "poop_tracker.db",
  ".env",
  "artifacts/api-server/src/routes/files.ts",
  "artifacts/api-server/src/routes/zombrains.ts",
].map(p => path.resolve(WORKSPACE_ROOT, p));

function isWriteAllowed(resolvedPath: string): boolean {
  // Block sensitive files outright
  if (WRITE_BLOCKED_PATHS.includes(resolvedPath)) return false;
  // Block writes to node_modules, .git, dist, and build artefacts
  const rel = path.relative(WORKSPACE_ROOT, resolvedPath);
  if (rel.startsWith("node_modules") || rel.startsWith(".git") || rel.startsWith("artifacts/") || rel.startsWith(".local/")) return false;
  // Everything else in the workspace is writable
  return resolvedPath.startsWith(WORKSPACE_ROOT);
}

router.get("/files", (req, res) => {
  if (!authCheck(req, res)) return;

  const requestedPath = (req.query.path as string) ?? ".";
  const full = safePath(requestedPath);
  if (!full) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }

  if (!fs.existsSync(full)) {
    res.status(404).json({ error: "Not found", path: requestedPath });
    return;
  }

  const stat = fs.statSync(full);

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(full).map((name) => {
      const entryPath = path.join(full, name);
      let isDir = false;
      try { isDir = fs.statSync(entryPath).isDirectory(); } catch (_) {}
      return { name, type: isDir ? "dir" : "file" };
    });
    res.json({ type: "dir", path: requestedPath, entries });
    return;
  }

  const content = fs.readFileSync(full, "utf8");
  const MAX = 200 * 1024;
  if (content.length > MAX) {
    const offset = parseInt((req.query.offset as string) ?? "0", 10);
    const limit = parseInt((req.query.limit as string) ?? "500", 10);
    const lines = content.split("\n");
    const slice = lines.slice(offset, offset + limit).join("\n");
    res.json({
      type: "file",
      path: requestedPath,
      totalLines: lines.length,
      offset,
      limit,
      truncated: true,
      content: slice,
    });
    return;
  }

  res.json({ type: "file", path: requestedPath, content });
});

router.put("/files", (req, res) => {
  if (!authCheck(req, res)) return;

  const requestedPath = req.body?.path as string | undefined;
  const content = req.body?.content as string | undefined;

  if (!requestedPath || content === undefined) {
    res.status(400).json({ error: "path and content are required" });
    return;
  }

  const full = safePath(requestedPath);
  if (!full) {
    res.status(400).json({ error: "Invalid path — must stay within workspace root" });
    return;
  }

  if (!isWriteAllowed(full)) {
    res.status(403).json({
      error: `Write not permitted outside builder-agent/. Got: ${requestedPath}. Use builder-agent/playground/ for experiments.`,
    });
    return;
  }

  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    res.json({ ok: true, path: requestedPath, bytes: Buffer.byteLength(content, "utf8") });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

router.get("/files/search", (req, res) => {
  if (!authCheck(req, res)) return;

  const pattern = (req.query.pattern as string) ?? "";
  const searchPath = (req.query.path as string) ?? ".";
  const full = safePath(searchPath);
  if (!full || !pattern) {
    res.status(400).json({ error: "pattern and path are required" });
    return;
  }

  const results: { file: string; line: number; text: string }[] = [];
  const MAX_RESULTS = 50;

  function walk(dir: string) {
    if (results.length >= MAX_RESULTS) return;
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch (_) { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git" || e === "dist") continue;
      const full2 = path.join(dir, e);
      let isDir = false;
      try { isDir = fs.statSync(full2).isDirectory(); } catch (_) { continue; }
      if (isDir) { walk(full2); continue; }
      try {
        const lines = fs.readFileSync(full2, "utf8").split("\n");
        lines.forEach((text, i) => {
          if (results.length < MAX_RESULTS && text.includes(pattern)) {
            results.push({ file: path.relative(WORKSPACE_ROOT, full2), line: i + 1, text: text.trim() });
          }
        });
      } catch (_) {}
    }
  }

  walk(full);
  res.json({ pattern, results });
});

// ── Lint: syntax-check a JS file with node --check ────────────────────────────
router.post("/files/lint", (req, res) => {
  if (!authCheck(req, res)) return;

  const requestedPath = req.body?.path as string | undefined;
  if (!requestedPath) { res.status(400).json({ error: "path is required" }); return; }

  const full = safePath(requestedPath);
  if (!full) { res.status(400).json({ error: "Invalid path" }); return; }
  if (!fs.existsSync(full)) { res.status(404).json({ error: "File not found", path: requestedPath }); return; }

  const ext = path.extname(requestedPath).toLowerCase();
  if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs") {
    res.json({ ok: true, path: requestedPath, skipped: true, reason: "not a JS file" });
    return;
  }

  try {
    execSync(`node --check ${JSON.stringify(full)}`, { stdio: "pipe" });
    res.json({ ok: true, path: requestedPath, valid: true });
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
    const output = (err.stderr?.toString() ?? err.stdout?.toString() ?? err.message ?? "unknown error")
      .replace(full, requestedPath); // strip absolute path from error
    res.json({ ok: false, path: requestedPath, valid: false, error: output.trim() });
  }
});

// ── Validate bot: lint all top-level JS files + index.js ─────────────────────
router.post("/files/validate-bot", (req, res) => {
  if (!authCheck(req, res)) return;

  const extraPaths = (req.body?.paths as string[] | undefined) ?? [];
  const corePaths = ["index.js", "birthday-bot/index.js"];
  const allPaths = [...new Set([...corePaths, ...extraPaths])];

  const results: { path: string; valid: boolean; error?: string; skipped?: boolean }[] = [];

  for (const rp of allPaths) {
    const full = safePath(rp);
    if (!full || !fs.existsSync(full)) { results.push({ path: rp, valid: false, error: "File not found" }); continue; }
    const ext = path.extname(rp).toLowerCase();
    if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs") { results.push({ path: rp, valid: true, skipped: true }); continue; }
    try {
      execSync(`node --check ${JSON.stringify(full)}`, { stdio: "pipe" });
      results.push({ path: rp, valid: true });
    } catch (e: unknown) {
      const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
      const output = (err.stderr?.toString() ?? err.stdout?.toString() ?? err.message ?? "unknown error")
        .replace(full, rp);
      results.push({ path: rp, valid: false, error: output.trim() });
    }
  }

  const allValid = results.every(r => r.valid);
  res.json({ allValid, results });
});

export default router;
