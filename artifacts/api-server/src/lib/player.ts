import type { WebSocket } from "ws";

export interface PlayerTrack {
  slug: string;
  title: string;
  duration: number;
  artwork: string | null;
}

export interface PlayerState {
  slug: string | null;
  idx: number;
  playing: boolean;
  startedAt: number | null;
  volume: number;
  repeat: "off" | "one" | "all";
  shuffle: boolean;
}

let TRACKS: PlayerTrack[] = [];

export function setTracks(tracks: PlayerTrack[]): void {
  TRACKS = tracks;
}

export function getTracks(): PlayerTrack[] {
  return TRACKS;
}

const defaultState = (): PlayerState => ({
  slug: null,
  idx: 0,
  playing: false,
  startedAt: null,
  volume: 80,
  repeat: "all",
  shuffle: false,
});

const memoryState = new Map<string, PlayerState>();

export async function getPlayerState(guildId: string): Promise<PlayerState> {
  return memoryState.get(guildId) ?? defaultState();
}

export async function setPlayerState(guildId: string, patch: Partial<PlayerState>): Promise<PlayerState> {
  const current = await getPlayerState(guildId);
  const next: PlayerState = { ...current, ...patch };
  memoryState.set(guildId, next);

  const tracks = getTracks();
  const track = tracks.find((t) => t.slug === next.slug) ?? null;
  broadcastToGuild(guildId, { type: "state", data: { ...next, track, tracks: [] } });
  return next;
}

const wsClients = new Map<string, Set<WebSocket>>();

export function addWsClient(guildId: string, ws: WebSocket): void {
  if (!wsClients.has(guildId)) wsClients.set(guildId, new Set());
  wsClients.get(guildId)!.add(ws);
}

export function removeWsClient(guildId: string, ws: WebSocket): void {
  wsClients.get(guildId)?.delete(ws);
}

export function broadcastToGuild(guildId: string, data: unknown): void {
  const clients = wsClients.get(guildId);
  if (!clients) return;
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
  }
}
