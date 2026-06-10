import { pgTable, text, integer, boolean, timestamp, serial, uniqueIndex } from "drizzle-orm/pg-core";
import { sql as sqlExpr } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const pooShipsTable = pgTable("poo_ships", {
  userId:            text("user_id").primaryKey(),
  nuggets:           integer("nuggets").notNull().default(100),
  hullHp:            integer("hull_hp").notNull().default(100),
  maxHullHp:         integer("max_hull_hp").notNull().default(100),
  poolRefreshCount:  integer("pool_refresh_count").notNull().default(0),
  captainName:       text("captain_name"),
  shipClass:         text("ship_class"),
  discordUsername:   text("discord_username"),
  isOnboarded:       boolean("is_onboarded").notNull().default(false),
  totalNuggets:      integer("total_nuggets").notNull().default(0),
  missionsCompleted: integer("missions_completed").notNull().default(0),
  createdAt:         timestamp("created_at").defaultNow().notNull(),
  updatedAt:         timestamp("updated_at").defaultNow().notNull(),
});

export const shipRoomsTable = pgTable("ship_rooms", {
  id:              serial("id").primaryKey(),
  userId:          text("user_id").notNull().references(() => pooShipsTable.userId, { onDelete: "cascade" }),
  position:        integer("position").notNull(),
  roomType:        text("room_type").notNull(),
  tier:            integer("tier").notNull().default(1),
  lastHarvestedAt: timestamp("last_harvested_at").defaultNow(),
  storedNuggets:   integer("stored_nuggets").notNull().default(0),
  crewedBy:        integer("crewed_by"),
}, (t) => [
  uniqueIndex("ship_rooms_user_pos_idx").on(t.userId, t.position),
]);

export const shipCrewTable = pgTable("ship_crew", {
  id:           serial("id").primaryKey(),
  userId:       text("user_id").notNull().references(() => pooShipsTable.userId, { onDelete: "cascade" }),
  name:         text("name").notNull(),
  gunnery:      integer("gunnery").notNull(),
  piloting:     integer("piloting").notNull(),
  engineering:  integer("engineering").notNull(),
  medicine:     integer("medicine").notNull(),
  assignedRoom: integer("assigned_room"),
  isCapitan:    boolean("is_capitan").notNull().default(false),
  combatPerk:   text("combat_perk"),
  econPerk:     text("econ_perk"),
});

export const flotillasTable = pgTable("flotillas", {
  id:          serial("id").primaryKey(),
  name:        text("name").notNull(),
  tag:         text("tag").notNull().unique(),
  weeklyWins:  integer("weekly_wins").notNull().default(0),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
});

export const flotillaMembersTable = pgTable("flotilla_members", {
  id:         serial("id").primaryKey(),
  flotillaId: integer("flotilla_id").notNull().references(() => flotillasTable.id, { onDelete: "cascade" }),
  userId:     text("user_id").notNull().references(() => pooShipsTable.userId, { onDelete: "cascade" }),
  role:       text("role").notNull().default("member"),
  joinedAt:   timestamp("joined_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("flotilla_members_user_idx").on(t.userId),
]);

export const flotillaLogsTable = pgTable("flotilla_logs", {
  id:         serial("id").primaryKey(),
  flotillaId: integer("flotilla_id").notNull().references(() => flotillasTable.id, { onDelete: "cascade" }),
  message:    text("message").notNull(),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
});

export const explorationMissionsTable = pgTable("exploration_missions", {
  id:             serial("id").primaryKey(),
  userId:         text("user_id").notNull().references(() => pooShipsTable.userId, { onDelete: "cascade" }),
  missionKey:     text("mission_key").notNull(),
  difficulty:     text("difficulty").notNull(),
  durationMin:    integer("duration_min").notNull(),
  snapshotPower:  integer("snapshot_power").notNull().default(0),
  startedAt:      timestamp("started_at").defaultNow().notNull(),
  completesAt:    timestamp("completes_at").notNull(),
  status:         text("status").notNull().default("active"),
  rewardJson:     text("reward_json"),
});

// Timed territorial claiming — one active holder per sector, unlimited secured per player
export const pooShipSectorsTable = pgTable("poo_ship_sectors", {
  id:        serial("id").primaryKey(),
  userId:    text("user_id").notNull().references(() => pooShipsTable.userId, { onDelete: "cascade" }),
  sectorId:  text("sector_id").notNull(),
  status:    text("status").notNull().default("pending"),
  username:  text("username").notNull().default(""),
  claimedAt: timestamp("claimed_at").defaultNow().notNull(),
  securedAt: timestamp("secured_at"),
}, (t) => [
  uniqueIndex("poo_ship_sectors_sector_idx").on(t.sectorId),
  uniqueIndex("poo_ship_sectors_one_pending_per_user_idx").on(t.userId).where(sqlExpr`${t.status} = 'pending'`),
]);

export const ppsAchievementsTable = pgTable("pps_achievements", {
  id:            serial("id").primaryKey(),
  userId:        text("user_id").notNull().references(() => pooShipsTable.userId, { onDelete: "cascade" }),
  achievementId: text("achievement_id").notNull(),
  unlockedAt:    timestamp("unlocked_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("pps_achievements_user_ach_idx").on(t.userId, t.achievementId),
]);

// Persisted PvP battle sessions — one active session per instance at a time
export const ppsBattleSessionsTable = pgTable("pps_battle_sessions", {
  id:         serial("id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  attackerId: text("attacker_id").notNull(),
  defenderId: text("defender_id").notNull(),
  stateJson:  text("state_json").notNull(),
  status:     text("status").notNull().default("active"),
  turn:       integer("turn").notNull().default(1),
  startedAt:  timestamp("started_at").defaultNow().notNull(),
  updatedAt:  timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("pps_battle_sessions_active_instance_idx").on(t.instanceId).where(sqlExpr`${t.status} = 'active'`),
]);

export const insertPooShipSchema = createInsertSchema(pooShipsTable);
export const selectPooShipSchema = createSelectSchema(pooShipsTable);
export const insertShipRoomSchema = createInsertSchema(shipRoomsTable).omit({ id: true });
export const selectShipRoomSchema = createSelectSchema(shipRoomsTable);
export const insertShipCrewSchema = createInsertSchema(shipCrewTable).omit({ id: true });
export const selectShipCrewSchema = createSelectSchema(shipCrewTable);

export type PooShip = z.infer<typeof selectPooShipSchema>;
export type ShipRoom = z.infer<typeof selectShipRoomSchema>;
export type ShipCrew = z.infer<typeof selectShipCrewSchema>;
