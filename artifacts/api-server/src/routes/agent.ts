import { Router, type Request, type Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { runAgentTask, getTaskLog } from "../lib/miniAgent.js";
import { PROVIDER_KEYS } from "../lib/providers.js";

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "..", "..", "poop_tracker.db");

function getAdminSecret(): string | null {
  try {
    const db = new Database(DB_PATH);
    const row = db.prepare("SELECT value FROM bot_settings WHERE key='admin_secret'").get() as { value: string } | undefined;
    db.close();
    if (row?.value) return row.value;
  } catch { /* fall through */ }
  return process.env["ADMIN_SECRET"] ?? null;
}

function authCheck(req: Request, res: Response): boolean {
  const secret = getAdminSecret();
  if (!secret) return true;
  const token =
    req.headers["x-admin-secret"] ??
    req.headers["x-zombrains-secret"] ??
    req.headers["authorization"]?.replace("Bearer ", "");
  if (token !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

router.post("/agent/task", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { prompt, context } = req.body as { prompt?: string; context?: string };
  if (!prompt?.trim()) { res.status(400).json({ error: "prompt is required" }); return; }
  try {
    const result = await runAgentTask(prompt.trim(), context?.trim());
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(503).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.get("/agent/status", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const activeProviders = PROVIDER_KEYS.filter(([, keys]) => keys.some(k => process.env[k])).map(([name]) => name);
  res.json({ ok: true, activeProviders, log: getTaskLog() });
});

export default router;
