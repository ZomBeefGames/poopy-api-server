import { Router } from "express";
import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "..", "..", "poop_tracker.db");

function openDb() {
  const db = new Database(DB_PATH);
  db.prepare(`CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run();
  return db;
}

const router = Router();

// ── Shared Allied Bot Registry (must stay in sync with index.js) ──────────────
const ALLIED_BOT_REGISTRY: Record<string, { name: string; slug: string }> = {
  '974297735559806986': { name: 'GenAi', slug: 'genai_frienemy' },
};
// Birthday Bot — hardcoded ally; seeded from env (same pattern as index.js)
if (process.env['BIRTHDAY_BOT_CLIENT_ID']) {
  ALLIED_BOT_REGISTRY[process.env['BIRTHDAY_BOT_CLIENT_ID']] = { name: 'Birthday Calendar', slug: 'calendar_ally' };
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function getAdminSecret(): string | null {
  try {
    const db = openDb();
    const row = db.prepare("SELECT value FROM bot_settings WHERE key='admin_secret'").get() as { value: string } | undefined;
    db.close();
    if (row?.value) return row.value;
  } catch { /* fall through */ }
  return process.env["ADMIN_SECRET"] ?? null;
}

// ── Guild owner link tokens ───────────────────────────────────────────────────
// Signed by ADMIN_SECRET. Format: base64url(payload) + '.' + hmac-sha256-hex
export function generateGuildToken(guildId: string, userId: string, role: string): string | null {
  const secret = getAdminSecret();
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({ guildId, userId, role, exp: Date.now() + 3_600_000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function validateGuildToken(token: string, secret: string): { guildId: string; userId: string; role: string } | null {
  try {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    if (expected !== sig) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return { guildId: data.guildId, userId: data.userId, role: data.role };
  } catch { return null; }
}

// ── 2FA challenge store (SQLite-backed, survives restarts) ───────────────────
const POOP_GOD_USER_ID = "1091911666725306458";
const DISCORD_API      = "https://discord.com/api/v10";

interface Challenge { code: string; expiresAt: number }

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function saveChallenge(c: Challenge) {
  const db = openDb();
  db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('admin_challenge', ?)").run(JSON.stringify(c));
  db.close();
}

function loadChallenge(): Challenge | null {
  try {
    const db = openDb();
    const row = db.prepare("SELECT value FROM bot_settings WHERE key='admin_challenge'").get() as { value: string } | undefined;
    db.close();
    if (!row?.value) return null;
    const c = JSON.parse(row.value) as Challenge;
    if (c.expiresAt < Date.now()) { deleteChallenge(); return null; }
    return c;
  } catch { return null; }
}

function deleteChallenge() {
  try {
    const db = openDb();
    db.prepare("DELETE FROM bot_settings WHERE key='admin_challenge'").run();
    db.close();
  } catch { /* ignore */ }
}

async function sendOwnerDM(code: string): Promise<void> {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) throw new Error("DISCORD_TOKEN not set");

  // Open a DM channel with the owner
  const dmRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: POOP_GOD_USER_ID }),
  });
  if (!dmRes.ok) throw new Error(`DM channel create failed: ${dmRes.status}`);
  const dm = await dmRes.json() as { id: string };

  // Build a simple styled embed — no external image service needed
  const msgRes = await fetch(`${DISCORD_API}/channels/${dm.id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: "🔐 Admin Login Verification",
        description: `Your one-time code is:\n\n# \`${code}\`\n\nExpires in **5 minutes**. Enter this in the admin panel to complete login.`,
        color: 0xc0392b,
        footer: { text: "If you didn't request this, ignore it — the code expires automatically." },
        timestamp: new Date().toISOString(),
      }],
    }),
  });
  if (!msgRes.ok) throw new Error(`DM send failed: ${msgRes.status}`);
}

// Public — registered BEFORE auth middleware so it is never gated
router.get("/admin/guest-auth", (_req, res) => {
  res.json({ ok: true, mode: "guest" });
});

// Public — password-only login (no 2FA)
router.post("/admin/login", async (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password) { res.status(400).json({ error: "password required" }); return; }
  const secret = getAdminSecret();
  if (!secret || password !== secret) {
    await new Promise(r => setTimeout(r, 800));
    res.status(401).json({ error: "wrong_password" });
    return;
  }
  res.json({ ok: true });
});

// Public — validates existing admin session (used on page load)
router.get("/admin/validate-session", (req, res) => {
  const secret = getAdminSecret();
  if (!secret) { res.status(500).json({ error: "server not configured" }); return; }
  const provided = req.headers["x-admin-secret"]
    ?? req.headers["authorization"]?.toString().replace(/^Bearer\s+/i, "");
  if (provided === secret) { res.json({ ok: true, mode: "admin" }); return; }
  res.status(401).json({ error: "Unauthorized" });
});

// Public — sends 2FA challenge code to owner via Discord DM
router.post("/admin/send-challenge", async (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password) { res.status(400).json({ error: "password required" }); return; }
  const secret = getAdminSecret();
  if (!secret || password !== secret) {
    await new Promise(r => setTimeout(r, 800));
    res.status(401).json({ error: "wrong_password" });
    return;
  }
  try {
    const code = generateCode();
    saveChallenge({ code, expiresAt: Date.now() + 5 * 60 * 1000 });
    await sendOwnerDM(code);
    res.json({ ok: true, hint: "Check your Discord DMs from Poopy." });
  } catch (err) {
    res.status(500).json({ error: "Failed to send challenge", detail: String(err) });
  }
});

// Public — verifies the 6-digit 2FA code
router.post("/admin/verify-challenge", (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code) { res.status(400).json({ error: "code required" }); return; }
  const challenge = loadChallenge();
  if (!challenge) { res.status(401).json({ error: "expired" }); return; }
  if (challenge.code !== code.trim()) { res.status(401).json({ error: "wrong_code" }); return; }
  deleteChallenge();
  res.json({ ok: true });
});

// Public — validates a guild-owner link token generated by Poopy bot
router.post("/admin/validate-guild-token", (req, res) => {
  const { token } = req.body as { token?: string };
  if (!token) { res.status(400).json({ error: "missing token" }); return; }
  const secret = getAdminSecret();
  if (!secret) { res.status(500).json({ error: "server not configured" }); return; }
  const data = validateGuildToken(token, secret);
  if (!data) { res.status(401).json({ error: "invalid or expired token" }); return; }
  res.json({ ok: true, guildId: data.guildId, userId: data.userId, role: data.role });
});

router.use("/admin", (req, res, next) => {
  const secret = getAdminSecret();
  if (!secret) { next(); return; }
  const provided = req.headers["x-admin-secret"]
    ?? req.headers["authorization"]?.toString().replace(/^Bearer\s+/i, "");
  if (provided === secret) { next(); return; }
  // Guild owner token auth — scoped to guild-config routes for the token's guild only
  const guildToken = req.headers["x-guild-token"] as string | undefined;
  if (guildToken) {
    const tokenData = validateGuildToken(guildToken, secret);
    if (tokenData) {
      // Enforce: token guildId must match the :guildId in the URL (if present)
      const guildIdInPath = req.path.match(/\/([^/]+)(?:\/|$)/)?.[1];
      if (!guildIdInPath || guildIdInPath === tokenData.guildId) {
        (req as any)._guildTokenData = tokenData;
        next(); return;
      }
    }
  }
  // Guest mode: GET requests only — no writes allowed server-side
  if (req.method === "GET" && req.headers["x-guest-mode"] === "1") { next(); return; }
  res.status(401).json({ error: "Unauthorized" });
});

// ── Stats overview ────────────────────────────────────────────────────────────
router.get("/admin/stats", (_req, res) => {
  const db = openDb();
  try {
    const totalPoops   = (db.prepare("SELECT COUNT(*) as n FROM poops").get() as any).n;
    const totalUsers   = (db.prepare("SELECT COUNT(DISTINCT user_id) as n FROM user_stats").get() as any).n;
    const totalXP      = (db.prepare("SELECT COALESCE(SUM(xp),0) as n FROM user_stats").get() as any).n;
    const totalServers = (db.prepare("SELECT COUNT(DISTINCT guild_id) as n FROM user_stats").get() as any).n;
    const poops24h     = (db.prepare("SELECT COUNT(*) as n FROM poops WHERE created_at >= datetime('now','-24 hours')").get() as any).n;
    const topUser      = db.prepare("SELECT username, xp, level FROM user_stats ORDER BY xp DESC LIMIT 1").get();
    const activityTypes = db.prepare("SELECT type, COUNT(*) as n FROM activity_log GROUP BY type").all();
    res.json({ total_poops: totalPoops, total_users: totalUsers, total_xp: totalXP, total_servers: totalServers, poops_last_24h: poops24h, top_user: topUser ?? null, activity_counts: activityTypes });
  } finally { db.close(); }
});

// ── Guilds ────────────────────────────────────────────────────────────────────
router.get("/admin/guilds", (_req, res) => {
  const db = openDb();
  try {
    const guilds = db.prepare(`
      SELECT us.guild_id,
             COUNT(DISTINCT us.user_id) as user_count,
             (SELECT COUNT(*) FROM poops p WHERE p.guild_id = us.guild_id) as poop_count,
             COALESCE((SELECT SUM(xp) FROM user_stats us2 WHERE us2.guild_id = us.guild_id), 0) as total_xp
      FROM user_stats us
      GROUP BY us.guild_id
      ORDER BY poop_count DESC
    `).all();
    res.json(guilds);
  } finally { db.close(); }
});

// ── Users list ────────────────────────────────────────────────────────────────
router.get("/admin/users", (req, res) => {
  const db = openDb();
  try {
    const { guild_id, search, page = "1", limit = "50" } = req.query as Record<string, string>;
    const offset = (Number(page) - 1) * Number(limit);

    const whereClauses: string[] = ["1=1"];
    const params: unknown[] = [];
    if (guild_id) { whereClauses.push("us.guild_id = ?"); params.push(guild_id); }
    if (search)   { whereClauses.push("(us.username LIKE ? OR us.user_id = ?)"); params.push(`%${search}%`, search); }
    const where = whereClauses.join(" AND ");

    const users = db.prepare(`
      SELECT us.guild_id, us.user_id, us.username, us.xp, us.level, us.streak,
             us.last_log_date, us.race, us.gender,
             (SELECT COUNT(*) FROM poops p WHERE p.guild_id=us.guild_id AND p.user_id=us.user_id) as poop_count,
             (SELECT COUNT(*) FROM achievements a WHERE a.guild_id=us.guild_id AND a.user_id=us.user_id) as achievement_count
      FROM user_stats us
      WHERE ${where}
      ORDER BY us.xp DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), offset);

    const total = (db.prepare(`SELECT COUNT(*) as n FROM user_stats us WHERE ${where}`).get(...params) as any).n;
    res.json({ users, total, page: Number(page), limit: Number(limit) });
  } finally { db.close(); }
});

// ── User detail ───────────────────────────────────────────────────────────────
router.get("/admin/users/:guildId/:userId", (req, res) => {
  const { guildId, userId } = req.params;
  const db = openDb();
  try {
    const user = db.prepare("SELECT * FROM user_stats WHERE guild_id=? AND user_id=?").get(guildId, userId);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    const poops        = db.prepare("SELECT * FROM poops WHERE guild_id=? AND user_id=? ORDER BY created_at DESC LIMIT 25").all(guildId, userId);
    const achievements = db.prepare("SELECT * FROM achievements WHERE guild_id=? AND user_id=? ORDER BY unlocked_at DESC").all(guildId, userId);
    const items        = db.prepare("SELECT * FROM user_items WHERE guild_id=? AND user_id=?").all(guildId, userId);
    const evolutions   = db.prepare("SELECT * FROM evolutions WHERE guild_id=? AND user_id=? ORDER BY level").all(guildId, userId);
    const poopStats    = db.prepare("SELECT COUNT(*) as total, COALESCE(SUM(xp_earned),0) as xp_from_poops, COALESCE(AVG(weight_lbs),0) as avg_weight FROM poops WHERE guild_id=? AND user_id=?").get(guildId, userId);
    const prefsRows    = db.prepare("SELECT pref FROM user_prefs WHERE guild_id=? AND user_id=?").all(guildId, userId) as { pref: string }[];
    const prefs        = prefsRows.map(r => r.pref);
    res.json({ user, poops, achievements, items, evolutions, poop_stats: poopStats, prefs });
  } finally { db.close(); }
});

// ── User pref toggle ──────────────────────────────────────────────────────────
router.post("/admin/users/:guildId/:userId/pref", (req, res) => {
  const { guildId, userId } = req.params;
  const { pref } = req.body as { pref: string };
  const ALLOWED = ["divine_shield", "god_shield_off"];
  if (!pref || !ALLOWED.includes(pref)) { res.status(400).json({ error: "Invalid pref" }); return; }
  const db = openDb();
  try {
    const exists = db.prepare("SELECT 1 FROM user_prefs WHERE guild_id=? AND user_id=? AND pref=?").get(guildId, userId, pref);
    if (exists) {
      db.prepare("DELETE FROM user_prefs WHERE guild_id=? AND user_id=? AND pref=?").run(guildId, userId, pref);
    } else {
      db.prepare("INSERT OR IGNORE INTO user_prefs (guild_id, user_id, pref) VALUES (?,?,?)").run(guildId, userId, pref);
    }
    db.prepare("INSERT INTO activity_log (type, guild_id, user_id, username, data) VALUES ('admin_action',?,?,'admin',?)").run(guildId, userId, JSON.stringify({ action: "toggle_pref", pref }));
    const prefsRows = db.prepare("SELECT pref FROM user_prefs WHERE guild_id=? AND user_id=?").all(guildId, userId) as { pref: string }[];
    res.json({ ok: true, prefs: prefsRows.map(r => r.pref) });
  } finally { db.close(); }
});

// ── Edit user ─────────────────────────────────────────────────────────────────
router.patch("/admin/users/:guildId/:userId", (req, res) => {
  const { guildId, userId } = req.params;
  const { xp, level, streak } = req.body as { xp?: number; level?: number; streak?: number };
  const db = openDb();
  try {
    const user = db.prepare("SELECT * FROM user_stats WHERE guild_id=? AND user_id=?").get(guildId, userId);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    const sets: string[] = [];
    const vals: unknown[] = [];
    if (xp     !== undefined) { sets.push("xp = ?");     vals.push(Number(xp)); }
    if (level  !== undefined) { sets.push("level = ?");  vals.push(Number(level)); }
    if (streak !== undefined) { sets.push("streak = ?"); vals.push(Number(streak)); }
    if (!sets.length) { res.status(400).json({ error: "No fields to update" }); return; }

    db.prepare(`UPDATE user_stats SET ${sets.join(", ")} WHERE guild_id=? AND user_id=?`).run(...vals, guildId, userId);
    db.prepare(`INSERT INTO activity_log (type, guild_id, user_id, username, data) VALUES ('admin_action',?,?,?,?)`)
      .run(guildId, userId, "admin", JSON.stringify({ action: "edit_user", fields: req.body }));
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Cooldowns ─────────────────────────────────────────────────────────────────
router.get("/admin/cooldowns", (_req, res) => {
  const db = openDb();
  try {
    const rows = db.prepare("SELECT * FROM cooldowns ORDER BY type, last_fired DESC").all();
    res.json(rows);
  } finally { db.close(); }
});

router.delete("/admin/cooldowns/:type/:channelId", (req, res) => {
  const { type, channelId } = req.params;
  const db = openDb();
  try {
    db.prepare("DELETE FROM cooldowns WHERE type=? AND channel_id=?").run(type, channelId);
    res.json({ ok: true });
  } finally { db.close(); }
});

router.delete("/admin/cooldowns/:type", (req, res) => {
  const { type } = req.params;
  const db = openDb();
  try {
    db.prepare("DELETE FROM cooldowns WHERE type=?").run(type);
    res.json({ ok: true, message: `Cleared all ${type} cooldowns` });
  } finally { db.close(); }
});

// ── Activity log ──────────────────────────────────────────────────────────────
router.get("/admin/activity", (req, res) => {
  const db = openDb();
  try {
    const { type, guild_id, page = "1", limit = "100" } = req.query as Record<string, string>;
    const offset = (Number(page) - 1) * Number(limit);

    const whereClauses: string[] = ["1=1"];
    const params: unknown[] = [];
    if (type)     { whereClauses.push("type=?");     params.push(type); }
    if (guild_id) { whereClauses.push("guild_id=?"); params.push(guild_id); }
    const where = whereClauses.join(" AND ");

    const events = db.prepare(`SELECT * FROM activity_log WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, Number(limit), offset);
    const total  = (db.prepare(`SELECT COUNT(*) as n FROM activity_log WHERE ${where}`).get(...params) as any).n;
    res.json({ events, total, page: Number(page), limit: Number(limit) });
  } finally { db.close(); }
});

// ── Feature flags ─────────────────────────────────────────────────────────────
router.get("/admin/features", (_req, res) => {
  const db = openDb();
  try {
    const flags = db.prepare("SELECT * FROM feature_flags ORDER BY flag").all();
    res.json(flags);
  } finally { db.close(); }
});

router.patch("/admin/features/:flag", (req, res) => {
  const { flag } = req.params;
  const { enabled } = req.body as { enabled: boolean };
  const db = openDb();
  try {
    db.prepare(`INSERT OR REPLACE INTO feature_flags (flag, enabled, updated_at) VALUES (?, ?, strftime('%s','now'))`).run(flag, enabled ? 1 : 0);
    db.prepare(`INSERT INTO activity_log (type, guild_id, user_id, username, data) VALUES ('admin_action',NULL,NULL,'admin',?)`)
      .run(JSON.stringify({ action: "toggle_feature", flag, enabled }));
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Bot settings (numeric + PPS gate) ────────────────────────────────────────
const SETTINGS_SCHEMA: Record<string, {
  label: string; type: "boolean" | "number";
  description: string; min?: number; max?: number; defaultVal: string;
  table: "bot_settings" | "global_settings";
}> = {
  poo_ships_global_unlock: {
    label: "PPS Gate Open", type: "boolean",
    description: "Open Pixel Poo Ships to everyone — no Legendary Poo required",
    defaultVal: "0", table: "global_settings",
  },
  item_drop_chance: {
    label: "Item Drop Chance (%)", type: "number",
    description: "Chance of an item drop after each poop log (0–100)",
    min: 0, max: 100, defaultVal: "30", table: "bot_settings",
  },
  poop_log_cooldown_sec: {
    label: "Poop Log Cooldown (sec)", type: "number",
    description: "Seconds a player must wait between poop logs",
    min: 10, max: 3600, defaultVal: "90", table: "bot_settings",
  },
  poop_chime_cooldown_min: {
    label: "Poop Chime Cooldown (min)", type: "number",
    description: "Minutes between poop-keyword chime responses per channel",
    min: 1, max: 1440, defaultVal: "60", table: "bot_settings",
  },
  knock_cooldown_min: {
    label: "Knock-Knock Cooldown (min)", type: "number",
    description: "Minutes between auto knock-knock jokes per channel",
    min: 1, max: 1440, defaultVal: "60", table: "bot_settings",
  },
  ff_spam_threshold: {
    label: "💩 Fecal Firewall: Ping Threshold", type: "number",
    description: "Total mentions within the time window that triggers retaliation",
    min: 2, max: 50, defaultVal: "5", table: "bot_settings",
  },
  ff_time_window_sec: {
    label: "💩 Fecal Firewall: Time Window (sec)", type: "number",
    description: "Rolling time window (seconds) for counting ping spam",
    min: 1, max: 60, defaultVal: "10", table: "bot_settings",
  },
  ff_retaliation_mult: {
    label: "💩 Fecal Firewall: Retaliation Multiplier", type: "number",
    description: "Pings returned = detected pings × this multiplier",
    min: 1, max: 10, defaultVal: "2", table: "bot_settings",
  },
  roulette_cooldown_min: {
    label: "🎰 Roulette Cooldown (min)", type: "number",
    description: "Minutes a player must wait between /poop roulette spins",
    min: 1, max: 1440, defaultVal: "5", table: "bot_settings",
  },
  forecast_hour: {
    label: "🌤️ Forecast Post Hour (UTC)", type: "number",
    description: "UTC hour (0–23) when the daily Poop Forecast is posted in the server's poop channel",
    min: 0, max: 23, defaultVal: "8", table: "bot_settings",
  },
};

router.get("/admin/settings", (_req, res) => {
  const db = openDb();
  try {
    const botRows    = db.prepare("SELECT key, value FROM bot_settings").all()    as { key: string; value: string }[];
    const globalRows = db.prepare("SELECT key, value FROM global_settings").all() as { key: string; value: string }[];
    const combined: Record<string, string> = {};
    for (const r of [...botRows, ...globalRows]) combined[r.key] = r.value;
    const result = Object.entries(SETTINGS_SCHEMA).map(([key, meta]) => ({
      key, label: meta.label, type: meta.type,
      description: meta.description, min: meta.min ?? null, max: meta.max ?? null,
      value: combined[key] ?? meta.defaultVal,
    }));
    res.json(result);
  } finally { db.close(); }
});

router.patch("/admin/settings/:key", (req, res) => {
  const { key } = req.params;
  const meta = SETTINGS_SCHEMA[key];
  if (!meta) { res.status(400).json({ error: "Unknown setting key" }); return; }
  const { value } = req.body as { value: string };
  const db = openDb();
  try {
    if (meta.table === "global_settings") {
      db.prepare("UPDATE global_settings SET value=? WHERE key=?").run(String(value), key);
    } else {
      db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES (?,?)").run(key, String(value));
    }
    db.prepare("INSERT INTO activity_log (type, guild_id, user_id, username, data) VALUES ('admin_action',NULL,NULL,'admin',?)")
      .run(JSON.stringify({ action: "set_setting", key, value }));
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Guild config ───────────────────────────────────────────────────────────────
router.get("/admin/guild-config/:guildId", (req, res) => {
  const { guildId } = req.params;
  const db = openDb();
  try {
    const rows = db.prepare("SELECT key, value FROM guild_config WHERE guild_id = ?").all(guildId) as { key: string; value: string }[];
    const config: Record<string, string> = {};
    for (const r of rows) config[r.key] = r.value;
    res.json(config);
  } finally { db.close(); }
});

router.put("/admin/guild-config/:guildId", (req, res) => {
  const { guildId } = req.params;
  const updates = req.body as Record<string, string>;
  if (!updates || typeof updates !== "object") {
    res.status(400).json({ error: "Body must be a key-value object" }); return;
  }
  const db = openDb();
  try {
    const stmt = db.prepare("INSERT OR REPLACE INTO guild_config (guild_id, key, value) VALUES (?,?,?)");
    const doAll = db.transaction(() => {
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined || value === "") {
          db.prepare("DELETE FROM guild_config WHERE guild_id=? AND key=?").run(guildId, key);
        } else {
          stmt.run(guildId, key, String(value));
        }
      }
    });
    doAll();
    db.prepare("INSERT INTO activity_log (type, guild_id, user_id, username, data) VALUES ('admin_action',?,NULL,'admin',?)").run(guildId, JSON.stringify({ action: "guild_config", updates }));
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Broadcast message to a guild (via activity log marker) ────────────────────
router.get("/admin/guilds/:guildId/users", (req, res) => {
  const { guildId } = req.params;
  const db = openDb();
  try {
    const users = db.prepare(`
      SELECT user_id, username, xp, level, streak, last_log_date,
             (SELECT COUNT(*) FROM poops p WHERE p.guild_id=? AND p.user_id=us.user_id) as poop_count
      FROM user_stats us WHERE guild_id=? ORDER BY xp DESC LIMIT 100
    `).all(guildId, guildId);
    res.json(users);
  } finally { db.close(); }
});

// ── Throw leaderboard stats ───────────────────────────────────────────────────
router.get("/admin/throw-stats", (_req, res) => {
  const db = openDb();
  try {
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(throws),0)    as total_throws,
        COALESCE(SUM(hits),0)      as total_hits,
        COALESCE(SUM(glances),0)   as total_glances,
        COALESCE(SUM(misses),0)    as total_misses,
        COALESCE(SUM(backfires),0) as total_backfires
      FROM poop_throw_stats
    `).get() as { total_throws: number; total_hits: number; total_glances: number; total_misses: number; total_backfires: number };

    const topThrowers = db.prepare(`
      SELECT username, throws, hits, glances, misses, backfires
      FROM poop_throw_stats
      ORDER BY hits DESC, throws DESC
      LIMIT 10
    `).all() as { username: string; throws: number; hits: number; glances: number; misses: number; backfires: number }[];

    const mostTargeted = db.prepare(`
      SELECT username, times_hit
      FROM poop_throw_stats
      ORDER BY times_hit DESC
      LIMIT 5
    `).all() as { username: string; times_hit: number }[];

    res.json({ ...totals, top_throwers: topThrowers, most_targeted: mostTargeted });
  } catch {
    res.json({ total_throws: 0, total_hits: 0, total_glances: 0, total_misses: 0, total_backfires: 0, top_throwers: [], most_targeted: [] });
  } finally { db.close(); }
});

// ── Command channel rules ─────────────────────────────────────────────────────
router.get("/admin/command-channels/:guildId", (req, res) => {
  const { guildId } = req.params;
  const db = openDb();
  try {
    const rules = db.prepare(
      "SELECT guild_id, command, channel_id FROM command_channel_rules WHERE guild_id = ? ORDER BY command, channel_id"
    ).all(guildId);
    res.json(rules);
  } finally { db.close(); }
});

router.post("/admin/command-channels", (req, res) => {
  const { guildId, command, channelId } = req.body as { guildId: string; command: string; channelId: string };
  if (!guildId || !command || !channelId) { res.status(400).json({ error: "Missing fields" }); return; }
  const db = openDb();
  try {
    db.prepare(
      "INSERT OR IGNORE INTO command_channel_rules (guild_id, command, channel_id) VALUES (?,?,?)"
    ).run(guildId, command, channelId);
    res.json({ ok: true });
  } finally { db.close(); }
});

router.delete("/admin/command-channels/:guildId/:command/:channelId", (req, res) => {
  const { guildId, command, channelId } = req.params;
  const db = openDb();
  try {
    db.prepare(
      "DELETE FROM command_channel_rules WHERE guild_id=? AND command=? AND channel_id=?"
    ).run(guildId, command, channelId);
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── AI Brain ──────────────────────────────────────────────────────────────────

router.get("/admin/ai/overview", (_req, res) => {
  const db = openDb();
  try {
    const enabledGuilds  = (db.prepare("SELECT COUNT(*) as n FROM ai_enabled_guilds").get() as any).n;
    const totalMemories  = (db.prepare("SELECT COUNT(*) as n FROM ai_user_memories").get() as any).n;
    const totalProfiles  = (db.prepare("SELECT COUNT(*) as n FROM ai_user_profiles WHERE profile_text != ''").get() as any).n;
    const totalFacts     = (db.prepare("SELECT COUNT(*) as n FROM ai_server_facts").get() as any).n;
    const autoFacts      = (db.prepare("SELECT COUNT(*) as n FROM ai_server_facts WHERE auto_generated=1").get() as any).n;
    const passiveMessages = (db.prepare("SELECT COUNT(*) as n FROM ai_passive_log").get() as any).n;
    const bannedWords    = (db.prepare("SELECT COUNT(*) as n FROM ai_banned_words").get() as any).n;
    res.json({ enabledGuilds, totalMemories, totalProfiles, totalFacts, autoFacts, passiveMessages, bannedWords });
  } finally { db.close(); }
});

// ── Banned words ──────────────────────────────────────────────────────────────
router.get("/admin/ai/banned-words/:guildId", (req, res) => {
  const db = openDb();
  try {
    const words = db.prepare("SELECT id, word, added_by, added_at FROM ai_banned_words WHERE guild_id=? ORDER BY added_at DESC").all(req.params.guildId);
    res.json(words);
  } finally { db.close(); }
});

router.post("/admin/ai/banned-words", (req, res) => {
  const { guildId, word } = req.body as { guildId: string; word: string };
  if (!guildId || !word?.trim()) { res.status(400).json({ error: "guildId and word required" }); return; }
  const db = openDb();
  try {
    db.prepare("INSERT OR IGNORE INTO ai_banned_words (guild_id, word, added_by) VALUES (?,?,?)").run(guildId, word.trim().toLowerCase(), "admin");
    res.json({ ok: true });
  } finally { db.close(); }
});

router.delete("/admin/ai/banned-words/:wordId", (req, res) => {
  const db = openDb();
  try {
    db.prepare("DELETE FROM ai_banned_words WHERE id=?").run(req.params.wordId);
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Passive log stats ─────────────────────────────────────────────────────────
router.get("/admin/ai/passive-stats/:guildId", (req, res) => {
  const db = openDb();
  try {
    const total   = (db.prepare("SELECT COUNT(*) as n FROM ai_passive_log WHERE guild_id=?").get(req.params.guildId) as any).n;
    const users   = (db.prepare("SELECT COUNT(DISTINCT user_id) as n FROM ai_passive_log WHERE guild_id=?").get(req.params.guildId) as any).n;
    const channels = (db.prepare("SELECT COUNT(DISTINCT channel_id) as n FROM ai_passive_log WHERE guild_id=?").get(req.params.guildId) as any).n;
    const recent  = db.prepare("SELECT channel_id, COUNT(*) as n FROM ai_passive_log WHERE guild_id=? GROUP BY channel_id ORDER BY n DESC LIMIT 5").all(req.params.guildId);
    res.json({ total, users, channels, topChannels: recent });
  } finally { db.close(); }
});

router.get("/admin/ai/guilds", (_req, res) => {
  const db = openDb();
  try {
    const guilds = db.prepare(`
      SELECT us.guild_id,
             COUNT(DISTINCT us.user_id) as user_count,
             CASE WHEN eg.guild_id IS NOT NULL THEN 1 ELSE 0 END as ai_enabled,
             (SELECT COUNT(*) FROM ai_user_memories m WHERE m.guild_id = us.guild_id) as memory_count,
             (SELECT COUNT(*) FROM ai_user_profiles p WHERE p.guild_id = us.guild_id AND p.profile_text != '') as profile_count,
             (SELECT COUNT(*) FROM ai_server_facts f WHERE f.guild_id = us.guild_id) as fact_count
      FROM user_stats us
      LEFT JOIN ai_enabled_guilds eg ON eg.guild_id = us.guild_id
      GROUP BY us.guild_id
      ORDER BY ai_enabled DESC, user_count DESC
    `).all();
    res.json(guilds);
  } finally { db.close(); }
});

router.post("/admin/ai/guilds/:guildId/enable", (req, res) => {
  const db = openDb();
  try {
    db.prepare("INSERT OR IGNORE INTO ai_enabled_guilds (guild_id, enabled_by) VALUES (?, 'admin')").run(req.params.guildId);
    res.json({ ok: true });
  } finally { db.close(); }
});

router.delete("/admin/ai/guilds/:guildId/enable", (req, res) => {
  const db = openDb();
  try {
    db.prepare("DELETE FROM ai_enabled_guilds WHERE guild_id=?").run(req.params.guildId);
    res.json({ ok: true });
  } finally { db.close(); }
});

router.get("/admin/ai/facts/:guildId", (req, res) => {
  const db = openDb();
  try {
    const facts = db.prepare("SELECT id, fact, auto_generated, added_at FROM ai_server_facts WHERE guild_id=? ORDER BY added_at ASC").all(req.params.guildId);
    res.json(facts);
  } finally { db.close(); }
});

router.delete("/admin/ai/facts/:factId", (req, res) => {
  const db = openDb();
  try {
    db.prepare("DELETE FROM ai_server_facts WHERE id=?").run(req.params.factId);
    res.json({ ok: true });
  } finally { db.close(); }
});

router.get("/admin/ai/profiles/:guildId", (req, res) => {
  const db = openDb();
  try {
    const profiles = db.prepare(`
      SELECT p.user_id, p.profile_text, p.interaction_count, p.updated_at,
             COALESCE(us.username, p.user_id) as username,
             (SELECT COUNT(*) FROM ai_user_memories m WHERE m.guild_id=p.guild_id AND m.user_id=p.user_id) as memory_count
      FROM ai_user_profiles p
      LEFT JOIN user_stats us ON us.guild_id=p.guild_id AND us.user_id=p.user_id
      WHERE p.guild_id=? AND p.profile_text != ''
      ORDER BY p.interaction_count DESC
    `).all(req.params.guildId);
    res.json(profiles);
  } finally { db.close(); }
});

router.get("/admin/ai/memories/:guildId/:userId", (req, res) => {
  const db = openDb();
  try {
    const memories = db.prepare("SELECT id, memory_text, created_at FROM ai_user_memories WHERE guild_id=? AND user_id=? ORDER BY created_at ASC").all(req.params.guildId, req.params.userId);
    res.json(memories);
  } finally { db.close(); }
});

router.delete("/admin/ai/memories/:memId", (req, res) => {
  const db = openDb();
  try {
    db.prepare("DELETE FROM ai_user_memories WHERE id=?").run(req.params.memId);
    res.json({ ok: true });
  } finally { db.close(); }
});

router.delete("/admin/ai/profiles/:guildId/:userId", (req, res) => {
  const db = openDb();
  try {
    db.prepare("DELETE FROM ai_user_profiles WHERE guild_id=? AND user_id=?").run(req.params.guildId, req.params.userId);
    db.prepare("DELETE FROM ai_user_memories WHERE guild_id=? AND user_id=?").run(req.params.guildId, req.params.userId);
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── AI Channel restrictions ───────────────────────────────────────────────────

router.get("/admin/ai/channels/:guildId", (req, res) => {
  const db = openDb();
  try {
    const rows = db.prepare("SELECT channel_id FROM ai_chat_channels WHERE guild_id=? ORDER BY channel_id").all(req.params.guildId);
    res.json(rows);
  } finally { db.close(); }
});

router.post("/admin/ai/channels", (req, res) => {
  const { guildId, channelId } = req.body as { guildId: string; channelId: string };
  if (!guildId || !channelId) { res.status(400).json({ error: "guildId and channelId required" }); return; }
  const db = openDb();
  try {
    db.prepare("INSERT OR IGNORE INTO ai_chat_channels (guild_id, channel_id) VALUES (?,?)").run(guildId, channelId);
    res.json({ ok: true });
  } finally { db.close(); }
});

router.delete("/admin/ai/channels/:guildId/:channelId", (req, res) => {
  const db = openDb();
  try {
    db.prepare("DELETE FROM ai_chat_channels WHERE guild_id=? AND channel_id=?").run(req.params.guildId, req.params.channelId);
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── AI Opt-outs ────────────────────────────────────────────────────────────────

router.get("/admin/ai/optouts/:guildId", (req, res) => {
  const db = openDb();
  try {
    const rows = db.prepare(`
      SELECT up.user_id, COALESCE(us.username, up.user_id) as username
      FROM user_prefs up
      LEFT JOIN user_stats us ON us.guild_id=up.guild_id AND us.user_id=up.user_id
      WHERE up.guild_id=? AND up.pref='no_ai'
      ORDER BY up.user_id
    `).all(req.params.guildId);
    res.json(rows);
  } finally { db.close(); }
});

router.post("/admin/ai/optouts", (req, res) => {
  const { guildId, userId } = req.body as { guildId: string; userId: string };
  if (!guildId || !userId) { res.status(400).json({ error: "guildId and userId required" }); return; }
  const db = openDb();
  try {
    db.prepare("INSERT OR IGNORE INTO user_prefs (guild_id, user_id, pref) VALUES (?,?,'no_ai')").run(guildId, userId);
    res.json({ ok: true });
  } finally { db.close(); }
});

router.delete("/admin/ai/optout/:guildId/:userId", (req, res) => {
  const db = openDb();
  try {
    db.prepare("DELETE FROM user_prefs WHERE guild_id=? AND user_id=? AND pref='no_ai'").run(req.params.guildId, req.params.userId);
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── AI Feedback log ────────────────────────────────────────────────────────────

router.get("/admin/ai/feedback/:guildId", (req, res) => {
  const db = openDb();
  try {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const rows = db.prepare(`
      SELECT id, user_id, feedback_type, message_content, reason, ts
      FROM ai_feedback
      WHERE guild_id=?
      ORDER BY ts DESC
      LIMIT ?
    `).all(req.params.guildId, limit);
    res.json(rows);
  } finally { db.close(); }
});

// ── AI Relationships ───────────────────────────────────────────────────────────

router.get("/admin/ai/relationships/:guildId", (req, res) => {
  const db = openDb();
  try {
    let rows: unknown[] = [];
    try {
      rows = db.prepare("SELECT type, user_id, username, score, reason, updated_at FROM ai_relationships WHERE guild_id=? ORDER BY type").all(req.params.guildId);
    } catch { /* table may not exist yet */ }
    res.json(rows);
  } finally { db.close(); }
});

router.delete("/admin/ai/relationships/:guildId", (req, res) => {
  const db = openDb();
  try {
    try { db.prepare("DELETE FROM ai_relationships WHERE guild_id=?").run(req.params.guildId); } catch { /* silent */ }
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Poopy personality (Phase 3 + 5) ───────────────────────────────────────────
// GET returns the merged personality snapshot for a guild: current favorites
// (with icks parsed out of the JSON column), top opinions, and drift
// dimensions. All three tables are optional — any missing one returns null
// so the admin UI can show a clean "no personality yet" empty state.
// Swallow only sqlite "missing table/column" errors from cold-start guilds;
// re-throw anything else so the request fails loudly with a 500.
function isMissingTable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /no such table|no such column/i.test(msg);
}

router.get("/admin/ai/personality/:guildId", (req, res) => {
  const db = openDb();
  try {
    const guildId = req.params.guildId;
    let favorites: unknown = null;
    let opinions: unknown[] = [];
    let drift: unknown = null;
    try {
      const favRow = db.prepare(`SELECT color, food, emoji, animal, song, time_of_day, icks_json, chosen_at, last_drift_at FROM poopy_favorites WHERE guild_id=?`).get(guildId) as
        { color: string | null; food: string | null; emoji: string | null; animal: string | null; song: string | null; time_of_day: string | null; icks_json: string | null; chosen_at: number; last_drift_at: string | null } | undefined;
      if (favRow) {
        let icks: Record<string, string> = {};
        try { icks = JSON.parse(favRow.icks_json || "{}"); } catch { icks = {}; }
        let lastDrift: Record<string, number> = {};
        try { lastDrift = JSON.parse(favRow.last_drift_at || "{}"); } catch { lastDrift = {}; }
        favorites = {
          color:       favRow.color,
          food:        favRow.food,
          emoji:       favRow.emoji,
          animal:      favRow.animal,
          song:        favRow.song,
          time_of_day: favRow.time_of_day,
          icks,
          chosen_at:   favRow.chosen_at,
          last_drift_at: lastDrift,
        };
      }
    } catch (e) { if (!isMissingTable(e)) throw e; }
    try {
      opinions = db.prepare(`SELECT topic, stance, weight, last_seen FROM poopy_opinions WHERE guild_id=? ORDER BY weight DESC, last_seen DESC LIMIT 50`).all(guildId);
    } catch (e) { if (!isMissingTable(e)) throw e; }
    try {
      drift = db.prepare(`SELECT playfulness, warmth, chaos, confidence, updated_at FROM poopy_personality_drift WHERE guild_id=?`).get(guildId) || null;
    } catch (e) { if (!isMissingTable(e)) throw e; }
    // ── Mood state (real-time + daily texture) ──────────────────────────────
    let mood: { current: string; moodAt: number | null; dailyTexture: string | null; dailyDate: string | null } | null = null;
    try {
      const moodRow    = db.prepare(`SELECT value FROM guild_config WHERE guild_id=? AND key='poopy_mood'`).get(guildId) as { value: string } | undefined;
      const moodAtRow  = db.prepare(`SELECT value FROM guild_config WHERE guild_id=? AND key='poopy_mood_at'`).get(guildId) as { value: string } | undefined;
      const texRow     = db.prepare(`SELECT value FROM guild_config WHERE guild_id=? AND key='poopy_daily_mood_texture'`).get(guildId) as { value: string } | undefined;
      const texDateRow = db.prepare(`SELECT value FROM guild_config WHERE guild_id=? AND key='poopy_daily_mood_date'`).get(guildId) as { value: string } | undefined;
      mood = {
        current:      moodRow?.value ?? 'neutral',
        moodAt:       moodAtRow?.value ? parseInt(moodAtRow.value) : null,
        dailyTexture: texRow?.value ?? null,
        dailyDate:    texDateRow?.value ?? null,
      };
    } catch { /* guild_config may be empty */ }
    res.json({ favorites, opinions, drift, mood });
  } finally { db.close(); }
});

// DELETE wipes all three personality tables for the guild — same surface the
// in-Discord `pp ai reset-personality confirm` command exposes, scoped here
// to just the personality state (does not wipe memories/profiles/facts).
router.delete("/admin/ai/personality/:guildId", (req, res) => {
  const db = openDb();
  try {
    const guildId = req.params.guildId;
    const delIfExists = (sql: string): number => {
      try { return db.prepare(sql).run(guildId).changes; }
      catch (e) { if (isMissingTable(e)) return 0; throw e; }
    };
    const r = {
      favs:  delIfExists(`DELETE FROM poopy_favorites WHERE guild_id=?`),
      ops:   delIfExists(`DELETE FROM poopy_opinions WHERE guild_id=?`),
      drift: delIfExists(`DELETE FROM poopy_personality_drift WHERE guild_id=?`),
    };
    res.json({ ok: true, ...r });
  } finally { db.close(); }
});

// ── Poopy favorites pools (Phase #209) ────────────────────────────────────────
const VALID_POOL_DIMS = new Set(["color", "food", "emoji", "animal", "song", "time_of_day"]);

router.get("/admin/ai/personality/pools/:guildId", (req, res) => {
  const db = openDb();
  try {
    const rows = db.prepare(`SELECT id, dimension, value, added_by, added_at FROM poopy_favorites_pools WHERE guild_id=? ORDER BY dimension, added_at`).all(req.params.guildId);
    res.json(rows);
  } catch (e) { if (isMissingTable(e)) res.json([]); else throw e; }
  finally { db.close(); }
});

router.post("/admin/ai/personality/pools", (req, res) => {
  const { guild_id, dimension, value } = req.body as { guild_id?: string; dimension?: string; value?: string };
  if (!guild_id || !dimension || !value || !VALID_POOL_DIMS.has(dimension)) {
    res.status(400).json({ error: "guild_id, dimension (color|food|emoji|animal|song|time_of_day), and value required" });
    return;
  }
  const db = openDb();
  try {
    const cnt = (db.prepare(`SELECT COUNT(*) as c FROM poopy_favorites_pools WHERE guild_id=? AND dimension=?`).get(guild_id, dimension) as { c: number }).c;
    if (cnt >= 20) { res.status(409).json({ error: `Pool for ${dimension} is full (20 max)` }); return; }
    db.prepare(`INSERT OR IGNORE INTO poopy_favorites_pools (guild_id, dimension, value, added_by) VALUES (?,?,?,'admin')`).run(guild_id, dimension, value);
    res.json({ ok: true });
  } catch (e) { if (isMissingTable(e)) res.status(503).json({ error: "table not ready" }); else throw e; }
  finally { db.close(); }
});

router.delete("/admin/ai/personality/pools/:guildId/:id", (req, res) => {
  const db = openDb();
  try {
    const changes = db.prepare(`DELETE FROM poopy_favorites_pools WHERE id=? AND guild_id=?`).run(Number(req.params.id), req.params.guildId).changes;
    res.json({ ok: true, changes });
  } catch (e) { if (isMissingTable(e)) res.json({ ok: true, changes: 0 }); else throw e; }
  finally { db.close(); }
});

// ── Custom personality responses ──────────────────────────────────────────────

router.get("/admin/custom-responses/:guildId", (req, res) => {
  const guildId = String(req.params["guildId"] ?? "");
  const db = openDb();
  try {
    const rows = db.prepare("SELECT rowid AS id, trigger, response, added_by FROM poopy_custom_responses WHERE guild_id=? ORDER BY rowid DESC").all(guildId) as { id: number; trigger: string; response: string; added_by: string }[];
    res.json(rows);
  } catch { res.json([]); } finally { db.close(); }
});

router.delete("/admin/custom-responses/:guildId/:id", (req, res) => {
  const guildId = String(req.params["guildId"] ?? "");
  const id      = Number(req.params["id"] ?? 0);
  const db = openDb();
  try {
    db.prepare("DELETE FROM poopy_custom_responses WHERE guild_id=? AND rowid=?").run(guildId, id);
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Tribunal — active exiles ───────────────────────────────────────────────────

router.get("/admin/tribunal/exiles", (_req, res) => {
  const db = openDb();
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = db.prepare(`
      SELECT guild_id, user_id, username, exile_until
      FROM user_stats
      WHERE exile_until > ?
      ORDER BY exile_until ASC
    `).all(now) as { guild_id: string; user_id: string; username: string; exile_until: number }[];
    res.json(rows);
  } catch { res.json([]); } finally { db.close(); }
});

router.delete("/admin/tribunal/exile/:guildId/:userId", (req, res) => {
  const guildId = String(req.params["guildId"] ?? "");
  const userId  = String(req.params["userId"]  ?? "");
  const db = openDb();
  try {
    db.prepare("UPDATE user_stats SET exile_until=0 WHERE guild_id=? AND user_id=?").run(guildId, userId);
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── Poogest ───────────────────────────────────────────────────────────────────

router.get("/admin/poogest/:guildId/events", (req, res) => {
  const { guildId } = req.params;
  const db = openDb();
  try {
    const events = db.prepare(`
      SELECT id, type, user_ids, usernames, description, importance, ts
      FROM poogest_events WHERE guild_id = ?
      ORDER BY importance DESC, ts DESC LIMIT 100
    `).all(guildId);
    const count = (db.prepare("SELECT COUNT(*) as n FROM poogest_events WHERE guild_id=?").get(guildId) as { n: number })?.n ?? 0;
    const cfgRows = db.prepare("SELECT key, value FROM guild_config WHERE guild_id=? AND key IN ('poogest_channel_id','poogest_last_posted','poogest_day','poogest_hour')").all(guildId) as { key: string; value: string }[];
    const cfg: Record<string, string> = {};
    for (const r of cfgRows) cfg[r.key] = r.value;
    res.json({
      events,
      count,
      channelId:  cfg.poogest_channel_id ?? null,
      lastPosted: cfg.poogest_last_posted ? parseInt(cfg.poogest_last_posted) : null,
      scheduleDay:  cfg.poogest_day  !== undefined ? parseInt(cfg.poogest_day)  : null,
      scheduleHour: cfg.poogest_hour !== undefined ? parseInt(cfg.poogest_hour) : null,
    });
  } finally { db.close(); }
});

router.delete("/admin/poogest/:guildId/events", (req, res) => {
  const { guildId } = req.params;
  const db = openDb();
  try {
    const info = db.prepare("DELETE FROM poogest_events WHERE guild_id=?").run(guildId);
    res.json({ ok: true, deleted: info.changes });
  } finally { db.close(); }
});

// ── Allied Bots ───────────────────────────────────────────────────────────────
router.get("/admin/allied-bots/:guildId", (req, res) => {
  const { guildId } = req.params;
  const db = openDb();
  try {
    const rows = db.prepare("SELECT bot_user_id, enabled FROM guild_allied_bots WHERE guild_id=?").all(guildId) as { bot_user_id: string; enabled: number }[];
    const enabledMap: Record<string, number> = {};
    for (const r of rows) enabledMap[r.bot_user_id] = r.enabled;
    const result = Object.entries(ALLIED_BOT_REGISTRY).map(([id, entry]) => ({
      botUserId: id,
      name: entry.name,
      slug: entry.slug,
      enabled: enabledMap[id] === 1,
    }));
    res.json(result);
  } finally { db.close(); }
});

router.put("/admin/allied-bots/:guildId", (req, res) => {
  const { guildId } = req.params;
  const { botUserId, enabled } = req.body as { botUserId?: string; enabled?: boolean };
  if (!botUserId || !ALLIED_BOT_REGISTRY[botUserId]) {
    res.status(400).json({ error: "Bot ID not in registry" });
    return;
  }
  const db = openDb();
  try {
    db.prepare("INSERT OR REPLACE INTO guild_allied_bots (guild_id, bot_user_id, enabled) VALUES (?,?,?)").run(guildId, botUserId, enabled ? 1 : 0);
    res.json({ ok: true, botUserId, enabled: !!enabled });
  } finally { db.close(); }
});

// ── Moderation config ─────────────────────────────────────────────────────────
// Stores per-guild customization for Poopy's conversational server management.
// Keys (all stored in guild_config): mod_required_role, mod_disable_delete

const MOD_CONFIG_KEYS = ['mod_required_role', 'mod_disable_delete'] as const;

router.get("/admin/mod-config/:guildId", (req, res) => {
  const { guildId } = req.params;
  const db = openDb();
  try {
    const rows = db.prepare(
      `SELECT key, value FROM guild_config WHERE guild_id=? AND key IN (${MOD_CONFIG_KEYS.map(() => '?').join(',')})`
    ).all(guildId, ...MOD_CONFIG_KEYS) as { key: string; value: string }[];
    const cfg: Record<string, string> = {};
    for (const r of rows) cfg[r.key] = r.value;
    res.json({ guildId, ...cfg });
  } finally { db.close(); }
});

router.put("/admin/mod-config/:guildId", (req, res) => {
  const { guildId } = req.params;
  const body = req.body as Record<string, string>;
  const db = openDb();
  try {
    const stmt = db.prepare(`INSERT OR REPLACE INTO guild_config (guild_id, key, value) VALUES (?, ?, ?)`);
    for (const key of MOD_CONFIG_KEYS) {
      if (key in body) stmt.run(guildId, key, body[key] ?? '');
    }
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── PAFD — Poopy Anti-Feces Defense ──────────────────────────────────────────

router.get("/admin/pafd/config/:guildId", (req, res) => {
  const db = openDb();
  try {
    const cfg = db.prepare("SELECT * FROM pafd_config WHERE guild_id=?").get(req.params.guildId);
    res.json({ config: cfg ?? { guild_id: req.params.guildId, enabled: 0, log_channel_id: null, timeout_minutes: 10 } });
  } finally { db.close(); }
});

router.put("/admin/pafd/config/:guildId", (req, res) => {
  const b = req.body as Record<string, unknown>;
  const db = openDb();
  try {
    db.prepare(`INSERT INTO pafd_config
      (guild_id, enabled, log_channel_id, timeout_minutes,
       builtin_slurs, builtin_selfharm, dm_warn, delete_msg,
       timeout1_min, timeout2_min, alert_delete_sec, admins_immune,
       exempt_channel_ids, skip_kick, pafd_max_action, owner_immune)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(guild_id) DO UPDATE SET
        enabled             = excluded.enabled,
        log_channel_id      = excluded.log_channel_id,
        timeout_minutes     = excluded.timeout_minutes,
        builtin_slurs       = excluded.builtin_slurs,
        builtin_selfharm    = excluded.builtin_selfharm,
        dm_warn             = excluded.dm_warn,
        delete_msg          = excluded.delete_msg,
        timeout1_min        = excluded.timeout1_min,
        timeout2_min        = excluded.timeout2_min,
        alert_delete_sec    = excluded.alert_delete_sec,
        admins_immune       = excluded.admins_immune,
        exempt_channel_ids  = excluded.exempt_channel_ids,
        skip_kick           = excluded.skip_kick,
        pafd_max_action     = excluded.pafd_max_action,
        owner_immune        = excluded.owner_immune,
        updated_at          = CURRENT_TIMESTAMP`)
      .run(
        req.params.guildId,
        b.enabled             ?? 0,
        b.log_channel_id      ?? null,
        b.timeout_minutes     ?? 10,
        b.builtin_slurs       ?? 1,
        b.builtin_selfharm    ?? 1,
        b.dm_warn             ?? 1,
        b.delete_msg          ?? 1,
        b.timeout1_min        ?? 10,
        b.timeout2_min        ?? 60,
        b.alert_delete_sec    ?? 20,
        b.admins_immune       ?? 1,
        b.exempt_channel_ids  ?? '[]',
        b.skip_kick           ?? 0,
        b.pafd_max_action     ?? 'ban',
        b.owner_immune        ?? 1,
      );
    res.json({ ok: true });
  } finally { db.close(); }
});

router.get("/admin/pafd/words/:guildId", (req, res) => {
  const db = openDb();
  try {
    const words = db.prepare("SELECT * FROM pafd_words WHERE guild_id=? ORDER BY severity, pattern").all(req.params.guildId);
    res.json({ words });
  } finally { db.close(); }
});

router.post("/admin/pafd/words/:guildId", (req, res) => {
  const { pattern, severity } = req.body as Record<string, string>;
  if (!pattern?.trim()) { res.status(400).json({ error: "pattern required" }); return; }
  const db = openDb();
  try {
    db.prepare("INSERT OR IGNORE INTO pafd_words (guild_id, pattern, severity, added_by) VALUES (?,?,?,?)")
      .run(req.params.guildId, pattern.trim().toLowerCase(), severity ?? "moderate", "admin");
    res.json({ ok: true });
  } finally { db.close(); }
});

router.delete("/admin/pafd/words/:guildId/:id", (req, res) => {
  const db = openDb();
  try {
    db.prepare("DELETE FROM pafd_words WHERE id=? AND guild_id=?").run(Number(req.params.id), req.params.guildId);
    res.json({ ok: true });
  } finally { db.close(); }
});

router.get("/admin/pafd/violations/:guildId", (req, res) => {
  const db = openDb();
  try {
    const rows = db.prepare("SELECT * FROM pafd_violations WHERE guild_id=? ORDER BY timestamp DESC LIMIT 100").all(req.params.guildId);
    res.json({ violations: rows });
  } finally { db.close(); }
});

router.delete("/admin/pafd/violations/:guildId/:userId", (req, res) => {
  const db = openDb();
  try {
    const r = db.prepare("DELETE FROM pafd_violations WHERE guild_id=? AND user_id=?")
      .run(req.params.guildId, req.params.userId) as { changes: number };
    res.json({ ok: true, deleted: r.changes });
  } finally { db.close(); }
});

// ── Admin secret management ───────────────────────────────────────────────────

router.get("/admin/secret", (_req, res) => {
  const db = openDb();
  try {
    const row = db.prepare("SELECT value FROM bot_settings WHERE key='admin_secret'").get() as { value: string } | undefined;
    const secret = row?.value ?? process.env["ADMIN_SECRET"] ?? null;
    res.json({ secret });
  } finally { db.close(); }
});

router.put("/admin/secret", (req, res) => {
  const { secret } = req.body as { secret?: string };
  if (!secret || secret.trim().length < 8) {
    res.status(400).json({ error: "Secret must be at least 8 characters" });
    return;
  }
  const db = openDb();
  try {
    db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('admin_secret', ?)").run(secret.trim());
    db.prepare("INSERT INTO activity_log (type, guild_id, user_id, username, data) VALUES ('admin_action',NULL,NULL,'admin',?)")
      .run(JSON.stringify({ action: "update_admin_secret" }));
    res.json({ ok: true });
  } finally { db.close(); }
});

export default router;
