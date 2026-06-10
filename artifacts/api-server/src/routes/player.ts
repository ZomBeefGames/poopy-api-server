import { Router, type IRouter } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getTracks, getPlayerState, setPlayerState } from "../lib/player.js";
import { resolveStreamUrl, proxyStream } from "../lib/soundcloud.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tracksDir = path.resolve(__dirname, "..", "..", "..", "tracks");

const router: IRouter = Router();

router.get("/tracks", (_req, res) => {
  res.json(getTracks());
});

// ---------------------------------------------------------------------------
// Artwork + Audio — served as base64 JSON so Discord's Activity proxy passes
// them through.  The proxy only forwards responses whose Content-Type is
// application/json; binary types (image/*, audio/*) are silently replaced with
// an HTML page.  Registered under BOTH /api/player/* (matches the Discord URL
// mapping) and /api/* (legacy / local-dev).
// ---------------------------------------------------------------------------

import type { Request, Response } from "express";

async function handleArtwork(req: Request, res: Response): Promise<void> {
  const url = (req.query.q ?? req.query.url) as string;
  if (!url || !/^https:\/\/i\d+\.sndcdn\.com\//.test(url)) {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }
  try {
    const smallUrl = url.replace(/t\d+x\d+/, "t200x200");
    const upstream = await fetch(smallUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ZomBeef/1.0)" },
    });
    if (!upstream.ok) {
      res.status(502).json({ error: `Upstream ${upstream.status}` });
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const type = upstream.headers.get("content-type") || "image/jpeg";
    res.set("Cache-Control", "public, max-age=86400");
    res.json({ data: buf.toString("base64"), type });
  } catch {
    res.status(502).json({ error: "Upstream error" });
  }
}

// 6 KB binary → ~8 KB base64 JSON — small enough to pass Discord's proxy cap.
const AUDIO_CHUNK = 6 * 1024;

function handleAudio(req: Request, res: Response): void {
  const slug = String(req.params.slug ?? "").replace(/[^a-z0-9-]/g, "");
  const localPath = path.join(tracksDir, `${slug}.mp3`);
  if (!fs.existsSync(localPath)) {
    res.status(404).json({ error: "Track not found" });
    return;
  }
  const total = fs.statSync(localPath).size;
  const start = Math.max(0, parseInt((req.query.start as string) || "0", 10));
  const end = Math.min(start + AUDIO_CHUNK - 1, total - 1);
  const buf = Buffer.allocUnsafe(end - start + 1);
  const fd = fs.openSync(localPath, "r");
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  res.set("Cache-Control", "public, max-age=3600");
  res.json({ data: buf.toString("base64"), type: "audio/mpeg", start, end, total });
}

// Discord URL-mapped paths (must match what's registered in the Dev Portal)
router.get("/player/artwork", handleArtwork);
router.get("/player/audio/:slug", handleAudio);
// Legacy paths (local dev / non-Activity access)
router.get("/artwork", handleArtwork);
router.get("/audio/:slug", handleAudio);

// Size probe — lets the Activity measure Discord's proxy response-body limit.
// Returns exactly `kb` kilobytes of JSON so the client can binary-search the cap.
router.get("/player/sizetest/:kb", (req, res) => {
  const kb = Math.min(300, Math.max(1, parseInt(String(req.params.kb ?? "1"), 10)));
  const pad = "x".repeat(Math.max(0, kb * 1024 - 40));
  res.json({ ok: true, kb, pad });
});

// Stream audio — local MP3 first, SoundCloud fallback
router.get("/stream/:slug", async (req, res) => {
  const slug = req.params.slug.replace(/[^a-z0-9-]/g, "");
  const localPath = path.join(tracksDir, `${slug}.mp3`);

  if (fs.existsSync(localPath)) {
    const stat = fs.statSync(localPath);
    const rangeHeader = req.headers.range;
    res.set("Content-Type", "audio/mpeg");
    res.set("Accept-Ranges", "bytes");
    res.set("Cache-Control", "public, max-age=3600");

    if (rangeHeader) {
      const [startStr, endStr] = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      res.set("Content-Length", String(chunkSize));
      res.status(206);
      fs.createReadStream(localPath, { start, end }).pipe(res);
    } else {
      res.set("Content-Length", String(stat.size));
      res.status(200);
      fs.createReadStream(localPath).pipe(res);
    }
    return;
  }

  // Fallback: SoundCloud stream
  const streamUrl = await resolveStreamUrl(slug).catch(() => null);
  if (!streamUrl) {
    res.status(404).send("Track not found");
    return;
  }
  proxyStream(streamUrl, req.headers.range, res);
});

router.get("/player/healthz", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Slim state — no tracks array so the response stays under Discord's ~1 KB proxy cap.
// Tracks are fetched separately via /api/player/tracks/page/:n (10 per page).
router.get("/player/:guildId/state", async (req, res) => {
  const state = await getPlayerState(req.params.guildId);
  const tracks = getTracks();
  const track = tracks.find((t) => t.slug === state.slug) ?? null;
  res.json({ ...state, track, tracks: [] });
});

// Paginated track list — 10 tracks per page, no artwork URLs.
// Each response is ~580 bytes, well under Discord's proxy cap.
router.get("/player/tracks/page/:page", (req, res) => {
  const PAGE = 10;
  const page = Math.max(0, parseInt(String(req.params.page ?? "0"), 10));
  const all = getTracks();
  const offset = page * PAGE;
  const data = all.slice(offset, offset + PAGE).map((t) => ({
    slug: t.slug,
    title: t.title,
    duration: t.duration,
  }));
  res.json({ page, offset, total: all.length, data });
});

router.post("/player/:guildId/state", async (req, res) => {
  const { slug, idx, playing, startedAt, volume, repeat, shuffle } = req.body as Partial<{
    slug: string | null;
    idx: number;
    playing: boolean;
    startedAt: number | null;
    volume: number;
    repeat: "off" | "one" | "all";
    shuffle: boolean;
  }>;
  const patch: Record<string, unknown> = {};
  if (slug !== undefined) patch.slug = slug;
  if (idx !== undefined) patch.idx = idx;
  if (playing !== undefined) patch.playing = playing;
  if (startedAt !== undefined) patch.startedAt = startedAt;
  if (volume !== undefined) patch.volume = volume;
  if (repeat !== undefined) patch.repeat = repeat;
  if (shuffle !== undefined) patch.shuffle = shuffle;
  const next = await setPlayerState(req.params.guildId, patch as never);
  res.json(next);
});

router.post("/player/:guildId/play", async (req, res) => {
  const state = await getPlayerState(req.params.guildId);
  const tracks = getTracks();
  // If nothing is loaded yet, start the first track
  const slug = state.slug ?? tracks[0]?.slug ?? null;
  const idx = slug ? Math.max(tracks.findIndex((t) => t.slug === slug), 0) : 0;
  const next = await setPlayerState(req.params.guildId, {
    slug,
    idx,
    playing: true,
    startedAt: state.startedAt ?? Date.now(),
  });
  res.json(next);
});

router.post("/player/:guildId/pause", async (req, res) => {
  const next = await setPlayerState(req.params.guildId, { playing: false });
  res.json(next);
});

router.post("/player/:guildId/stop", async (req, res) => {
  const next = await setPlayerState(req.params.guildId, {
    playing: false,
    slug: null,
    startedAt: null,
  });
  res.json(next);
});

router.post("/player/:guildId/skip", async (req, res) => {
  const state = await getPlayerState(req.params.guildId);
  const tracks = getTracks();
  const currentIdx = tracks.findIndex((t) => t.slug === state.slug);
  const nextIdx = (currentIdx + 1) % tracks.length;
  const nextTrack = tracks[nextIdx];
  if (!nextTrack) { res.status(503).json({ error: "Tracks not loaded" }); return; }
  const next = await setPlayerState(req.params.guildId, {
    slug: nextTrack.slug,
    idx: nextIdx,
    playing: true,
    startedAt: Date.now(),
  });
  res.json(next);
});

router.post("/player/:guildId/prev", async (req, res) => {
  const state = await getPlayerState(req.params.guildId);
  const tracks = getTracks();
  const currentIdx = tracks.findIndex((t) => t.slug === state.slug);
  const prevIdx = (currentIdx - 1 + tracks.length) % tracks.length;
  const prevTrack = tracks[prevIdx];
  if (!prevTrack) { res.status(503).json({ error: "Tracks not loaded" }); return; }
  const next = await setPlayerState(req.params.guildId, {
    slug: prevTrack.slug,
    idx: prevIdx,
    playing: true,
    startedAt: Date.now(),
  });
  res.json(next);
});

router.post("/player/:guildId/track/:idx", async (req, res) => {
  const idx = Number(req.params.idx);
  const tracks = getTracks();
  if (isNaN(idx) || idx < 0 || idx >= tracks.length) {
    res.status(400).json({ error: "Invalid track index" });
    return;
  }
  const track = tracks[idx];
  const next = await setPlayerState(req.params.guildId, {
    slug: track.slug,
    idx,
    playing: true,
    startedAt: Date.now(),
  });
  res.json(next);
});

router.post("/player/:guildId/volume", async (req, res) => {
  const { volume } = req.body as { volume: number };
  if (typeof volume !== "number" || volume < 0 || volume > 100) {
    res.status(400).json({ error: "Volume must be 0-100" });
    return;
  }
  const next = await setPlayerState(req.params.guildId, { volume });
  res.json(next);
});

router.post("/player/:guildId/repeat", async (req, res) => {
  const { repeat } = req.body as { repeat: "off" | "one" | "all" };
  if (!["off", "one", "all"].includes(repeat)) {
    res.status(400).json({ error: "repeat must be off|one|all" });
    return;
  }
  const next = await setPlayerState(req.params.guildId, { repeat });
  res.json(next);
});

router.post("/player/:guildId/shuffle", async (req, res) => {
  const state = await getPlayerState(req.params.guildId);
  const next = await setPlayerState(req.params.guildId, { shuffle: !state.shuffle });
  res.json(next);
});

export default router;
