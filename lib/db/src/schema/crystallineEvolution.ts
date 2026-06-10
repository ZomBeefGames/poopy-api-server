/**
 * crystallineEvolution.ts — Postgres tables for the Crystalline Evolver system.
 *
 * Why Postgres (not SQLite): evolver data must survive api-server restarts and
 * be queryable across sessions. Genomes, champions, and rules are the three
 * durable stores that the evolver reads/writes — all other evolver state is
 * ephemeral and lives in-process only.
 *
 * Tables:
 *  - crystal_genomes        : every evaluated genome candidate with fitness score
 *  - crystal_champions      : current best genome per domain (upserted on promotion)
 *  - crystal_rules          : learned gene-effect rules used to bias mutation
 *  - evolver_generations    : one row per completed generation
 *  - evolver_population     : one row per genome in a generation
 *  - config_snapshots       : pre-injection config snapshots (rollback targets)
 *  - pending_injections     : Level 3 human approval queue
 *  - injection_audit_log    : every injection and rollback event
 *  - evolver_crystals       : elite champion benchmark results (dual-stream)
 *
 * Stage A only — no FK constraints between tables deliberately. The evolver
 * treats these as independent stores accessed only through ScopedDb (Stage A).
 */

import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// ── crystal_genomes ────────────────────────────────────────────────────────────
// One row per evaluated genome. Ring-buffer enforced by pruneGenomes (ScopedDb).
// genome JSONB matches the Genome interface in crystallineEvolver.ts.
// fitness is the composite score [0..1] from Stage B evaluation.
// tokenless_resolved: true when a tokenless pipeline hit resolved this genome
// instead of an AI call (Stage B adds this path).
// token_efficiency / completion_rate: multi-objective fitness components (Task #489).
export const crystalGenomesTable = pgTable("crystal_genomes", {
  id:                  serial("id").primaryKey(),
  domain:              text("domain"),
  generation:          integer("generation").notNull().default(0),
  genome:              jsonb("genome").notNull(),
  fitness:             real("fitness").notNull().default(0),
  tokens_used:         integer("tokens_used").notNull().default(0),
  quality_score:       real("quality_score").notNull().default(0),
  tokenless_resolved:  boolean("tokenless_resolved").notNull().default(false),
  resolved_by:         text("resolved_by"),
  token_efficiency:    real("token_efficiency"),
  completion_rate:     real("completion_rate"),
  created_at:          timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type CrystalGenome    = typeof crystalGenomesTable.$inferSelect;
export type NewCrystalGenome = typeof crystalGenomesTable.$inferInsert;

// ── crystal_champions ──────────────────────────────────────────────────────────
// One row per domain — always the current best genome. Upserted on promotion.
// domain is UNIQUE so there is exactly one champion per domain at all times.
// node: which Railway/cluster node promoted this champion (Stage E field, nullable now).
// shadow_fitness / shadow_generations: Task #489 shadow mode tracking.
// anti_champion_genome: Task #489 worst-known genome per domain.
export const crystalChampionsTable = pgTable("crystal_champions", {
  id:                   serial("id").primaryKey(),
  domain:               text("domain").notNull().unique(),
  genome:               jsonb("genome").notNull(),
  fitness:              real("fitness").notNull(),
  generation:           integer("generation").notNull().default(0),
  node:                 text("node"),
  runner_up_genome:     jsonb("runner_up_genome"),
  shadow_fitness:       real("shadow_fitness"),
  shadow_generations:   integer("shadow_generations"),
  anti_champion_genome: jsonb("anti_champion_genome"),
  promoted_at:          timestamp("promoted_at", { withTimezone: true }).defaultNow().notNull(),
  // Task #508: Gladiator Suit — crystallization tracking
  crystallized:            boolean("crystallized").notNull().default(false),
  armor_crystallized_at:   timestamp("armor_crystallized_at", { withTimezone: true }),
});

export type CrystalChampion    = typeof crystalChampionsTable.$inferSelect;
export type NewCrystalChampion = typeof crystalChampionsTable.$inferInsert;

// ── crystal_rules ──────────────────────────────────────────────────────────────
// Learned associations between gene values and fitness delta.
// pattern JSONB: { gene: keyof Genome, value: string|number } — the gene-value pair.
// effect: observed average fitness delta when this gene-value appears (positive = helps).
// sample_count: number of genomes this rule was derived from — weight by this.
// Updated by the rule extractor in Stage B after each evaluation batch.
export const crystalRulesTable = pgTable("crystal_rules", {
  id:           serial("id").primaryKey(),
  domain:       text("domain").notNull(),
  pattern:      jsonb("pattern").notNull(),
  effect:       real("effect").notNull(),
  sample_count: integer("sample_count").notNull().default(1),
  updated_at:   timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type CrystalRule    = typeof crystalRulesTable.$inferSelect;
export type NewCrystalRule = typeof crystalRulesTable.$inferInsert;

// ── evolver_generations ────────────────────────────────────────────────────────
// One row per completed (or failed/timeout) generation. Boot-resume reads the
// most recent completed row to restore the population without re-seeding.
// status: "completed" | "failed" | "timeout"
export const evolverGenerationsTable = pgTable("evolver_generations", {
  id:              serial("id").primaryKey(),
  domain:          text("domain").notNull(),
  generation:      integer("generation").notNull(),
  status:          text("status").notNull().default("completed"),
  best_fitness:    real("best_fitness").notNull().default(0),
  genome_count:    integer("genome_count").notNull().default(0),
  variance:        real("variance").default(0),
  node:            text("node"),
  benchmark_index: integer("benchmark_index"),
  created_at:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  // getLastCompletedGeneration: WHERE domain=? AND status=? ORDER BY created_at DESC LIMIT 1
  index("evolver_generations_domain_status_created_idx").on(t.domain, t.status, t.created_at),
]);

export type EvolverGeneration    = typeof evolverGenerationsTable.$inferSelect;
export type NewEvolverGeneration = typeof evolverGenerationsTable.$inferInsert;

// ── evolver_population ─────────────────────────────────────────────────────────
// One row per genome in a generation. alive=true = survivor; alive=false = eliminated
// (bottom-half selection). Boot-resume loads alive=true rows for the last completed
// generation — ensures Railway restarts continue evolution instead of restarting.
export const evolverPopulationTable = pgTable("evolver_population", {
  id:             serial("id").primaryKey(),
  generation_id:  integer("generation_id").notNull(),
  domain:         text("domain").notNull(),
  genome:         jsonb("genome").notNull(),
  fitness:        real("fitness").notNull().default(0),
  alive:          boolean("alive").notNull().default(true),
  // Fitness component breakdown: { completion, quality, tokenEfficiency, latency } — nullable for rows
  // inserted before this column existed and for tokenless-resolved genomes.
  components:     jsonb("components"),
  created_at:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  // getAlivePopulation: WHERE generation_id=? AND alive=true ORDER BY fitness DESC
  index("evolver_population_gen_alive_fitness_idx").on(t.generation_id, t.alive, t.fitness),
]);

export type EvolverPopulation    = typeof evolverPopulationTable.$inferSelect;
export type NewEvolverPopulation = typeof evolverPopulationTable.$inferInsert;

// ── config_snapshots ──────────────────────────────────────────────────────────
// Pre-injection config snapshots. Written before every injection as rollback target.
// type: genome type name (e.g. "prompt-evolver", "tool-selection-evolver").
// config: the full champion genome JSON being replaced.
// quality_baseline: rolling 10-task quality average at injection time.
export const configSnapshotsTable = pgTable("config_snapshots", {
  id:              serial("id").primaryKey(),
  type:            text("type").notNull(),
  config:          jsonb("config").notNull(),
  quality_baseline: real("quality_baseline").notNull().default(0),
  created_at:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("config_snapshots_type_created_idx").on(t.type, t.created_at),
]);

export type ConfigSnapshot    = typeof configSnapshotsTable.$inferSelect;
export type NewConfigSnapshot = typeof configSnapshotsTable.$inferInsert;

// ── pending_injections ────────────────────────────────────────────────────────
// Level 3 human approval queue. Candidates write here instead of injecting.
// Admin panel shows the queue with Approve / Reject buttons.
export const pendingInjectionsTable = pgTable("pending_injections", {
  id:               serial("id").primaryKey(),
  type:             text("type").notNull(),
  genome:           jsonb("genome").notNull(),
  candidate_fitness: real("candidate_fitness").notNull(),
  current_fitness:  real("current_fitness").notNull().default(0),
  approved_at:      timestamp("approved_at", { withTimezone: true }),
  approved_by:      text("approved_by"),
  created_at:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type PendingInjection    = typeof pendingInjectionsTable.$inferSelect;
export type NewPendingInjection = typeof pendingInjectionsTable.$inferInsert;

// ── injection_audit_log ───────────────────────────────────────────────────────
// Every injection and rollback event. Written by the injection pipeline and rollback
// watchdog. Exposed via GET /api/crystalline/injection-log.
export const injectionAuditLogTable = pgTable("injection_audit_log", {
  id:             serial("id").primaryKey(),
  type:           text("type").notNull(),
  level:          integer("level").notNull().default(1),
  genome_before:  jsonb("genome_before"),
  genome_after:   jsonb("genome_after").notNull(),
  fitness_before: real("fitness_before"),
  fitness_after:  real("fitness_after").notNull(),
  rolled_back:    boolean("rolled_back").notNull().default(false),
  rolled_back_at: timestamp("rolled_back_at", { withTimezone: true }),
  created_at:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("injection_audit_log_created_idx").on(t.created_at),
]);

export type InjectionAuditLog    = typeof injectionAuditLogTable.$inferSelect;
export type NewInjectionAuditLog = typeof injectionAuditLogTable.$inferInsert;

// ── evolver_crystals ──────────────────────────────────────────────────────────
// Elite crystal stream: champion + runner-up benchmark results after each generation.
// Hard separation: evolver writes here; ZomBrains task execution NEVER writes here.
// source is always 'elite'. champion_rank: 1 = champion, 2 = runner-up.
// Rate cap: max 2 elite evaluations per domain per hour enforced in crystallineEvolver.ts.
export const evolverCrystalsTable = pgTable("evolver_crystals", {
  id:            serial("id").primaryKey(),
  domain:        text("domain").notNull(),
  generation:    integer("generation").notNull(),
  genome:        jsonb("genome").notNull(),
  quality_score: real("quality_score").notNull().default(0),
  fitness:       real("fitness").notNull().default(0),
  task_text:     text("task_text"),
  response_text: text("response_text"),
  champion_rank: integer("champion_rank").notNull().default(1),
  source:        text("source").notNull().default("elite"),
  created_at:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("evolver_crystals_domain_created_idx").on(t.domain, t.created_at),
]);

export type EvolverCrystal    = typeof evolverCrystalsTable.$inferSelect;
export type NewEvolverCrystal = typeof evolverCrystalsTable.$inferInsert;

// ── evolver_fitness_distributions (Task #493 Step 1) ──────────────────────────
// Tracks fitness as a distribution (mean + variance) per genome+domain using
// Welford's online algorithm — no array storage, O(1) update per evaluation.
// genome_hash: SHA-256(JSON.stringify(genome)) truncated to 16 hex chars.
// natural: true = organic evaluation; false = diversity-injection run.
// Only natural evaluations contribute to the noise floor calibration.
export const evolverFitnessDistributionsTable = pgTable("evolver_fitness_distributions", {
  id:                serial("id").primaryKey(),
  genome_hash:       text("genome_hash").notNull(),
  domain:            text("domain").notNull(),
  mean:              real("mean").notNull().default(0),
  variance:          real("variance").notNull().default(0),
  sample_count:      integer("sample_count").notNull().default(0),
  natural_count:     integer("natural_count").notNull().default(0),
  last_generation:   integer("last_generation").notNull().default(0),
  updated_at:        timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("evolver_fitness_dist_hash_domain_idx").on(t.genome_hash, t.domain),
  index("evolver_fitness_dist_domain_idx").on(t.domain),
]);

export type EvolverFitnessDistribution    = typeof evolverFitnessDistributionsTable.$inferSelect;
export type NewEvolverFitnessDistribution = typeof evolverFitnessDistributionsTable.$inferInsert;

// ── evolver_noise_model (Task #493 Steps 2-6, 12) ────────────────────────────
// One row per domain. Central store for the landscape model state:
//   noise_floor:          stddev of natural fitness scores for the domain
//   epsilon:              current ε for ε-greedy selection (0..1, starts 1.0)
//   epsilon_min:          floor for ε decay (configurable, default 0.15)
//   model_confidence:     1 - (mean_prediction_variance / max_observed_variance)
//   cooccurrence_json:    serialised GeneCooccurrenceModel frequency table per domain
//   staleness_ratio:      fraction of model data older than STALENESS_WINDOW gens
//   saturated:            true when champion fitness has been flat for 3 checks
//   saturation_checks:    consecutive saturation checks passed
//   natural_eval_count:   total natural evaluations this domain has had
//   divergence_log_json:  last 20 {benchmarkFitness, rollbackOccurred, generation} records
//   updated_at:           last time any field was updated
export const evolverNoiseModelTable = pgTable("evolver_noise_model", {
  id:                  serial("id").primaryKey(),
  domain:              text("domain").notNull().unique(),
  noise_floor:         real("noise_floor").notNull().default(0),
  epsilon:             real("epsilon").notNull().default(1.0),
  epsilon_min:         real("epsilon_min").notNull().default(0.15),
  model_confidence:    real("model_confidence").notNull().default(0),
  cooccurrence_json:   jsonb("cooccurrence_json"),
  staleness_ratio:     real("staleness_ratio").notNull().default(0),
  saturated:           boolean("saturated").notNull().default(false),
  saturation_checks:   integer("saturation_checks").notNull().default(0),
  natural_eval_count:  integer("natural_eval_count").notNull().default(0),
  divergence_log_json: jsonb("divergence_log_json"),
  updated_at:          timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type EvolverNoiseModel    = typeof evolverNoiseModelTable.$inferSelect;
export type NewEvolverNoiseModel = typeof evolverNoiseModelTable.$inferInsert;

// ── evolver_rollback_events (Task #493 Step 7) ───────────────────────────────
// Written by the injection pipeline whenever a champion injection is rolled back.
// Used by mineRiskyGenes() to identify gene combinations that consistently fail.
export const evolverRollbackEventsTable = pgTable("evolver_rollback_events", {
  id:                  serial("id").primaryKey(),
  domain:              text("domain").notNull(),
  genome_snapshot:     jsonb("genome_snapshot").notNull(),
  rollback_reason:     text("rollback_reason"),
  fitness_at_injection: real("fitness_at_injection").notNull().default(0),
  created_at:          timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("evolver_rollback_events_domain_idx").on(t.domain, t.created_at),
]);

export type EvolverRollbackEvent    = typeof evolverRollbackEventsTable.$inferSelect;
export type NewEvolverRollbackEvent = typeof evolverRollbackEventsTable.$inferInsert;

// ── evolver_risky_genes (Task #493 Step 7) ───────────────────────────────────
// Gene-value pairs that appear in ≥ 40% of rollback events for a domain.
// Injection candidate generation avoids these unless no safe alternative exists.
// rollback_count: how many rollback events this gene-value appeared in.
export const evolverRiskyGenesTable = pgTable("evolver_risky_genes", {
  id:            serial("id").primaryKey(),
  domain:        text("domain").notNull(),
  gene_key:      text("gene_key").notNull(),
  gene_value:    text("gene_value").notNull(),
  rollback_count: integer("rollback_count").notNull().default(1),
  last_seen_at:  timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("evolver_risky_genes_domain_idx").on(t.domain),
]);

export type EvolverRiskyGene    = typeof evolverRiskyGenesTable.$inferSelect;
export type NewEvolverRiskyGene = typeof evolverRiskyGenesTable.$inferInsert;

// ── evolver_adversarial_cases (Task #493 Step 8) ─────────────────────────────
// Per-domain adversarial test set: the 20 benchmark cases that produced the worst
// outcomes (bottom 10% fitness). Champion promotion must score ≥ noise_floor above
// the historical average on these cases. TTL: ADVERSARIAL_TTL gens (default 50).
export const evolverAdversarialCasesTable = pgTable("evolver_adversarial_cases", {
  id:                serial("id").primaryKey(),
  domain:            text("domain").notNull(),
  benchmark_index:   integer("benchmark_index").notNull(),
  task_text:         text("task_text").notNull(),
  baseline_fitness:  real("baseline_fitness").notNull().default(0),
  worst_genome:      jsonb("worst_genome"),
  created_generation: integer("created_generation").notNull().default(0),
  created_at:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("evolver_adversarial_domain_idx").on(t.domain, t.created_generation),
]);

export type EvolverAdversarialCase    = typeof evolverAdversarialCasesTable.$inferSelect;
export type NewEvolverAdversarialCase = typeof evolverAdversarialCasesTable.$inferInsert;

// ── evolver_transfer_map (Task #493 Step 9) ──────────────────────────────────
// Cross-domain collaboration transfer failures. Penalty weight decays as
// exp(-generation_distance / DECAY_CONSTANT). Old failures fade instead of
// permanently blocking transfer paths.
export const evolverTransferMapTable = pgTable("evolver_transfer_map", {
  id:               serial("id").primaryKey(),
  source_domain:    text("source_domain").notNull(),
  target_domain:    text("target_domain").notNull(),
  source_generation: integer("source_generation").notNull().default(0),
  target_generation: integer("target_generation").notNull().default(0),
  failure_reason:   text("failure_reason"),
  created_at:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("evolver_transfer_map_target_idx").on(t.target_domain, t.created_at),
]);

export type EvolverTransferMap    = typeof evolverTransferMapTable.$inferSelect;
export type NewEvolverTransferMap = typeof evolverTransferMapTable.$inferInsert;

// ── evolver_counterfactual_log (Task #493 Step 10) ───────────────────────────
// For every ε-greedy targeted selection, logs what the random choice would have
// been. Fitness outcomes filled in after the generation completes. If targeted
// consistently underperforms random over 50 decisions, ε auto-resets to 0.9.
export const evolverCounterfactualLogTable = pgTable("evolver_counterfactual_log", {
  id:                      serial("id").primaryKey(),
  domain:                  text("domain").notNull(),
  decision_generation:     integer("decision_generation").notNull().default(0),
  targeted_genome:         jsonb("targeted_genome").notNull(),
  random_genome:           jsonb("random_genome").notNull(),
  targeted_promisingness:  real("targeted_promisingness").notNull().default(0),
  random_promisingness:    real("random_promisingness").notNull().default(0),
  targeted_fitness:        real("targeted_fitness"),
  random_fitness:          real("random_fitness"),
  evaluated:               boolean("evaluated").notNull().default(false),
  created_at:              timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("evolver_counterfactual_domain_gen_idx").on(t.domain, t.decision_generation),
]);

export type EvolverCounterfactualLog    = typeof evolverCounterfactualLogTable.$inferSelect;
export type NewEvolverCounterfactualLog = typeof evolverCounterfactualLogTable.$inferInsert;

// ── evolver_tournament_log (Task #508 Step 1) ────────────────────────────────
// Records each 1v1 gladiator matchup — winner, loser, judge reasoning.
// winner_hash / loser_hash: MD5-style hash of genome JSON (first 16 chars of JSON).
// resolved_by: always 'gladiator' for tournament rounds.
export const evolverTournamentLogTable = pgTable("evolver_tournament_log", {
  id:           serial("id").primaryKey(),
  domain:       text("domain").notNull(),
  generation:   integer("generation").notNull().default(0),
  winner_hash:  text("winner_hash").notNull(),
  loser_hash:   text("loser_hash").notNull(),
  judge_reason: text("judge_reason"),
  resolved_by:  text("resolved_by").notNull().default("gladiator"),
  ts:           timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("evolver_tournament_domain_gen_idx").on(t.domain, t.generation),
]);

export type EvolverTournamentLog    = typeof evolverTournamentLogTable.$inferSelect;
export type NewEvolverTournamentLog = typeof evolverTournamentLogTable.$inferInsert;
