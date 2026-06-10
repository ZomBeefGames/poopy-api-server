import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { db, eq, and, sql } from "@workspace/db";
import {
  pooShipsTable,
  shipRoomsTable,
  shipCrewTable,
  flotillasTable,
  flotillaLogsTable,
  flotillaMembersTable,
  ppsBattleSessionsTable,
} from "@workspace/db";
import BetterSqlite3 from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const POOP_DB_PATH = path.join(WORKSPACE_ROOT, "poop_tracker.db");

// ---------------------------------------------------------------------------
// Combat types
// ---------------------------------------------------------------------------
interface CombatRoom {
  position: number;
  roomType: string;
  tier: number;
  hp: number;
  maxHp: number;
  destroyed: boolean;
}

interface CombatShipState {
  userId: string;
  username: string;
  hullHp: number;
  maxHullHp: number;
  rooms: CombatRoom[];
  crewGunnery: number;
  crewPiloting: number;
  combatPower: number;
}

interface ActiveBattle {
  attackerId: string;
  defenderId: string;
  attacker: CombatShipState;
  defender: CombatShipState;
  turn: number;
  log: string[];
  startedAt: Date;
}

interface LobbyPlayer {
  userId: string;
  username: string;
  combatPower: number;
  ws: WebSocket;
}

interface BattleSession {
  instanceId: string;
  players: Map<string, LobbyPlayer>;
  pendingChallenge: { challengerId: string; targetId: string } | null;
  activeBattle: ActiveBattle | null;
}

// ---------------------------------------------------------------------------
// Room constants (server-side truth)
// ---------------------------------------------------------------------------
const ROOM_BASE_HP: Record<string, number[]> = {
  methane_drive:       [15, 25, 35],
  sphincter_shield:    [25, 40, 60],
  turd_cannon:         [20, 30, 40],
  skid_mark_quarters:  [12, 18, 25],
  stool_lab:           [18, 28, 38],
  command_throne:      [22, 32, 45],
};

const CANNON_DAMAGE_RANGE: Record<number, [number, number]> = {
  1: [8, 12],
  2: [14, 22],
  3: [24, 35],
};

const SHIELD_ABSORB: Record<number, number> = { 1: 0.20, 2: 0.30, 3: 0.40 };

const BASE_HULL = 50;

// ---------------------------------------------------------------------------
// Helper: rand int in [min, max]
// ---------------------------------------------------------------------------
function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ---------------------------------------------------------------------------
// Build combat ship state from DB — always uses server-side data
// ---------------------------------------------------------------------------
async function buildCombatState(userId: string, username: string): Promise<CombatShipState> {
  const rooms = await db.select().from(shipRoomsTable).where(eq(shipRoomsTable.userId, userId));
  const crew  = await db.select().from(shipCrewTable).where(eq(shipCrewTable.userId, userId));

  const combatRooms: CombatRoom[] = rooms.map(r => {
    const maxHp = (ROOM_BASE_HP[r.roomType]?.[r.tier - 1]) ?? 15;
    return { position: r.position, roomType: r.roomType, tier: r.tier, hp: maxHp, maxHp, destroyed: false };
  });

  const totalRoomHp = combatRooms.reduce((sum, r) => sum + r.maxHp, 0);
  const hullHp = BASE_HULL + totalRoomHp;

  const assignedToRoom = (roomType: string) =>
    crew.filter(c => {
      const room = rooms.find(r => r.position === c.assignedRoom);
      return room?.roomType === roomType;
    });

  const cannonCrew  = assignedToRoom("turd_cannon");
  const crewGunnery = cannonCrew.length > 0
    ? Math.round(cannonCrew.reduce((s, c) => s + c.gunnery, 0) / cannonCrew.length)
    : 0;
  const crewPiloting = crew.length > 0
    ? Math.round(crew.reduce((s, c) => s + c.piloting, 0) / crew.length)
    : 0;

  // Combat power computed server-side from DB — never trusted from client
  const cannons = rooms.filter(r => r.roomType === "turd_cannon");
  const combatPower = cannons.reduce((s, r) => s + [5, 10, 20][r.tier - 1], 0);

  return { userId, username, hullHp, maxHullHp: hullHp, rooms: combatRooms, crewGunnery, crewPiloting, combatPower };
}

// ---------------------------------------------------------------------------
// Execute one combat turn (attacker fires at defender)
// ---------------------------------------------------------------------------
function executeTurn(attacker: CombatShipState, defender: CombatShipState): string[] {
  const entries: string[] = [];
  const cannons = attacker.rooms.filter(r => r.roomType === "turd_cannon" && !r.destroyed);

  if (cannons.length === 0) {
    entries.push(`${attacker.username} has no Turd Cannons — misses!`);
    return entries;
  }

  const accuracy = Math.min(0.90, 0.60 + attacker.crewPiloting * 0.03);

  for (const cannon of cannons) {
    if (Math.random() > accuracy) {
      entries.push(`💩 ${attacker.username} fires Tier-${cannon.tier} cannon... MISS!`);
      continue;
    }

    const liveTargets = defender.rooms.filter(r => !r.destroyed);
    if (liveTargets.length === 0) break;

    const target = liveTargets[Math.floor(Math.random() * liveTargets.length)];
    const [dMin, dMax] = CANNON_DAMAGE_RANGE[cannon.tier];
    let dmg = randInt(dMin, dMax);

    // Shield absorption — defender's shields
    const shields = defender.rooms.filter(r => r.roomType === "sphincter_shield" && !r.destroyed);
    if (shields.length > 0) {
      const bestShield = shields.reduce((best, s) => s.tier > best.tier ? s : best, shields[0]);
      const absorb = SHIELD_ABSORB[bestShield.tier];
      const absorbed = Math.round(dmg * absorb);
      dmg -= absorbed;
      entries.push(`🛡️ Sphincter Shield absorbs ${absorbed} damage!`);
    }

    dmg = Math.max(1, dmg);
    target.hp = Math.max(0, target.hp - dmg);

    if (target.hp === 0 && !target.destroyed) {
      target.destroyed = true;
      entries.push(`💥 ${attacker.username} destroys ${defender.username}'s ${target.roomType.replace(/_/g, " ")} (pos ${target.position})! (${dmg} dmg)`);
    } else {
      entries.push(`💩 ${attacker.username} hits ${defender.username}'s ${target.roomType.replace(/_/g, " ")} for ${dmg} dmg (${target.hp}/${target.maxHp} HP)`);
    }
  }

  // Recalculate defender hull
  const liveRoomHp = defender.rooms.filter(r => !r.destroyed).reduce((s, r) => s + r.hp, 0);
  defender.hullHp = BASE_HULL + liveRoomHp;

  return entries;
}

// ---------------------------------------------------------------------------
// Award battle results — writes to verified server-side userId only
// ---------------------------------------------------------------------------
async function awardBattleResults(
  winnerId: string,
  loserId: string,
  instanceId: string,
) {
  const WIN_NUGGETS  = 200;
  const LOSS_NUGGETS = 25;
  const WIN_XP = 10;

  try {
    await Promise.all([
      db.update(pooShipsTable)
        .set({ nuggets: sql`nuggets + ${WIN_NUGGETS}`, updatedAt: new Date() })
        .where(eq(pooShipsTable.userId, winnerId)),
      db.update(pooShipsTable)
        .set({ nuggets: sql`nuggets + ${LOSS_NUGGETS}`, updatedAt: new Date() })
        .where(eq(pooShipsTable.userId, loserId)),
    ]);

    // Write XP to Poopy RPG SQLite (best-effort)
    try {
      const sqlite = new BetterSqlite3(POOP_DB_PATH);
      sqlite.prepare("UPDATE user_stats SET xp = xp + ? WHERE user_id = ?").run(WIN_XP, winnerId);
      sqlite.close();
    } catch { /* poop_tracker.db may not exist in all environments */ }

    // Add flotilla log for both players + increment weekly wins for winner's flotilla
    try {
      const members = await db.select().from(flotillaMembersTable)
        .where(sql`user_id IN (${winnerId}, ${loserId})`);
      const flotillaIds = [...new Set(members.map(m => m.flotillaId))];

      for (const fId of flotillaIds) {
        await db.insert(flotillaLogsTable).values({
          flotillaId: fId,
          message: `⚔️ Battle: <@${winnerId}> defeated <@${loserId}> and earned +${WIN_NUGGETS} Nuggets!`,
        });
      }

      // Increment weekly wins for the winner's flotilla
      const winnerMember = members.find(m => m.userId === winnerId);
      if (winnerMember) {
        await db.update(flotillasTable)
          .set({ weeklyWins: sql`weekly_wins + 1` })
          .where(eq(flotillasTable.id, winnerMember.flotillaId));
      }
    } catch { /* ignore */ }
  } catch (err) {
    logger.error({ err }, "Failed to award battle results");
  }

  logger.info({ winnerId, loserId, instanceId }, "Battle results awarded");
}

// ---------------------------------------------------------------------------
// Battle session DB persistence helpers
// ---------------------------------------------------------------------------
async function persistBattle(session: BattleSession): Promise<void> {
  const b = session.activeBattle;
  if (!b) return;
  try {
    const stateJson = JSON.stringify({
      attacker: stripWs(b.attacker),
      defender: stripWs(b.defender),
      log: b.log.slice(-30),
    });
    // Find an existing active row for this instance then update; otherwise insert.
    const existing = await db.query.ppsBattleSessionsTable.findFirst({
      where: and(
        eq(ppsBattleSessionsTable.instanceId, session.instanceId),
        eq(ppsBattleSessionsTable.status, "active"),
      ),
    });
    if (existing) {
      await db.update(ppsBattleSessionsTable)
        .set({ attackerId: b.attackerId, defenderId: b.defenderId, stateJson, turn: b.turn, updatedAt: new Date() })
        .where(eq(ppsBattleSessionsTable.id, existing.id));
    } else {
      await db.insert(ppsBattleSessionsTable).values({
        instanceId: session.instanceId,
        attackerId: b.attackerId,
        defenderId: b.defenderId,
        stateJson,
        status: "active",
        turn: b.turn,
      });
    }
  } catch (err) {
    logger.warn({ err }, "Failed to persist battle session");
  }
}

async function markBattleEnded(instanceId: string): Promise<void> {
  try {
    await db.update(ppsBattleSessionsTable)
      .set({ status: "ended", updatedAt: new Date() })
      .where(
        and(
          eq(ppsBattleSessionsTable.instanceId, instanceId),
          eq(ppsBattleSessionsTable.status, "active"),
        ),
      );
  } catch (err) {
    logger.warn({ err }, "Failed to mark battle session ended");
  }
}

async function loadPersistedBattle(instanceId: string): Promise<ActiveBattle | null> {
  try {
    const row = await db.query.ppsBattleSessionsTable.findFirst({
      where: and(
        eq(ppsBattleSessionsTable.instanceId, instanceId),
        eq(ppsBattleSessionsTable.status, "active"),
      ),
    });
    if (!row) return null;

    // Only restore if the session is fresh (< 30 min)
    const ageMs = Date.now() - row.startedAt.getTime();
    if (ageMs > 30 * 60 * 1000) {
      await markBattleEnded(instanceId);
      return null;
    }

    const state = JSON.parse(row.stateJson) as {
      attacker: CombatShipState;
      defender: CombatShipState;
      log: string[];
    };
    return {
      attackerId: row.attackerId,
      defenderId: row.defenderId,
      attacker: state.attacker,
      defender: state.defender,
      turn: row.turn,
      log: state.log,
      startedAt: row.startedAt,
    };
  } catch (err) {
    logger.warn({ err }, "Failed to load persisted battle session");
    return null;
  }
}

// ---------------------------------------------------------------------------
// WS session registry
// ---------------------------------------------------------------------------
const sessions = new Map<string, BattleSession>();

async function getOrCreateSession(instanceId: string): Promise<BattleSession> {
  let session = sessions.get(instanceId);
  if (!session) {
    session = { instanceId, players: new Map(), pendingChallenge: null, activeBattle: null };
    // Attempt to restore an in-progress battle from DB
    const persisted = await loadPersistedBattle(instanceId);
    if (persisted) {
      session.activeBattle = persisted;
      logger.info({ instanceId, turn: persisted.turn }, "Restored battle session from DB");
    }
    sessions.set(instanceId, session);
  }
  return session;
}

function sendTo(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastLobby(session: BattleSession) {
  const lobby = Array.from(session.players.values()).map(p => ({
    userId: p.userId,
    username: p.username,
    combatPower: p.combatPower,
  }));
  for (const p of session.players.values()) {
    sendTo(p.ws, { type: "lobby", players: lobby });
  }
}

function broadcastBattleState(session: BattleSession) {
  const b = session.activeBattle!;
  const state = {
    type: "battle_state",
    attackerId: b.attackerId,
    defenderId: b.defenderId,
    attacker: stripWs(b.attacker),
    defender: stripWs(b.defender),
    turn: b.turn,
    log: b.log.slice(-20),
  };
  for (const p of session.players.values()) {
    sendTo(p.ws, state);
  }
}

function stripWs(ship: CombatShipState) {
  return {
    userId: ship.userId,
    username: ship.username,
    hullHp: ship.hullHp,
    maxHullHp: ship.maxHullHp,
    rooms: ship.rooms,
    combatPower: ship.combatPower,
    // Crew accuracy stats must be preserved so executeTurn() accuracy calc
    // (crewPiloting-based) stays valid after battle rehydration from DB.
    crewGunnery: ship.crewGunnery,
    crewPiloting: ship.crewPiloting,
  };
}

// ---------------------------------------------------------------------------
// Main WS message handler — verifiedUserId is always server-authoritative
// ---------------------------------------------------------------------------
async function handleMessage(
  ws: WebSocket,
  session: BattleSession,
  msg: Record<string, unknown>,
  verifiedUserId: string,
  verifiedUsername: string,
) {
  const type = msg["type"] as string;

  // ── join ──────────────────────────────────────────────────────────────────
  if (type === "join") {
    // Always use server-verified identity — ignore any client-sent userId/username/combatPower
    try {
      const state = await buildCombatState(verifiedUserId, verifiedUsername);
      session.players.set(verifiedUserId, {
        userId: verifiedUserId,
        username: verifiedUsername,
        combatPower: state.combatPower,  // always from DB
        ws,
      });
    } catch {
      // Ship may not exist yet; still let them join the lobby with 0 power
      session.players.set(verifiedUserId, { userId: verifiedUserId, username: verifiedUsername, combatPower: 0, ws });
    }

    logger.info({ instanceId: session.instanceId, userId: verifiedUserId }, "Player joined battle lobby");
    broadcastLobby(session);

    // If a persisted battle is active for this player (e.g. after server restart),
    // rehydrate their client so they can continue without re-challenging
    const b = session.activeBattle;
    if (b && (b.attackerId === verifiedUserId || b.defenderId === verifiedUserId)) {
      sendTo(ws, { type: "battle_start" });
      sendTo(ws, {
        type:       "battle_state",
        attackerId: b.attackerId,
        defenderId: b.defenderId,
        attacker:   stripWs(b.attacker),
        defender:   stripWs(b.defender),
        turn:       b.turn,
        log:        b.log.slice(-20),
      });
      logger.info({ instanceId: session.instanceId, userId: verifiedUserId, turn: b.turn }, "Rehydrated battle state for reconnecting player");
    }

    return;
  }

  // Sender identified by their verified server-side userId
  const sender = session.players.get(verifiedUserId);
  if (!sender) return;

  // ── challenge ─────────────────────────────────────────────────────────────
  if (type === "challenge") {
    const targetId = msg["targetUserId"] as string;
    if (!targetId || targetId === verifiedUserId) return;

    const target = session.players.get(targetId);
    if (!target) return;
    if (session.activeBattle) { sendTo(ws, { type: "error", message: "A battle is already in progress" }); return; }

    session.pendingChallenge = { challengerId: verifiedUserId, targetId };
    sendTo(target.ws, {
      type: "challenge_received",
      challengerId: verifiedUserId,
      challengerName: sender.username,
      challengerPower: sender.combatPower,
    });
    sendTo(ws, { type: "challenge_sent", targetId });
    return;
  }

  // ── accept ────────────────────────────────────────────────────────────────
  if (type === "accept") {
    const ch = session.pendingChallenge;
    if (!ch || ch.targetId !== verifiedUserId) return;

    const challenger = session.players.get(ch.challengerId);
    if (!challenger) { session.pendingChallenge = null; return; }

    session.pendingChallenge = null;

    try {
      const [attackerState, defenderState] = await Promise.all([
        buildCombatState(challenger.userId, challenger.username),
        buildCombatState(verifiedUserId, sender.username),
      ]);

      session.activeBattle = {
        attackerId: challenger.userId,
        defenderId: verifiedUserId,
        attacker: attackerState,
        defender: defenderState,
        turn: 1,
        log: ["⚔️ Battle begins!"],
        startedAt: new Date(),
      };

      for (const p of session.players.values()) {
        sendTo(p.ws, { type: "battle_start" });
      }
      broadcastBattleState(session);
      await persistBattle(session);
    } catch (err) {
      logger.error({ err }, "Failed to start battle");
      sendTo(ws, { type: "error", message: "Failed to load ship data" });
    }
    return;
  }

  // ── decline ───────────────────────────────────────────────────────────────
  if (type === "decline") {
    const ch = session.pendingChallenge;
    if (ch && ch.targetId === verifiedUserId) {
      const challenger = session.players.get(ch.challengerId);
      if (challenger) sendTo(challenger.ws, { type: "challenge_declined", by: verifiedUserId });
      session.pendingChallenge = null;
    }
    return;
  }

  // ── fire ──────────────────────────────────────────────────────────────────
  if (type === "fire") {
    const b = session.activeBattle;
    if (!b) return;
    if (b.attackerId !== verifiedUserId) { sendTo(ws, { type: "error", message: "Not your turn" }); return; }

    const entries = executeTurn(b.attacker, b.defender);
    b.log.push(...entries);
    b.turn++;

    // Check win
    if (b.defender.hullHp <= 0) {
      b.log.push(`🏆 ${b.attacker.username} wins the battle!`);
      const winnerId = b.attackerId;
      const loserId  = b.defenderId;
      const finalState = { ...b };
      session.activeBattle = null;

      for (const p of session.players.values()) {
        sendTo(p.ws, {
          type: "battle_end",
          winnerId,
          loserId,
          log: finalState.log.slice(-25),
          attacker: stripWs(finalState.attacker),
          defender: stripWs(finalState.defender),
          winnerNuggets: 200,
          loserNuggets: 25,
        });
      }
      await markBattleEnded(session.instanceId);
      await awardBattleResults(winnerId, loserId, session.instanceId);
      broadcastLobby(session);
      return;
    }

    // Swap attacker ↔ defender for next turn
    [b.attackerId, b.defenderId] = [b.defenderId, b.attackerId];
    [b.attacker, b.defender]     = [b.defender, b.attacker];
    broadcastBattleState(session);
    await persistBattle(session);
    return;
  }

  // ── forfeit ───────────────────────────────────────────────────────────────
  if (type === "forfeit") {
    const b = session.activeBattle;
    if (!b) return;
    if (b.attackerId !== verifiedUserId && b.defenderId !== verifiedUserId) return;

    const loserId  = verifiedUserId;
    const winnerId = b.attackerId === loserId ? b.defenderId : b.attackerId;
    b.log.push(`🏳️ ${sender.username} forfeits!`);
    session.activeBattle = null;

    for (const p of session.players.values()) {
      sendTo(p.ws, { type: "battle_end", winnerId, loserId, log: b.log.slice(-10), winnerNuggets: 200, loserNuggets: 25 });
    }
    await markBattleEnded(session.instanceId);
    await awardBattleResults(winnerId, loserId, session.instanceId);
    broadcastLobby(session);
    return;
  }
}

// ---------------------------------------------------------------------------
// Export: PooBattle WebSocket server
// ---------------------------------------------------------------------------
export const pooBattleWss = new WebSocketServer({ noServer: true });

type VerifiedReq = IncomingMessage & { _verifiedUserId?: string; _verifiedUsername?: string };

pooBattleWss.on("connection", async (ws: WebSocket, req: VerifiedReq) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const instanceId = url.searchParams.get("instanceId") ?? "dev-instance";

  // Identity is server-verified by index.ts during upgrade; reject if missing
  const verifiedUserId = req._verifiedUserId;
  const verifiedUsername = req._verifiedUsername ?? "Pilot";
  if (!verifiedUserId) {
    ws.close(4401, "Unauthorized");
    return;
  }

  const session = await getOrCreateSession(instanceId);

  ws.on("message", async (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString()) as Record<string, unknown>;
      await handleMessage(ws, session, msg, verifiedUserId, verifiedUsername);
    } catch (err) {
      logger.error({ err }, "pooBattle message error");
    }
  });

  ws.on("close", async () => {
    // If mid-battle, auto-forfeit the disconnected player so the session never deadlocks
    const b = session.activeBattle;
    if (b && (b.attackerId === verifiedUserId || b.defenderId === verifiedUserId)) {
      const loserId  = verifiedUserId;
      const winnerId = b.attackerId === loserId ? b.defenderId : b.attackerId;
      const leavingName = session.players.get(loserId)?.username ?? "Unknown";
      b.log.push(`🔌 ${leavingName} disconnected — auto-forfeit!`);
      session.activeBattle = null;
      session.players.delete(verifiedUserId);

      // Notify remaining players of the result
      for (const p of session.players.values()) {
        sendTo(p.ws, {
          type: "battle_end",
          winnerId, loserId,
          log: b.log.slice(-10),
          winnerNuggets: 200,
          loserNuggets: 25,
        });
      }
      await markBattleEnded(session.instanceId);
      await awardBattleResults(winnerId, loserId, session.instanceId);
    } else {
      session.players.delete(verifiedUserId);
    }

    // Clear any pending challenge that involved this player
    if (
      session.pendingChallenge &&
      (session.pendingChallenge.challengerId === verifiedUserId ||
        session.pendingChallenge.targetId === verifiedUserId)
    ) {
      const ch = session.pendingChallenge;
      session.pendingChallenge = null;
      const otherId = ch.challengerId === verifiedUserId ? ch.targetId : ch.challengerId;
      const other = session.players.get(otherId);
      if (other) sendTo(other.ws, { type: "challenge_declined", by: verifiedUserId });
    }

    logger.info({ instanceId, userId: verifiedUserId }, "Player left battle lobby");
    broadcastLobby(session);

    if (session.players.size === 0) {
      sessions.delete(instanceId);
    }
  });

  ws.on("error", () => { /* handled by close */ });
});
