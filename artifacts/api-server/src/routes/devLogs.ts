import { Router, type IRouter, type Request, type Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const router: IRouter = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "..", "..", "poop_tracker.db");

function getDb() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_logs (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      source  TEXT NOT NULL,
      level   TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      data    TEXT,
      ts      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dev_logs_ts     ON dev_logs (ts);
    CREATE INDEX IF NOT EXISTS idx_dev_logs_source ON dev_logs (source);
    CREATE INDEX IF NOT EXISTS idx_dev_logs_level  ON dev_logs (level);
  `);
  return db;
}

// Internal write helper — used by the api-server itself to avoid HTTP roundtrip
export function shipLogDirect(
  source: string,
  level: "info" | "warn" | "error",
  message: string,
  data?: unknown,
): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO dev_logs (source, level, message, data) VALUES (?, ?, ?, ?)",
    ).run(source, level, message, data != null ? JSON.stringify(data) : null);
    db.close();
  } catch {
    // Never let logging crash the server
  }
}

// ── POST /api/internal/logs ────────────────────────────────────────────────────
// Open for writes — all internal services (bots, Vite) post here.
// No auth on write; it's internal-only and behind the Replit proxy.
router.post("/internal/logs", (req: Request, res: Response) => {
  const { source, level = "info", message, data } = req.body as {
    source?: string;
    level?: string;
    message?: string;
    data?: unknown;
  };
  if (!source || !message) {
    res.status(400).json({ error: "source and message are required" });
    return;
  }
  shipLogDirect(
    String(source),
    (["info", "warn", "error"].includes(level ?? "") ? level : "info") as "info" | "warn" | "error",
    String(message),
    data,
  );
  res.json({ ok: true });
});

// ── GET /api/internal/logs ─────────────────────────────────────────────────────
// Admin-gated. Query params: source, level, limit (default 200), since (ISO ts).
router.get("/internal/logs", (req: Request, res: Response) => {
  const secret = (req.headers["x-admin-secret"] as string) ?? (req.query["secret"] as string);
  if (secret !== process.env["ADMIN_SECRET"]) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { source, level, limit = "200", since } = req.query as Record<string, string>;
  const db = getDb();
  let sql = "SELECT id, source, level, message, data, ts FROM dev_logs WHERE 1=1";
  const params: (string | number)[] = [];
  if (source) { sql += " AND source = ?"; params.push(source); }
  if (level)  { sql += " AND level = ?";  params.push(level); }
  if (since)  { sql += " AND ts >= ?";    params.push(since); }
  sql += " ORDER BY ts DESC LIMIT ?";
  params.push(Math.min(parseInt(limit) || 200, 1000));
  const rows = db.prepare(sql).all(...params);
  db.close();
  res.json(rows);
});

// ── DELETE /api/internal/logs ──────────────────────────────────────────────────
// Prune entries older than 7 days.
router.delete("/internal/logs", (req: Request, res: Response) => {
  const secret = req.headers["x-admin-secret"] as string;
  if (secret !== process.env["ADMIN_SECRET"]) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const db = getDb();
  const { changes } = db
    .prepare("DELETE FROM dev_logs WHERE ts < datetime('now', '-7 days')")
    .run();
  db.close();
  res.json({ ok: true, deleted: changes });
});

export default router;
