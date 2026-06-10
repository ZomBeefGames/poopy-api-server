import { createServer } from "http";
import type { IncomingMessage } from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import Database from "better-sqlite3";
import app from "./app";
import { logger } from "./lib/logger";
import { writeErrorLog } from "./middlewares/errorCapture.js";
import { getTracks, getPlayerState, setTracks, addWsClient, removeWsClient } from "./lib/player.js";
import { fetchPlaylistTracks } from "./lib/soundcloud.js";
import { getLocalTracks } from "./lib/localTracks.js";
import { pooBattleWss } from "./lib/pooBattle.js";
import { resolveIdentity } from "./lib/discordAuth.js";
import { shipLogDirect } from "./routes/devLogs.js";
import { startWorker } from "./lib/apiWorker.js";
import { startEvolver, setRailwayBenchmarkFlag } from "./lib/crystallineEvolver.js";
const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname_curr = path.dirname(__filename);
// Tracks are at workspace root /tracks, three levels up from /artifacts/api-server/src/
const tracksDir = path.resolve(__dirname_curr, "..", "..", "..", "tracks");

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Load local tracks immediately (all 29 tracks with full metadata)
const localTracks = getLocalTracks();
setTracks(localTracks);
logger.info({ count: localTracks.length }, "Local tracks loaded");

// Also try SoundCloud in background to get updated metadata (non-critical)
fetchPlaylistTracks()
  .then((scTracks) => {
    const scBySlug = new Map(scTracks.map((t) => [t.slug, t]));
    const merged = localTracks.map((t) => scBySlug.get(t.slug) ?? t);
    setTracks(merged);
    logger.info({ count: merged.length }, "Merged SoundCloud + local tracks");
  })
  .catch(() => logger.info("SoundCloud unavailable — using local track list only"));

type VerifiedReq = IncomingMessage & { _verifiedUserId?: string; _verifiedUsername?: string };

server.on("upgrade", async (req: VerifiedReq, socket, head) => {
  const pathname = req.url?.split("?")[0];

  if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else if (pathname === "/poo-ws") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token    = url.searchParams.get("token");
    const devUserId = url.searchParams.get("devUserId");

    let verifiedUserId: string | null = null;
    let verifiedUsername = "Pilot";

    if (token) {
      const identity = await resolveIdentity(token);
      if (identity) {
        verifiedUserId   = identity.userId;
        verifiedUsername = identity.username;
      }
    } else if (process.env["NODE_ENV"] !== "production" && devUserId) {
      verifiedUserId   = devUserId;
      verifiedUsername = "Dev Pilot";
    }

    if (!verifiedUserId) {
      socket.destroy();
      return;
    }

    req._verifiedUserId   = verifiedUserId;
    req._verifiedUsername = verifiedUsername;

    pooBattleWss.handleUpgrade(req, socket, head, (ws) => {
      pooBattleWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const guildId = url.searchParams.get("guildId") ?? "default";

  addWsClient(guildId, ws);

  // Send slim state on connect (no tracks array — keeps WS frame <1 KB).
  // Tracks are sent separately in paginated batches to stay under Discord's proxy cap.
  getPlayerState(guildId).then((state) => {
    const tracks = getTracks();
    const track = tracks.find((t) => t.slug === state.slug) ?? null;
    if (ws.readyState !== 1) return;
    // 1. Core state — ~350 bytes
    ws.send(JSON.stringify({ type: "state", data: { ...state, track, tracks: [] } }));
    // 2. Tracks in batches of 10, without artwork URLs (~580 bytes each)
    const PAGE = 10;
    const minTracks = tracks.map((t) => ({ slug: t.slug, title: t.title, duration: t.duration }));
    for (let offset = 0; offset < minTracks.length; offset += PAGE) {
      if (ws.readyState !== 1) break;
      const batch = minTracks.slice(offset, offset + PAGE);
      ws.send(JSON.stringify({ type: "tracks", offset, total: minTracks.length, data: batch }));
    }
  }).catch(() => {});

  // Per-client audio generation counter — bumped on each new getAudio request
  // so in-progress chunk sends from a previous request abort cleanly.
  let audioGeneration = 0;

  ws.on("message", async (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString()) as {
        type?: string;
        url?: string;
        slug?: string;
      };

      // -----------------------------------------------------------------------
      // Artwork over WebSocket
      // Discord's HTTP proxy caps response bodies at ~1 KB, which blocks even
      // tiny images.  WebSocket messages have no such limit.
      // -----------------------------------------------------------------------
      if (msg.type === "getArtwork" && typeof msg.url === "string") {
        const rawUrl = msg.url;
        if (!/^https:\/\/i\d+\.sndcdn\.com\//.test(rawUrl)) return;
        const smallUrl = rawUrl.replace(/t\d+x\d+/, "t500x500");
        try {
          const r = await fetch(smallUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; ZomBeef/1.0)" },
          });
          if (!r.ok) return;
          const buf = Buffer.from(await r.arrayBuffer());
          const mimeType = r.headers.get("content-type") ?? "image/jpeg";
          if (ws.readyState === 1 /* OPEN */) {
            ws.send(JSON.stringify({
              type: "artwork",
              url: rawUrl,
              data: buf.toString("base64"),
              mimeType,
            }));
          }
        } catch { /* ignore upstream fetch errors */ }
      }

      // -----------------------------------------------------------------------
      // Audio over WebSocket — stream local MP3 as base64 chunks
      // -----------------------------------------------------------------------
      if (msg.type === "getAudio" && typeof msg.slug === "string") {
        const slug = msg.slug.replace(/[^a-z0-9-]/g, "");
        const localPath = path.join(tracksDir, `${slug}.mp3`);
        if (!fs.existsSync(localPath)) return;

        // Bump generation — the previous loop (if any) will stop at next iteration
        audioGeneration++;
        const myGen = audioGeneration;

        const total = fs.statSync(localPath).size;
        const CHUNK = 32 * 1024; // 32 KB binary → ~43 KB base64 per WS message
        const numChunks = Math.ceil(total / CHUNK);

        for (let i = 0; i < numChunks; i++) {
          if (ws.readyState !== 1 /* OPEN */ || audioGeneration !== myGen) break;

          const start = i * CHUNK;
          const end = Math.min(start + CHUNK - 1, total - 1);
          const buf = Buffer.allocUnsafe(end - start + 1);
          const fd = fs.openSync(localPath, "r");
          fs.readSync(fd, buf, 0, buf.length, start);
          fs.closeSync(fd);

          ws.send(JSON.stringify({
            type: "audioChunk",
            slug,
            idx: i,
            numChunks,
            total,
            data: buf.toString("base64"),
          }));
        }
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on("close", () => removeWsClient(guildId, ws));
  ws.on("error", () => removeWsClient(guildId, ws));
});

// ── Seed default admin secret ─────────────────────────────────────────────────
function seedAdminSecret() {
  const dbPath = path.resolve(__dirname_curr, "..", "..", "..", "poop_tracker.db");
  try {
    const db = new Database(dbPath);
    const existing = db.prepare("SELECT value FROM bot_settings WHERE key='admin_secret'").get() as { value: string } | undefined;
    if (!existing?.value) {
      const generated = process.env["ADMIN_SECRET"] ?? crypto.randomBytes(16).toString("hex");
      db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('admin_secret', ?)").run(generated);
      logger.info({ hint: "Use this to log in to Poopy Admin" }, `Admin secret: ${generated}`);
    }
    db.close();
  } catch (e) {
    logger.warn({ err: e }, "Could not seed admin secret");
  }
}

// ── Process-level error capture — catches crashes that bypass Express ─────────
// Without these, uncaught exceptions and unhandled promise rejections die silently.
// They're wired here (not in app.ts) so they have access to the full process scope
// and still log to the same Postgres error_log ring buffer that /logs/recent reads.
process.on("uncaughtException", (err: Error) => {
  logger.error({ err }, "[process] uncaughtException — persisting to error_log");
  void writeErrorLog({
    route:   "process",
    method:  "uncaughtException",
    message: err.message ?? String(err),
    stack:   err.stack ?? null,
    source:  "api-server-process",
  });
});

process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack   = reason instanceof Error ? (reason.stack ?? null) : null;
  logger.error({ reason }, "[process] unhandledRejection — persisting to error_log");
  void writeErrorLog({
    route:   "process",
    method:  "unhandledRejection",
    message,
    stack,
    source:  "api-server-process",
  });
});

server.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  seedAdminSecret();
  logger.info({ port }, "Server listening");
  shipLogDirect("api-server", "info", `Server started on port ${port}`);
  // startZombrainsWatchdog(); // shut down
  startWorker(port);
  try {
    startEvolver('api-server', 'knowledge');
    startEvolver('api-server', 'general');
  } catch (e) {
    logger.warn({ err: e }, "[Evolver] Failed to start — api-server unaffected");
  }
  // Task #488: seed Railway benchmark flag from feature_flags DB on boot
  try {
    const dbPath = path.resolve(__dirname_curr, "..", "..", "..", "poop_tracker.db");
    const sqliteDb = new Database(dbPath, { readonly: true });
    try {
      const row = sqliteDb.prepare(
        "SELECT enabled FROM feature_flags WHERE flag='evolver_railway_benchmark_enabled'"
      ).get() as { enabled: number } | undefined;
      if (row) {
        setRailwayBenchmarkFlag(row.enabled === 1);
        logger.info({ enabled: row.enabled === 1 }, "[Evolver #488] Railway benchmark flag loaded from DB");
      }
    } finally { sqliteDb.close(); }
  } catch (e) {
    logger.warn({ err: e }, "[Evolver #488] Railway benchmark flag load failed (non-fatal)");
  }
  // Task #493: restore noise models (epsilon, noise_floor, saturation) from DB on boot
  void (async () => {
    try {
      const { restoreNoiseModels, createScopedDb } = await import("./lib/crystallineEvolver.js");
      const { db } = await import("@workspace/db");
      await restoreNoiseModels(createScopedDb(db));
      logger.info("[Evolver #493] Noise models restored from DB");
    } catch (e) {
      logger.warn({ err: e }, "[Evolver #493] restoreNoiseModels failed on boot (non-fatal)");
    }
  })();
  // Task #506 Step 3: seed worker-queue cache from Railway so Poopy sees tasks immediately
  void (async () => {
    try {
      const { seedQueueFromRailway } = await import("./routes/zombrains-workers.js");
      await seedQueueFromRailway();
      logger.info("[Worker #506] Queue seeded from Railway on boot");
    } catch (e) {
      logger.warn({ err: e }, "[Worker #506] seedQueueFromRailway failed (non-fatal)");
    }
  })();
  // Tasks #620/#621: crystal ledger backfill + pattern, relevance, decay schedules
  void (async () => {
    try {
      const { schedulePatternRefresh, runCrystalLedgerBackfill, scheduleRelevanceRefresh, scheduleCrystalDecay } = await import("./routes/zombrains-crystals.js");
      runCrystalLedgerBackfill();
      schedulePatternRefresh();
      scheduleRelevanceRefresh();
      scheduleCrystalDecay();
      logger.info("[Crystals #621] Ledger backfill + pattern/relevance/decay scheduled");
    } catch (e) {
      logger.warn({ err: e }, "[Crystals #621] startup hooks failed (non-fatal)");
    }
  })();
});
