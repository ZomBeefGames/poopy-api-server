import https from "https";
import http from "http";
import type { Response } from "express";
import type { PlayerTrack } from "./player.js";

const PLAYLIST_URL = "https://soundcloud.com/zombeef01/sets/dead-inside-still-fresh";

// ── HTTP helper ────────────────────────────────────────────────────────────────

function httpsGet(url: string, headers?: Record<string, string>, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error("Too many redirects")); return; }
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : (http as unknown as typeof https);
    const req = mod.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { "User-Agent": "Mozilla/5.0", ...headers } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = res.headers.location as string;
          resolve(httpsGet(loc.startsWith("http") ? loc : `${parsed.protocol}//${parsed.host}${loc}`, headers, redirects + 1));
          return;
        }
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => resolve(data));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
  });
}

async function fetchJson<T = unknown>(url: string): Promise<T> {
  return JSON.parse(await httpsGet(url)) as T;
}

// ── Client ID ─────────────────────────────────────────────────────────────────

let cachedClientId: string | null = null;
let clientIdExpiry = 0;

export async function getClientId(): Promise<string> {
  if (cachedClientId && Date.now() < clientIdExpiry) return cachedClientId;
  const html = await httpsGet("https://soundcloud.com");
  const scriptUrls = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  for (const url of scriptUrls.reverse()) {
    const script = await httpsGet(url).catch(() => "");
    const match = script.match(/[,{(]client_id:"([a-zA-Z0-9]{32,})"/);
    if (match) {
      cachedClientId = match[1];
      clientIdExpiry = Date.now() + 6 * 60 * 60 * 1000;
      return cachedClientId;
    }
  }
  throw new Error("Could not extract SoundCloud client_id");
}

// ── Playlist fetch ─────────────────────────────────────────────────────────────

interface SCTranscoding { url: string; format: { protocol: string; mime_type: string } }
interface SCRawTrack {
  id: number; title: string; permalink: string; duration: number;
  artwork_url: string | null; user?: { avatar_url?: string };
  media?: { transcodings: SCTranscoding[] };
}
interface SCPlaylist { tracks: SCRawTrack[] }

// slug → transcoding URL (long-lived, 12h cache)
const transcodingCache = new Map<string, { url: string; expiry: number }>();
// slug → resolved stream URL (short-lived, 50min)
const streamCache = new Map<string, { url: string; expiry: number }>();

function pickTranscoding(tcs: SCTranscoding[]): SCTranscoding | undefined {
  return (
    tcs.find((t) => t.format.protocol === "progressive" && t.format.mime_type === "audio/mpeg") ??
    tcs.find((t) => t.format.protocol === "progressive") ??
    tcs[0]
  );
}

export async function fetchPlaylistTracks(): Promise<PlayerTrack[]> {
  const clientId = await getClientId();
  const playlist = await fetchJson<SCPlaylist>(
    `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(PLAYLIST_URL)}&client_id=${clientId}`,
  );

  const rawTracks = playlist.tracks ?? [];

  // Split full tracks vs stubs (stubs have no media)
  const full: SCRawTrack[] = rawTracks.filter((t) => t.media?.transcodings?.length);
  const stubIds = rawTracks.filter((t) => !t.media?.transcodings?.length).map((t) => t.id);

  // Batch-fetch stubs
  for (let i = 0; i < stubIds.length; i += 50) {
    const ids = stubIds.slice(i, i + 50).join(",");
    const fetched = await fetchJson<SCRawTrack[]>(
      `https://api-v2.soundcloud.com/tracks?ids=${ids}&client_id=${clientId}`,
    ).catch(() => [] as SCRawTrack[]);
    full.push(...fetched);
  }

  // Restore playlist order
  const byId = new Map(full.map((t) => [t.id, t]));
  const ordered = rawTracks.map((t) => byId.get(t.id)).filter(Boolean) as SCRawTrack[];

  const result: PlayerTrack[] = [];
  for (const track of ordered) {
    const tc = pickTranscoding(track.media?.transcodings ?? []);
    if (!tc) continue;
    transcodingCache.set(track.permalink, { url: tc.url, expiry: Date.now() + 12 * 60 * 60 * 1000 });
    result.push({
      slug: track.permalink,
      title: track.title,
      duration: track.duration / 1000,
      artwork: (track.artwork_url ?? track.user?.avatar_url ?? null)?.replace("-large", "-t500x500") ?? null,
    });
  }
  return result;
}

// ── Stream URL resolution ─────────────────────────────────────────────────────

export async function resolveStreamUrl(slug: string): Promise<string | null> {
  const cached = streamCache.get(slug);
  if (cached && Date.now() < cached.expiry) return cached.url;

  const tc = transcodingCache.get(slug);
  if (!tc || Date.now() >= tc.expiry) return null;

  const clientId = await getClientId().catch(() => null);
  if (!clientId) return null;

  const result = await fetchJson<{ url?: string }>(`${tc.url}?client_id=${clientId}`).catch(() => null);
  const url = result?.url;
  if (!url) return null;

  streamCache.set(slug, { url, expiry: Date.now() + 50 * 60 * 1000 });
  return url;
}

// ── Stream proxy (Range-aware) ────────────────────────────────────────────────

export function proxyStream(streamUrl: string, rangeHeader: string | undefined, res: Response): void {
  const parsed = new URL(streamUrl);
  const mod = parsed.protocol === "https:" ? https : (http as unknown as typeof https);
  const req = mod.get(
    {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { "User-Agent": "Mozilla/5.0", ...(rangeHeader ? { Range: rangeHeader } : {}) },
    },
    (upstream) => {
      res.set("Content-Type", upstream.headers["content-type"] ?? "audio/mpeg");
      res.set("Accept-Ranges", "bytes");
      res.set("Cache-Control", "no-store");
      if (upstream.headers["content-length"]) res.set("Content-Length", upstream.headers["content-length"] as string);
      if (upstream.headers["content-range"]) res.set("Content-Range", upstream.headers["content-range"] as string);
      res.status(upstream.statusCode ?? 200);
      upstream.pipe(res);
    },
  );
  req.on("error", () => { if (!res.headersSent) res.status(502).send("Stream error"); });
}
