// ══════════════════════════════════════════════════════════════════════════════
// zombeef.ts — ZomBeef render job queue
//   POST   /zombeef/render         — enqueue a music-video render job
//   GET    /zombeef/render          — list jobs (optional ?status= filter)
//   GET    /zombeef/render/:id      — get a single job
//   PATCH  /zombeef/render/:id      — update job status (used by ZomBeef Suite bot)
// ══════════════════════════════════════════════════════════════════════════════
import { Router, type IRouter, type Request, type Response } from "express";
import { getDb, authCheck } from "./zombrains-shared.js";
import { sendRenderCompleteEmail } from "../lib/mailer.js";

const router: IRouter = Router();

type RenderJob = {
  id:                   number;
  audio_url:            string;
  background_url:       string;
  title:                string;
  artist:               string;
  style:                string;
  color:                string;
  format:               string;
  normalize:            number;
  requester_discord_id: string | null;
  status:               string;
  result_url:           string | null;
  error_msg:            string | null;
  email_sent:           number;
  created_at:           string;
  updated_at:           string;
};

const VALID_STATUSES = ["pending", "processing", "done", "failed"] as const;
// Matches the styles actually supported by zombeef-suite/bot/render/videoRenderer.js
const VALID_STYLES   = ["waveform", "frequency_bars", "spectrum", "circular", "pulse"] as const;
const VALID_FORMATS  = ["landscape", "shorts"] as const;

// ── POST /zombeef/render — enqueue a new render job ───────────────────────────
router.post("/zombeef/render", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;

  const {
    audioUrl, backgroundUrl, title,
    artist               = "",
    style                = "frequency_bars",
    color                = "D39A45",
    format               = "landscape",
    normalize            = false,
    requesterDiscordId   = null,
  } = req.body as {
    audioUrl?:            string;
    backgroundUrl?:       string;
    title?:               string;
    artist?:              string;
    style?:               string;
    color?:               string;
    format?:              string;
    normalize?:           boolean;
    requesterDiscordId?:  string | null;
  };

  if (!audioUrl?.trim())      { res.status(400).json({ error: "audioUrl is required" });      return; }
  if (!backgroundUrl?.trim()) { res.status(400).json({ error: "backgroundUrl is required" }); return; }
  if (!title?.trim())         { res.status(400).json({ error: "title is required" });          return; }

  const resolvedStyle  = (VALID_STYLES as readonly string[]).includes(style)  ? style  : "frequency_bars";
  const resolvedFormat = (VALID_FORMATS as readonly string[]).includes(format) ? format : "landscape";

  const db     = getDb();
  const result = db.prepare(`
    INSERT INTO zombeef_render_jobs
      (audio_url, background_url, title, artist, style, color, format, normalize, requester_discord_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    audioUrl.trim(), backgroundUrl.trim(), title.trim(), artist.trim(),
    resolvedStyle, color.replace(/^#/, "").trim(), resolvedFormat,
    normalize ? 1 : 0, requesterDiscordId ?? null,
  );
  db.close();

  res.json({ ok: true, id: result.lastInsertRowid, status: "pending" });
});

// ── GET /zombeef/render — list jobs ───────────────────────────────────────────
router.get("/zombeef/render", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;

  const status = req.query["status"] as string | undefined;
  const limit  = Math.min(Number(req.query["limit"] ?? 50), 200);

  const db   = getDb();
  const rows = status
    ? (db.prepare("SELECT * FROM zombeef_render_jobs WHERE status=? ORDER BY id ASC LIMIT ?").all(status, limit) as RenderJob[])
    : (db.prepare("SELECT * FROM zombeef_render_jobs ORDER BY id DESC LIMIT ?").all(limit) as RenderJob[]);
  db.close();

  res.json(rows);
});

// ── GET /zombeef/render/:id — get a single job ────────────────────────────────
router.get("/zombeef/render/:id", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;

  const id  = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

  const db  = getDb();
  const row = db.prepare("SELECT * FROM zombeef_render_jobs WHERE id=?").get(id) as RenderJob | undefined;
  db.close();

  if (!row) { res.status(404).json({ error: "job not found" }); return; }
  res.json(row);
});

// ── PATCH /zombeef/render/:id — update job status ────────────────────────────
// Called by ZomBeef Suite bot to mark a job as processing/done/failed.
router.patch("/zombeef/render/:id", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;

  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

  const { status, result_url, error_msg } = req.body as {
    status?:     string;
    result_url?: string;
    error_msg?:  string;
  };

  if (!status || !(VALID_STATUSES as readonly string[]).includes(status)) {
    res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }); return;
  }

  const db = getDb();
  const existing = db.prepare("SELECT id FROM zombeef_render_jobs WHERE id=?").get(id);
  if (!existing) { db.close(); res.status(404).json({ error: "job not found" }); return; }

  db.prepare(`
    UPDATE zombeef_render_jobs
       SET status=?, result_url=?, error_msg=?, updated_at=datetime('now')
     WHERE id=?
  `).run(status, result_url ?? null, error_msg ?? null, id);

  // ── Email notification on completion ──────────────────────────────────────
  // Fire-and-forget: email failure must never fail the PATCH response.
  if (status === "done" && result_url) {
    const job = db.prepare("SELECT requester_discord_id, title, email_sent FROM zombeef_render_jobs WHERE id=?").get(id) as Pick<RenderJob, "requester_discord_id" | "title" | "email_sent"> | undefined;
    const emailTo = process.env["RESEND_TO_EMAIL"] ?? job?.requester_discord_id ?? null;
    if (emailTo && job && !job.email_sent) {
      sendRenderCompleteEmail({ to: emailTo, title: job.title, resultUrl: result_url })
        .then(r => {
          if (r.ok) {
            const db2 = getDb();
            db2.prepare("UPDATE zombeef_render_jobs SET email_sent=1 WHERE id=?").run(id);
            db2.close();
          }
        })
        .catch(() => {});
    }
  }

  db.close();
  res.json({ ok: true, id, status });
});

export default router;
