import { pgTable, text, integer, boolean, bigint } from "drizzle-orm/pg-core";

export const playerStateTable = pgTable("player_state", {
  guildId:   text("guild_id").primaryKey(),
  slug:      text("slug"),
  idx:       integer("idx").notNull().default(0),
  playing:   boolean("playing").notNull().default(false),
  startedAt: bigint("started_at", { mode: "number" }),
  volume:    integer("volume").notNull().default(80),
  repeat:    text("repeat").notNull().default("all"),
  shuffle:   boolean("shuffle").notNull().default(false),
});

export type PlayerStateRow = typeof playerStateTable.$inferSelect;
