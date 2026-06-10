import { Router } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "..", "..", "poop_tracker.db");

function openDb() {
  return new Database(DB_PATH);
}

type TokenRow = { user_id: string; guild_id: string; username: string };
type ProfileRow = { profile_text: string; interaction_count: number };
type MemoryRow = { id: number; memory_text: string; created_at: number };

function validateToken(db: InstanceType<typeof Database>, token: string): TokenRow | null {
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare(
    `SELECT user_id, guild_id, username FROM ai_user_tokens WHERE token=? AND expires_at > ?`
  ).get(token, now) as TokenRow | undefined;
  return row ?? null;
}

const router = Router();

router.get("/user/me", (req, res) => {
  const { token } = req.query as { token?: string };
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const db = openDb();
  try {
    const tok = validateToken(db, token);
    if (!tok) {
      res.status(401).json({ error: "Link expired or invalid — run pp ai me in Discord to get a fresh one." });
      return;
    }
    const { user_id, guild_id, username } = tok;
    const profile = db.prepare(
      `SELECT profile_text, interaction_count FROM ai_user_profiles WHERE guild_id=? AND user_id=?`
    ).get(guild_id, user_id) as ProfileRow | undefined;
    const memories = db.prepare(
      `SELECT id, memory_text, created_at FROM ai_user_memories WHERE guild_id=? AND user_id=? ORDER BY created_at DESC`
    ).all(guild_id, user_id) as MemoryRow[];
    const opted = !!(db.prepare(
      `SELECT 1 FROM user_prefs WHERE guild_id=? AND user_id=? AND pref='no_ai'`
    ).get(guild_id, user_id));
    res.json({ username, profile: profile ?? null, memories, opted });
  } finally { db.close(); }
});

router.delete("/user/memories/:id", (req, res) => {
  const { token } = req.query as { token?: string };
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const db = openDb();
  try {
    const tok = validateToken(db, token);
    if (!tok) { res.status(401).json({ error: "Invalid or expired token" }); return; }
    const mem = db.prepare(
      `SELECT user_id FROM ai_user_memories WHERE id=?`
    ).get(Number(req.params.id)) as { user_id: string } | undefined;
    if (!mem || mem.user_id !== tok.user_id) { res.status(403).json({ error: "Forbidden" }); return; }
    db.prepare(`DELETE FROM ai_user_memories WHERE id=?`).run(Number(req.params.id));
    res.json({ ok: true });
  } finally { db.close(); }
});

router.patch("/user/memories/:id", (req, res) => {
  const { token } = req.query as { token?: string };
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.status(400).json({ error: "text required" }); return; }
  const db = openDb();
  try {
    const tok = validateToken(db, token);
    if (!tok) { res.status(401).json({ error: "Invalid or expired token" }); return; }
    const mem = db.prepare(
      `SELECT user_id FROM ai_user_memories WHERE id=?`
    ).get(Number(req.params.id)) as { user_id: string } | undefined;
    if (!mem || mem.user_id !== tok.user_id) { res.status(403).json({ error: "Forbidden" }); return; }
    db.prepare(`UPDATE ai_user_memories SET memory_text=? WHERE id=?`).run(
      text.trim().slice(0, 200),
      Number(req.params.id)
    );
    res.json({ ok: true });
  } finally { db.close(); }
});

export default router;
