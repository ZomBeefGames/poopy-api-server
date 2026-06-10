import { Router, type IRouter } from "express";
import Database from "better-sqlite3";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const router: IRouter = Router();

// Resolve from the compiled bundle (dist/index.mjs) → 3 levels up → workspace root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath    = path.resolve(__dirname, "..", "..", "..", "birthday-bot", "birthday.db");

// In-memory avatar cache so we don't hammer Discord API.
const avatarCache = new Map<string, string>();

function defaultAvatar(userId: string): string {
  const idx = Number(BigInt(userId) >> 22n) % 6;
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function fetchAndCacheAvatar(userId: string): void {
  const token = process.env.BIRTHDAY_BOT_TOKEN;
  if (!token) return;

  const opts = {
    hostname: "discord.com",
    path: `/api/v10/users/${userId}`,
    method: "GET",
    headers: { Authorization: `Bot ${token}` },
  };

  const req = https.request(opts, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try {
        const user = JSON.parse(data) as { avatar?: string | null };
        const url = user.avatar
          ? `https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.png?size=64`
          : defaultAvatar(userId);
        avatarCache.set(userId, url);
      } catch {}
    });
  });
  req.on("error", () => {});
  req.end();
}

function getAvatar(userId: string): string {
  if (avatarCache.has(userId)) return avatarCache.get(userId)!;
  const url = defaultAvatar(userId);
  avatarCache.set(userId, url); // store default immediately
  fetchAndCacheAvatar(userId);  // refresh in background
  return url;
}

type BdayRow = {
  guild_id: string;
  user_id: string;
  username: string | null;
  month: number;
  day: number;
};

router.get("/birthday-calendar/birthdays", (req, res) => {
  try {
    const db   = new Database(dbPath, { readonly: true });
    const { guildId } = req.query;

    const rows: BdayRow[] = guildId
      ? (db.prepare(
          "SELECT guild_id, user_id, username, month, day FROM birthdays WHERE guild_id = ? ORDER BY month, day"
        ).all(String(guildId)) as BdayRow[])
      : (db.prepare(
          "SELECT guild_id, user_id, username, month, day FROM birthdays ORDER BY month, day"
        ).all() as BdayRow[]);

    db.close();

    res.json(rows.map((r) => ({
      guild_id: r.guild_id,
      user_id:  r.user_id,
      username: r.username ?? r.user_id,
      month:    r.month,
      day:      r.day,
      avatar:   getAvatar(r.user_id),
    })));
  } catch (e: unknown) {
    req.log.error({ err: e }, "birthday-calendar: db read failed");
    res.status(500).json({ error: "Could not read birthday data" });
  }
});

export default router;
