/**
 * crystallineEvolver.ts — Stage A: Foundation for the Crystalline Evolver system.
 *
 * Why this exists: ZomBrains currently uses a fixed provider/prompt strategy per
 * task type. The Crystalline Evolver applies an evolutionary algorithm to discover
 * the Genome (combination of provider, decomposition level, context style, prompt
 * style, temperature, and token budget) that maximises task quality per token across
 * different task domains. This file is Stage A — pure types, constants, and
 * stateless functions. No API calls, no generation loop, no DB side effects except
 * through the ScopedDb firewall.
 *
 * Stage B adds: evaluation engine, tokenless pipeline, provider execution wrapper.
 * Stage C adds: generation loop, guardrails, boot wiring.
 * Stage D adds: Monitor endpoints, admin panel.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  db as _db,
  eq,
  and,
  desc,
  asc,
  sql,
  crystalGenomesTable,
  crystalChampionsTable,
  crystalRulesTable,
  evolverGenerationsTable,
  evolverPopulationTable,
  configSnapshotsTable,
  pendingInjectionsTable,
  injectionAuditLogTable,
  evolverCrystalsTable,
  evolverFitnessDistributionsTable,
  evolverNoiseModelTable,
  evolverRollbackEventsTable,
  evolverRiskyGenesTable,
  evolverAdversarialCasesTable,
  evolverTransferMapTable,
  evolverCounterfactualLogTable,
  evolverTournamentLogTable,        // Task #508
  inArray,
  type ConfigSnapshot,
  type NewConfigSnapshot,
  type PendingInjection,
  type NewPendingInjection,
  type InjectionAuditLog,
  type NewInjectionAuditLog,
  type NewEvolverCrystal,
  type EvolverCrystal,
  type EvolverFitnessDistribution,
  type EvolverNoiseModel,
  type NewEvolverNoiseModel,
  type EvolverRollbackEvent,
  type NewEvolverRollbackEvent,
  type EvolverRiskyGene,
  type EvolverAdversarialCase,
  type NewEvolverAdversarialCase,
  type EvolverTransferMap,
  type NewEvolverTransferMap,
  type EvolverCounterfactualLog,
  type NewEvolverCounterfactualLog,
  type EvolverTournamentLog,        // Task #508
  type NewEvolverTournamentLog,     // Task #508
} from "@workspace/db";
import { getCooldownMs } from "./providers.js";
import { logger } from "./logger.js";
import { writeErrorLog } from "../middlewares/errorCapture.js";
// ── Gene option arrays ─────────────────────────────────────────────────────────
// These are the only valid values for each gene. Mutation and seed functions pick
// randomly from these arrays — never hardcode values elsewhere.

export const PROVIDERS = [
  "groq",
  "cerebras",
  "cerebras2",
  "feather",
  "gemini",
  "openrouter",
  "mistral",
  "sambanova",
] as const;

export const DECOMPOSE_OPTIONS = [1, 2, 3] as const;

export const CONTEXT_STYLES = ["minimal", "standard", "rich"] as const;

export const PROMPT_STYLES = ["direct", "chain-of-thought", "structured"] as const;

export const TEMPERATURES = [0.0, 0.3, 0.7, 1.0] as const;

export const MAX_TOKENS_OPTIONS    = [100, 200, 400] as const; // full mutation search space
export const DEFAULT_TOKEN_OPTIONS = [100, 200]       as const; // non-coding domains: short answers OK
export const CODING_TOKEN_OPTIONS  = [200, 400]       as const; // coding: needs room for real code

// ── Genome type ────────────────────────────────────────────────────────────────
// A Genome is a tuple of 6 genes. All genes are independent — crossover splits at
// any boundary, mutation changes exactly one gene. Gene order matters for crossover:
// provider, decompose, contextStyle, promptStyle, temperature, maxTokens.

export type Provider     = (typeof PROVIDERS)[number];
export type Decompose    = (typeof DECOMPOSE_OPTIONS)[number];
export type ContextStyle = (typeof CONTEXT_STYLES)[number];
export type PromptStyle  = (typeof PROMPT_STYLES)[number];
export type Temperature  = (typeof TEMPERATURES)[number];
export type MaxTokens    = (typeof MAX_TOKENS_OPTIONS)[number]; // 100 | 200 | 400

/** Per-domain maxTokens option set.
 *  Coding needs 200-400 tokens to write real code; diagnostic/planning/etc work at 100-200. */
export function domainMaxTokens(domain: string): readonly MaxTokens[] {
  return domain === 'coding' ? CODING_TOKEN_OPTIONS : DEFAULT_TOKEN_OPTIONS;
}

export interface Genome {
  provider:     Provider;
  decompose:    Decompose;
  contextStyle: ContextStyle;
  promptStyle:  PromptStyle;
  temperature:  Temperature;
  maxTokens:    MaxTokens;
}

// Ordered gene key list — used by mutate/crossover to iterate genes positionally.
// Do NOT reorder these without updating mutate and crossover logic.
const GENE_KEYS = [
  "provider",
  "decompose",
  "contextStyle",
  "promptStyle",
  "temperature",
  "maxTokens",
] as const satisfies (keyof Genome)[];

type GeneKey = (typeof GENE_KEYS)[number];

// Map each gene key to its options array — enables generic mutation.
const GENE_OPTIONS: { [K in GeneKey]: ReadonlyArray<Genome[K]> } = {
  provider:     PROVIDERS,
  decompose:    DECOMPOSE_OPTIONS,
  contextStyle: CONTEXT_STYLES,
  promptStyle:  PROMPT_STYLES,
  temperature:  TEMPERATURES,
  maxTokens:    MAX_TOKENS_OPTIONS,
};

// ── Anti-champion cache (Task #489) ────────────────────────────────────────────
// Updated after each generation; read synchronously by mutate() for repulsion.
// Declared before mutate so the reference is valid at parse time.
const _domainAntiChampion = new Map<string, Genome | null>();

// ── Pure genetic operations ────────────────────────────────────────────────────

/**
 * Return a new genome with exactly one randomly chosen gene mutated to a
 * different valid value. Never returns the same genome as the input.
 * Pure — no side effects.
 */
export function mutate(genome: Genome, genes = 1, domain?: string): Genome {
  // Shuffle gene keys so we pick `genes` distinct positions without replacement.
  const shuffled = ([...GENE_KEYS] as GeneKey[]).sort(() => Math.random() - 0.5);
  let result     = { ...genome };
  // Anti-champion repulsion: cached worst-known genome per domain (Task #489 step 14).
  const antiChamp = domain ? (_domainAntiChampion.get(domain) as Genome | undefined) : undefined;
  for (let i = 0; i < Math.min(genes, GENE_KEYS.length); i++) {
    const key     = shuffled[i]!;
    const options = GENE_OPTIONS[key] as ReadonlyArray<Genome[GeneKey]>;
    const others  = (options as readonly unknown[]).filter((v) => v !== result[key]);
    if (others.length > 0) {
      (result as Record<string, unknown>)[key] = others[Math.floor(Math.random() * others.length)];
      // Re-roll once if the mutated value matches the anti-champion's value for this gene.
      if (antiChamp && (antiChamp as unknown as Record<string, unknown>)[key] === (result as Record<string, unknown>)[key]) {
        const reroll = others.filter(v => v !== (antiChamp as unknown as Record<string, unknown>)[key]);
        if (reroll.length > 0) {
          (result as Record<string, unknown>)[key] = reroll[Math.floor(Math.random() * reroll.length)];
        }
      }
    }
  }
  return result;
}

/**
 * Splice two genomes at a random gene boundary.
 * Genes 0..splitIdx come from a, the remainder from b.
 * Pure — no side effects.
 */
export function crossover(a: Genome, b: Genome): Genome {
  const splitIdx = Math.floor(Math.random() * (GENE_KEYS.length - 1)) + 1;
  const result   = { ...a };
  for (let i = splitIdx; i < GENE_KEYS.length; i++) {
    const key = GENE_KEYS[i] as GeneKey;
    (result as Record<string, unknown>)[key] = b[key];
  }
  return result;
}

/**
 * Generate a starting population of `size` genomes for a domain.
 * Up to half the population is seeded from champion mutations (warm start).
 * The remainder is distributed evenly across providers (round-robin), then
 * randomises all non-provider genes. This guarantees provider spread before
 * any evaluation runs — no accidental Mistral monoculture at gen 1.
 * Pure — no side effects, no DB calls.
 */
export function seedPopulation(
  domain: string,
  size: number,
  champions: Genome[],
  availableProviders: readonly Provider[] = PROVIDERS,
): Genome[] {
  const population: Genome[] = [];
  const warmSlots = Math.floor(size / 2);
  const providers = availableProviders.length > 0 ? availableProviders : PROVIDERS;

  for (let i = 0; i < warmSlots && i < champions.length; i++) {
    population.push(mutate(champions[i]!));
  }

  // Round-robin across providers for all remaining slots so every provider
  // gets at least one representative regardless of champion composition.
  let slot = 0;
  while (population.length < size) {
    const provider = providers[slot % providers.length]!;
    slot++;
    population.push({
      provider,
      decompose:    pick(DECOMPOSE_OPTIONS),
      contextStyle: pick(CONTEXT_STYLES),
      promptStyle:  pick(PROMPT_STYLES),
      temperature:  pick(TEMPERATURES),
      maxTokens:    pick(domainMaxTokens(domain)),
    });
  }

  return population;
}

function randomGenome(domain: string = 'general'): Genome {
  return {
    provider:     pick(PROVIDERS),
    decompose:    pick(DECOMPOSE_OPTIONS),
    contextStyle: pick(CONTEXT_STYLES),
    promptStyle:  pick(PROMPT_STYLES),
    temperature:  pick(TEMPERATURES),
    maxTokens:    pick(domainMaxTokens(domain)),
  };
}

function pick<T>(arr: ReadonlyArray<T>): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// ── Benchmark tasks ────────────────────────────────────────────────────────────
// These 6 tasks are the fixed evaluation benchmarks. They MUST NOT change after
// the first production run — changing them breaks cross-generation fitness
// comparability. The checksum assertion enforces immutability at startup.
//
// Benchmark indices: 0=general-a, 1=coding, 2=diagnostic, 3=planning,
//                   4=knowledge, 5=general-b

export const BENCHMARK_TASKS: readonly string[] = [
  "Summarize the key differences between REST and GraphQL APIs in exactly 3 bullet points. Be precise and concise.",
  "Write a JavaScript function named debounce(fn, delayMs) that delays invoking fn until delayMs milliseconds have elapsed since the last call. Include a brief JSDoc comment.",
  "A Node.js process exits with code 137. List the 3 most likely root causes and the first shell command you would run to diagnose each.",
  "Break down a SQLite-to-PostgreSQL migration for a 500-row database into exactly 5 ordered steps. State the dependency between each step and the next.",
  "Name three failure modes of the Raft distributed consensus algorithm under network partition and explain in one sentence how each affects cluster availability.",
  "What is the difference between a mutex and a semaphore? Answer in exactly two sentences.",
] as const;

// SHA-256 of all benchmark strings joined with NUL byte.
// Recompute with: crypto.createHash('sha256').update(BENCHMARK_TASKS.join('\x00')).digest('hex')
const BENCHMARK_CHECKSUM =
  "926c62eea94e780bb01ad1457346a4ca0c6ae64b86c4c9385e95a76e5ad875c9";

/**
 * Verify benchmark integrity. Throws if the benchmark text has been modified.
 * Called once on module load — a mismatch fails loudly so CI catches it before
 * any evaluation data is produced with incomparable benchmarks.
 */
export function assertBenchmarkIntegrity(): void {
  const computed = crypto
    .createHash("sha256")
    .update(BENCHMARK_TASKS.join("\x00"))
    .digest("hex");
  if (computed !== BENCHMARK_CHECKSUM) {
    throw new Error(
      `[CrystallineEvolver] Benchmark checksum mismatch!\n` +
      `  Expected: ${BENCHMARK_CHECKSUM}\n` +
      `  Computed: ${computed}\n` +
      `  Benchmark text has been modified — cross-generation fitness comparability is broken.`,
    );
  }
}

// ── Domain constants ───────────────────────────────────────────────────────────

export const EVOLVER_DOMAINS = [
  "general",
  "coding",
  "diagnostic",
  "planning",
  "knowledge",
] as const;

export type EvolverDomain = (typeof EVOLVER_DOMAINS)[number];

// Maps each domain to the benchmark task indices it uses for evaluation.
// general uses both general benchmarks (0 and 5); others use one each.
export const DOMAIN_BENCHMARK_MAP: Record<EvolverDomain, readonly number[]> = {
  general:    [0, 5],
  coding:     [1, 0],
  diagnostic: [2, 5],
  planning:   [3, 5],
  knowledge:  [4, 0],
};

// ── DB permission firewall ─────────────────────────────────────────────────────

/**
 * Thrown when evolver code attempts to access a non-crystal Drizzle table.
 * Logged to error_log so violations are visible in the admin panel.
 */
export class EvolverPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvolverPermissionError";
  }
}

/**
 * Scoped DB interface — the only database methods the evolver may call.
 * All methods operate on crystal_* tables only. Attempting anything else
 * throws EvolverPermissionError and writes to the error log.
 */
export interface ScopedDb {
  insertGenome(genome: typeof crystalGenomesTable.$inferInsert): Promise<typeof crystalGenomesTable.$inferSelect>;
  getGenomesByDomain(domain: string | null, limit?: number): Promise<(typeof crystalGenomesTable.$inferSelect)[]>;
  pruneGenomes(domain: string | null, keepCount: number): Promise<void>;
  upsertChampion(champion: typeof crystalChampionsTable.$inferInsert): Promise<void>;
  getChampion(domain: string): Promise<(typeof crystalChampionsTable.$inferSelect) | null>;
  getAllChampions(): Promise<(typeof crystalChampionsTable.$inferSelect)[]>;
  updateChampionShadow(domain: string, shadowFitness: number, shadowGenerations: number): Promise<void>;
  updateAntiChampionGenome(domain: string, antiGenome: Record<string, unknown>): Promise<void>;
  upsertRule(rule: typeof crystalRulesTable.$inferInsert): Promise<void>;
  getRules(domain: string): Promise<(typeof crystalRulesTable.$inferSelect)[]>;
  insertGeneration(row: typeof evolverGenerationsTable.$inferInsert): Promise<typeof evolverGenerationsTable.$inferSelect>;
  getLastCompletedGeneration(domain: string): Promise<(typeof evolverGenerationsTable.$inferSelect) | null>;
  bulkInsertPopulation(rows: (typeof evolverPopulationTable.$inferInsert)[], components?: (FitnessComponents | null)[]): Promise<void>;
  getAlivePopulation(generationId: number): Promise<(typeof evolverPopulationTable.$inferSelect)[]>;
  markDeadPopulation(ids: number[]): Promise<void>;
  pruneOldGenerations(domain: string, keepCount: number): Promise<void>;
  insertConfigSnapshot(row: NewConfigSnapshot): Promise<ConfigSnapshot>;
  getLatestConfigSnapshot(type: string): Promise<ConfigSnapshot | null>;
  insertPendingInjection(row: NewPendingInjection): Promise<PendingInjection>;
  getPendingInjections(): Promise<PendingInjection[]>;
  getPendingInjection(id: number): Promise<PendingInjection | null>;
  deletePendingInjection(id: number): Promise<void>;
  approvePendingInjection(id: number): Promise<PendingInjection | null>;
  insertInjectionAuditLog(row: NewInjectionAuditLog): Promise<InjectionAuditLog>;
  markInjectionRolledBack(id: number): Promise<void>;
  getInjectionAuditLog(limit: number): Promise<InjectionAuditLog[]>;
  insertEvolverCrystal(row: NewEvolverCrystal): Promise<void>;
  getEvolverCrystals(domain: string, limit: number): Promise<EvolverCrystal[]>;
  countRecentEvolverCrystals(domain: string, sinceMs: number): Promise<number>;
  getBottomPercentileGenomes(domain: string, percentile: number, minEvals: number): Promise<(typeof crystalGenomesTable.$inferSelect)[]>;
  getTopPercentileGenomes(domain: string, percentile: number, minEvals: number): Promise<(typeof crystalGenomesTable.$inferSelect)[]>;

  // ── Task #493: Fitness distributions (Step 1) ──────────────────────────────
  upsertFitnessDistribution(domain: string, genomeHash: string, fitness: number, natural: boolean, generation: number): Promise<void>;
  getFitnessDistribution(domain: string, genomeHash: string): Promise<EvolverFitnessDistribution | null>;
  getDomainFitnessDistributions(domain: string, limit: number): Promise<EvolverFitnessDistribution[]>;

  // ── Task #493: Noise model (Steps 2-6, 12) ─────────────────────────────────
  upsertNoiseModel(domain: string, data: Partial<NewEvolverNoiseModel>): Promise<EvolverNoiseModel>;
  getNoiseModel(domain: string): Promise<EvolverNoiseModel | null>;

  // ── Task #493: Rollback events (Step 7) ────────────────────────────────────
  insertRollbackEvent(row: NewEvolverRollbackEvent): Promise<EvolverRollbackEvent>;
  getRollbackEvents(domain: string, limit: number): Promise<EvolverRollbackEvent[]>;

  // ── Task #493: Risky genes (Step 7) ────────────────────────────────────────
  upsertRiskyGene(domain: string, geneKey: string, geneValue: string): Promise<void>;
  getRiskyGenes(domain: string): Promise<EvolverRiskyGene[]>;

  // ── Task #493: Adversarial cases (Step 8) ──────────────────────────────────
  insertAdversarialCase(row: NewEvolverAdversarialCase): Promise<EvolverAdversarialCase>;
  getAdversarialCases(domain: string): Promise<EvolverAdversarialCase[]>;
  pruneAdversarialCases(domain: string, olderThanGeneration: number): Promise<void>;

  // ── Task #493: Transfer map (Step 9) ───────────────────────────────────────
  insertTransferMapEntry(row: NewEvolverTransferMap): Promise<void>;
  getTransferMapEntries(targetDomain: string, limit: number): Promise<EvolverTransferMap[]>;

  // ── Task #493: Counterfactual log (Step 10) ────────────────────────────────
  insertCounterfactualLog(row: NewEvolverCounterfactualLog): Promise<EvolverCounterfactualLog>;
  updateCounterfactualOutcomes(id: number, targetedFitness: number, randomFitness: number): Promise<void>;
  getUnevaluatedCounterfactuals(domain: string, limit: number): Promise<EvolverCounterfactualLog[]>;
  getRecentCounterfactuals(domain: string, limit: number): Promise<EvolverCounterfactualLog[]>;

  // ── Task #479: Fitness discrimination fix ────────────────────────────────────
  /** Mark alive=false for all zero-fitness rows in prior generations (not currentGenerationId). */
  cullZeroFitnessSurvivors(domain: string, currentGenerationId: number): Promise<void>;
  /** DELETE all rows from evolver_population and evolver_generations (ephemeral learning data). */
  clearEvolverLearningData(): Promise<void>;
  /** MAX(best_fitness) across all domains in evolver_generations, or 0 if empty. */
  getMaxGenerationFitness(): Promise<number>;
  /** COUNT(*) of evolver_generations rows. */
  getGenerationCount(): Promise<number>;
  /** If coding champion has fitness < 0.5 or node='test', replace it with the best alive coding genome. */
  repairCodingChampion(): Promise<void>;

  // ── Task #508: Gladiator tournament log ─────────────────────────────────────
  insertTournamentLog(row: NewEvolverTournamentLog): Promise<void>;
  getTournamentLog(domain: string, limit: number): Promise<EvolverTournamentLog[]>;
  /** Mark domain champion as crystallized (armor written to INFRA_LIBRARY). */
  updateChampionCrystallized(domain: string, crystallizedAt: Date): Promise<void>;
}

type DrizzleClient = typeof _db;

/**
 * Create a ScopedDb wrapping the given Drizzle client.
 * Exposes only crystal_* table operations. Any attempt to touch a non-crystal
 * table from within the evolver must go through this interface — the evolver
 * module never imports the raw db client.
 */
export function createScopedDb(drizzleClient: DrizzleClient): ScopedDb {
  return {
    async insertGenome(genome) {
      const [row] = await drizzleClient
        .insert(crystalGenomesTable)
        .values(genome)
        .returning();
      return row!;
    },

    async getGenomesByDomain(domain, limit = 100) {
      if (domain === null) {
        return drizzleClient
          .select()
          .from(crystalGenomesTable)
          .orderBy(desc(crystalGenomesTable.created_at))
          .limit(limit);
      }
      return drizzleClient
        .select()
        .from(crystalGenomesTable)
        .where(eq(crystalGenomesTable.domain, domain))
        .orderBy(desc(crystalGenomesTable.created_at))
        .limit(limit);
    },

    async pruneGenomes(domain, keepCount) {
      // Delete oldest rows beyond keepCount for the given domain.
      const subquery = drizzleClient
        .select({ id: crystalGenomesTable.id })
        .from(crystalGenomesTable)
        .where(domain === null ? sql`true` : eq(crystalGenomesTable.domain, domain))
        .orderBy(desc(crystalGenomesTable.created_at))
        .limit(keepCount);

      await drizzleClient
        .delete(crystalGenomesTable)
        .where(
          and(
            domain === null ? undefined : eq(crystalGenomesTable.domain, domain),
            sql`${crystalGenomesTable.id} NOT IN (${subquery})`,
          ),
        );
    },

    async upsertChampion(champion) {
      await drizzleClient
        .insert(crystalChampionsTable)
        .values(champion)
        .onConflictDoUpdate({
          target: crystalChampionsTable.domain,
          // Only promote if the new fitness strictly beats the current champion.
          // Without this guard, any 0.1% evaluation blindly overwrites an 89% record.
          setWhere: sql`${crystalChampionsTable.fitness} < ${champion.fitness!}`,
          set: {
            genome:           champion.genome,
            fitness:          champion.fitness!,
            generation:       champion.generation ?? 0,
            node:             champion.node ?? null,
            runner_up_genome: champion.runner_up_genome ?? null,
            promoted_at:      sql`now()`,
          },
        });
    },

    async getChampion(domain) {
      const [row] = await drizzleClient
        .select()
        .from(crystalChampionsTable)
        .where(eq(crystalChampionsTable.domain, domain))
        .limit(1);
      return row ?? null;
    },

    async getAllChampions() {
      return drizzleClient
        .select()
        .from(crystalChampionsTable)
        .orderBy(desc(crystalChampionsTable.fitness));
    },

    async upsertRule(rule) {
      // jsonb columns cannot be unique-constrained, so onConflictDoUpdate is not
      // available here. Manual find-then-update/insert instead.
      const [existing] = await drizzleClient
        .select({ id: crystalRulesTable.id, sample_count: crystalRulesTable.sample_count })
        .from(crystalRulesTable)
        .where(
          and(
            eq(crystalRulesTable.domain, rule.domain),
            sql`${crystalRulesTable.pattern}::text = ${JSON.stringify(rule.pattern)}::text`,
          ),
        )
        .limit(1);

      if (existing) {
        await drizzleClient
          .insert(crystalRulesTable)
          .values(rule)
          .onConflictDoUpdate({
            target: crystalRulesTable.id,
            set: {
              effect:       rule.effect,
              sample_count: (existing.sample_count ?? 0) + 1,
              updated_at:   sql`now()`,
            },
          });
      } else {
        await drizzleClient.insert(crystalRulesTable).values(rule);
      }
    },

    async getRules(domain) {
      return drizzleClient
        .select()
        .from(crystalRulesTable)
        .where(eq(crystalRulesTable.domain, domain))
        .orderBy(asc(crystalRulesTable.effect));
    },

    async insertGeneration(row) {
      const [inserted] = await drizzleClient
        .insert(evolverGenerationsTable)
        .values(row)
        .returning();
      return inserted!;
    },

    async getLastCompletedGeneration(domain) {
      const [row] = await drizzleClient
        .select()
        .from(evolverGenerationsTable)
        .where(
          and(
            eq(evolverGenerationsTable.domain, domain),
            eq(evolverGenerationsTable.status, "completed"),
          ),
        )
        .orderBy(desc(evolverGenerationsTable.created_at))
        .limit(1);
      return row ?? null;
    },

    async bulkInsertPopulation(rows, components) {
      if (rows.length === 0) return;
      const withComponents = rows.map((r, i) => ({
        ...r,
        components: components?.[i] ?? null,
      }));
      await drizzleClient.insert(evolverPopulationTable).values(withComponents);
    },

    async getAlivePopulation(generationId) {
      return drizzleClient
        .select()
        .from(evolverPopulationTable)
        .where(
          and(
            eq(evolverPopulationTable.generation_id, generationId),
            eq(evolverPopulationTable.alive, true),
          ),
        )
        .orderBy(desc(evolverPopulationTable.fitness))
        .limit(100);
    },

    async markDeadPopulation(ids) {
      if (ids.length === 0) return;
      await drizzleClient
        .update(evolverPopulationTable)
        .set({ alive: false })
        .where(inArray(evolverPopulationTable.id, ids));
    },

    async pruneOldGenerations(domain, keepCount) {
      const keep = await drizzleClient
        .select({ id: evolverGenerationsTable.id })
        .from(evolverGenerationsTable)
        .where(eq(evolverGenerationsTable.domain, domain))
        .orderBy(desc(evolverGenerationsTable.created_at))
        .limit(keepCount);
      if (keep.length === 0) return;

      const keepIds = keep.map(r => r.id);
      const toPrune = await drizzleClient
        .select({ id: evolverGenerationsTable.id })
        .from(evolverGenerationsTable)
        .where(
          and(
            eq(evolverGenerationsTable.domain, domain),
            sql`${evolverGenerationsTable.id} NOT IN (${sql.join(keepIds.map(id => sql`${id}`), sql`, `)})`,
          ),
        );
      if (toPrune.length === 0) return;

      const pruneIds = toPrune.map(r => r.id);
      await drizzleClient
        .delete(evolverPopulationTable)
        .where(inArray(evolverPopulationTable.generation_id, pruneIds));
      await drizzleClient
        .delete(evolverGenerationsTable)
        .where(inArray(evolverGenerationsTable.id, pruneIds));
    },

    // ── Task #479: Fitness discrimination fix ──────────────────────────────────

    async cullZeroFitnessSurvivors(domain, currentGenerationId) {
      await drizzleClient
        .update(evolverPopulationTable)
        .set({ alive: false })
        .where(
          and(
            eq(evolverPopulationTable.domain, domain),
            eq(evolverPopulationTable.alive, true),
            eq(evolverPopulationTable.fitness, 0),
            sql`${evolverPopulationTable.generation_id} != ${currentGenerationId}`,
          ),
        );
    },

    async clearEvolverLearningData() {
      await drizzleClient.delete(evolverPopulationTable);
      await drizzleClient.delete(evolverGenerationsTable);
    },

    async getMaxGenerationFitness() {
      const [row] = await drizzleClient
        .select({ max: sql<number>`COALESCE(MAX(${evolverGenerationsTable.best_fitness}), 0)` })
        .from(evolverGenerationsTable);
      return Number(row?.max ?? 0);
    },

    async getGenerationCount() {
      const [row] = await drizzleClient
        .select({ cnt: sql<number>`COUNT(*)` })
        .from(evolverGenerationsTable);
      return Number(row?.cnt ?? 0);
    },

    async repairCodingChampion() {
      const [champion] = await drizzleClient
        .select()
        .from(crystalChampionsTable)
        .where(eq(crystalChampionsTable.domain, "coding"))
        .limit(1);

      const needsRepair = !champion || (champion.fitness ?? 0) < 0.5 || champion.node === "test";
      if (!needsRepair) return;

      const [best] = await drizzleClient
        .select({ genome: evolverPopulationTable.genome, fitness: evolverPopulationTable.fitness })
        .from(evolverPopulationTable)
        .where(
          and(
            eq(evolverPopulationTable.domain, "coding"),
            eq(evolverPopulationTable.alive, true),
            sql`${evolverPopulationTable.fitness} > 0.5`,
          ),
        )
        .orderBy(desc(evolverPopulationTable.fitness))
        .limit(1);

      if (best) {
        await drizzleClient
          .insert(crystalChampionsTable)
          .values({
            domain:     "coding",
            genome:     best.genome,
            fitness:    best.fitness ?? 0,
            generation: 0,
            node:       "repaired",
          })
          .onConflictDoUpdate({
            target: crystalChampionsTable.domain,
            set: {
              genome:      best.genome,
              fitness:     best.fitness ?? 0,
              node:        sql`'repaired'`,
              promoted_at: sql`now()`,
            },
          });
        logger.info({ fitness: best.fitness }, "[Evolver #479] Poisoned coding champion replaced from alive population");
      } else {
        await drizzleClient
          .delete(crystalChampionsTable)
          .where(eq(crystalChampionsTable.domain, "coding"));
        logger.warn("[Evolver #479] No good coding genome found — poisoned champion row deleted; evolver will seed fresh");
      }
    },

    async updateChampionShadow(domain, shadowFitness, shadowGenerations) {
      await drizzleClient
        .update(crystalChampionsTable)
        .set({ shadow_fitness: shadowFitness, shadow_generations: shadowGenerations })
        .where(eq(crystalChampionsTable.domain, domain));
    },

    async updateAntiChampionGenome(domain, antiGenome) {
      await drizzleClient
        .update(crystalChampionsTable)
        .set({ anti_champion_genome: antiGenome })
        .where(eq(crystalChampionsTable.domain, domain));
    },

    async insertConfigSnapshot(row) {
      const [r] = await drizzleClient.insert(configSnapshotsTable).values(row).returning();
      return r!;
    },

    async getLatestConfigSnapshot(type) {
      const [r] = await drizzleClient
        .select()
        .from(configSnapshotsTable)
        .where(eq(configSnapshotsTable.type, type))
        .orderBy(desc(configSnapshotsTable.created_at))
        .limit(1);
      return r ?? null;
    },

    async insertPendingInjection(row) {
      const [r] = await drizzleClient.insert(pendingInjectionsTable).values(row).returning();
      return r!;
    },

    async getPendingInjections() {
      return drizzleClient
        .select()
        .from(pendingInjectionsTable)
        .where(sql`${pendingInjectionsTable.approved_at} IS NULL`)
        .orderBy(asc(pendingInjectionsTable.created_at));
    },

    async getPendingInjection(id) {
      const [r] = await drizzleClient
        .select()
        .from(pendingInjectionsTable)
        .where(eq(pendingInjectionsTable.id, id))
        .limit(1);
      return r ?? null;
    },

    async deletePendingInjection(id) {
      await drizzleClient
        .delete(pendingInjectionsTable)
        .where(eq(pendingInjectionsTable.id, id));
    },

    async approvePendingInjection(id) {
      const [r] = await drizzleClient
        .update(pendingInjectionsTable)
        .set({ approved_at: sql`now()`, approved_by: "admin" })
        .where(eq(pendingInjectionsTable.id, id))
        .returning();
      return r ?? null;
    },

    async insertInjectionAuditLog(row) {
      const [r] = await drizzleClient.insert(injectionAuditLogTable).values(row).returning();
      return r!;
    },

    async markInjectionRolledBack(id) {
      await drizzleClient
        .update(injectionAuditLogTable)
        .set({ rolled_back: true, rolled_back_at: sql`now()` })
        .where(eq(injectionAuditLogTable.id, id));
    },

    async getInjectionAuditLog(limit) {
      return drizzleClient
        .select()
        .from(injectionAuditLogTable)
        .orderBy(desc(injectionAuditLogTable.created_at))
        .limit(limit);
    },

    async insertEvolverCrystal(row) {
      await drizzleClient.insert(evolverCrystalsTable).values(row);
    },

    async getEvolverCrystals(domain, limit) {
      return drizzleClient
        .select()
        .from(evolverCrystalsTable)
        .where(eq(evolverCrystalsTable.domain, domain))
        .orderBy(desc(evolverCrystalsTable.created_at))
        .limit(limit);
    },

    async countRecentEvolverCrystals(domain, sinceMs) {
      const since = new Date(Date.now() - sinceMs);
      const [r] = await drizzleClient
        .select({ n: sql<number>`count(*)::int` })
        .from(evolverCrystalsTable)
        .where(and(
          eq(evolverCrystalsTable.domain, domain),
          sql`${evolverCrystalsTable.created_at} >= ${since}`,
        ));
      return r?.n ?? 0;
    },

    async getBottomPercentileGenomes(domain, percentile, minEvals) {
      const all = await drizzleClient
        .select()
        .from(crystalGenomesTable)
        .where(and(
          eq(crystalGenomesTable.domain, domain),
          sql`${crystalGenomesTable.tokenless_resolved} = false`,
        ))
        .orderBy(asc(crystalGenomesTable.fitness))
        .limit(Math.max(minEvals * 5, 200));
      if (all.length < minEvals) return [];
      const cutoff = Math.floor(all.length * (percentile / 100));
      return all.slice(0, Math.max(cutoff, 1));
    },

    async getTopPercentileGenomes(domain, percentile, minEvals) {
      const all = await drizzleClient
        .select()
        .from(crystalGenomesTable)
        .where(and(
          eq(crystalGenomesTable.domain, domain),
          sql`${crystalGenomesTable.tokenless_resolved} = false`,
        ))
        .orderBy(desc(crystalGenomesTable.fitness))
        .limit(Math.max(minEvals * 5, 200));
      if (all.length < minEvals) return [];
      const cutoff = Math.floor(all.length * (percentile / 100));
      return all.slice(0, Math.max(cutoff, 1));
    },

    // ── Task #493: Fitness distributions ───────────────────────────────────────
    async upsertFitnessDistribution(domain, genomeHash, fitness, natural, generation) {
      const [existing] = await drizzleClient
        .select()
        .from(evolverFitnessDistributionsTable)
        .where(and(
          eq(evolverFitnessDistributionsTable.genome_hash, genomeHash),
          eq(evolverFitnessDistributionsTable.domain, domain),
        ))
        .limit(1);

      if (existing) {
        // Welford's online algorithm: incremental mean + variance update
        const n    = existing.sample_count + 1;
        const mean = existing.mean + (fitness - existing.mean) / n;
        // M2 is stored as variance * (n-1); recover from variance
        const oldM2  = existing.variance * Math.max(existing.sample_count - 1, 0);
        const delta2 = fitness - mean;
        const newM2  = oldM2 + (fitness - existing.mean) * delta2;
        const newVar = n > 1 ? newM2 / (n - 1) : 0;

        await drizzleClient
          .update(evolverFitnessDistributionsTable)
          .set({
            mean:           mean,
            variance:       newVar,
            sample_count:   n,
            natural_count:  natural ? existing.natural_count + 1 : existing.natural_count,
            last_generation: generation,
            updated_at:     sql`now()`,
          })
          .where(and(
            eq(evolverFitnessDistributionsTable.genome_hash, genomeHash),
            eq(evolverFitnessDistributionsTable.domain, domain),
          ));
      } else {
        await drizzleClient.insert(evolverFitnessDistributionsTable).values({
          genome_hash:     genomeHash,
          domain,
          mean:            fitness,
          variance:        0,
          sample_count:    1,
          natural_count:   natural ? 1 : 0,
          last_generation: generation,
        });
      }
    },

    async getFitnessDistribution(domain, genomeHash) {
      const [r] = await drizzleClient
        .select()
        .from(evolverFitnessDistributionsTable)
        .where(and(
          eq(evolverFitnessDistributionsTable.domain, domain),
          eq(evolverFitnessDistributionsTable.genome_hash, genomeHash),
        ))
        .limit(1);
      return r ?? null;
    },

    async getDomainFitnessDistributions(domain, limit) {
      return drizzleClient
        .select()
        .from(evolverFitnessDistributionsTable)
        .where(eq(evolverFitnessDistributionsTable.domain, domain))
        .orderBy(desc(evolverFitnessDistributionsTable.updated_at))
        .limit(limit);
    },

    // ── Task #493: Noise model ─────────────────────────────────────────────────
    async upsertNoiseModel(domain, data) {
      const base: NewEvolverNoiseModel = { domain, ...data };
      await drizzleClient
        .insert(evolverNoiseModelTable)
        .values(base)
        .onConflictDoUpdate({
          target: evolverNoiseModelTable.domain,
          set: {
            ...( data.noise_floor         !== undefined ? { noise_floor:         data.noise_floor }         : {} ),
            ...( data.epsilon             !== undefined ? { epsilon:             data.epsilon }             : {} ),
            ...( data.epsilon_min         !== undefined ? { epsilon_min:         data.epsilon_min }         : {} ),
            ...( data.model_confidence    !== undefined ? { model_confidence:    data.model_confidence }    : {} ),
            ...( data.cooccurrence_json   !== undefined ? { cooccurrence_json:   data.cooccurrence_json }   : {} ),
            ...( data.staleness_ratio     !== undefined ? { staleness_ratio:     data.staleness_ratio }     : {} ),
            ...( data.saturated           !== undefined ? { saturated:           data.saturated }           : {} ),
            ...( data.saturation_checks   !== undefined ? { saturation_checks:   data.saturation_checks }   : {} ),
            ...( data.natural_eval_count  !== undefined ? { natural_eval_count:  data.natural_eval_count }  : {} ),
            ...( data.divergence_log_json !== undefined ? { divergence_log_json: data.divergence_log_json } : {} ),
            updated_at: sql`now()`,
          },
        });
      const [row] = await drizzleClient
        .select()
        .from(evolverNoiseModelTable)
        .where(eq(evolverNoiseModelTable.domain, domain))
        .limit(1);
      return row!;
    },

    async getNoiseModel(domain) {
      const [r] = await drizzleClient
        .select()
        .from(evolverNoiseModelTable)
        .where(eq(evolverNoiseModelTable.domain, domain))
        .limit(1);
      return r ?? null;
    },

    // ── Task #493: Rollback events ─────────────────────────────────────────────
    async insertRollbackEvent(row) {
      const [r] = await drizzleClient
        .insert(evolverRollbackEventsTable)
        .values(row)
        .returning();
      return r!;
    },

    async getRollbackEvents(domain, limit) {
      return drizzleClient
        .select()
        .from(evolverRollbackEventsTable)
        .where(eq(evolverRollbackEventsTable.domain, domain))
        .orderBy(desc(evolverRollbackEventsTable.created_at))
        .limit(limit);
    },

    // ── Task #493: Risky genes ─────────────────────────────────────────────────
    async upsertRiskyGene(domain, geneKey, geneValue) {
      const [existing] = await drizzleClient
        .select({ id: evolverRiskyGenesTable.id, rollback_count: evolverRiskyGenesTable.rollback_count })
        .from(evolverRiskyGenesTable)
        .where(and(
          eq(evolverRiskyGenesTable.domain, domain),
          eq(evolverRiskyGenesTable.gene_key, geneKey),
          eq(evolverRiskyGenesTable.gene_value, geneValue),
        ))
        .limit(1);

      if (existing) {
        await drizzleClient
          .update(evolverRiskyGenesTable)
          .set({ rollback_count: existing.rollback_count + 1, last_seen_at: sql`now()` })
          .where(eq(evolverRiskyGenesTable.id, existing.id));
      } else {
        await drizzleClient.insert(evolverRiskyGenesTable).values({
          domain, gene_key: geneKey, gene_value: geneValue, rollback_count: 1,
        });
      }
    },

    async getRiskyGenes(domain) {
      return drizzleClient
        .select()
        .from(evolverRiskyGenesTable)
        .where(eq(evolverRiskyGenesTable.domain, domain))
        .orderBy(desc(evolverRiskyGenesTable.rollback_count));
    },

    // ── Task #493: Adversarial cases ───────────────────────────────────────────
    async insertAdversarialCase(row) {
      const [r] = await drizzleClient
        .insert(evolverAdversarialCasesTable)
        .values(row)
        .returning();
      return r!;
    },

    async getAdversarialCases(domain) {
      return drizzleClient
        .select()
        .from(evolverAdversarialCasesTable)
        .where(eq(evolverAdversarialCasesTable.domain, domain))
        .orderBy(asc(evolverAdversarialCasesTable.baseline_fitness));
    },

    async pruneAdversarialCases(domain, olderThanGeneration) {
      await drizzleClient
        .delete(evolverAdversarialCasesTable)
        .where(and(
          eq(evolverAdversarialCasesTable.domain, domain),
          sql`${evolverAdversarialCasesTable.created_generation} < ${olderThanGeneration}`,
        ));
    },

    // ── Task #493: Transfer map ────────────────────────────────────────────────
    async insertTransferMapEntry(row) {
      await drizzleClient.insert(evolverTransferMapTable).values(row);
    },

    async getTransferMapEntries(targetDomain, limit) {
      return drizzleClient
        .select()
        .from(evolverTransferMapTable)
        .where(eq(evolverTransferMapTable.target_domain, targetDomain))
        .orderBy(desc(evolverTransferMapTable.created_at))
        .limit(limit);
    },

    // ── Task #493: Counterfactual log ──────────────────────────────────────────
    async insertCounterfactualLog(row) {
      const [r] = await drizzleClient
        .insert(evolverCounterfactualLogTable)
        .values(row)
        .returning();
      return r!;
    },

    async updateCounterfactualOutcomes(id, targetedFitness, randomFitness) {
      await drizzleClient
        .update(evolverCounterfactualLogTable)
        .set({ targeted_fitness: targetedFitness, random_fitness: randomFitness, evaluated: true })
        .where(eq(evolverCounterfactualLogTable.id, id));
    },

    async getUnevaluatedCounterfactuals(domain, limit) {
      return drizzleClient
        .select()
        .from(evolverCounterfactualLogTable)
        .where(and(
          eq(evolverCounterfactualLogTable.domain, domain),
          eq(evolverCounterfactualLogTable.evaluated, false),
        ))
        .orderBy(asc(evolverCounterfactualLogTable.created_at))
        .limit(limit);
    },

    async getRecentCounterfactuals(domain, limit) {
      return drizzleClient
        .select()
        .from(evolverCounterfactualLogTable)
        .where(and(
          eq(evolverCounterfactualLogTable.domain, domain),
          eq(evolverCounterfactualLogTable.evaluated, true),
        ))
        .orderBy(desc(evolverCounterfactualLogTable.created_at))
        .limit(limit);
    },

    // ── Task #508: Tournament log ─────────────────────────────────────────────
    async insertTournamentLog(row) {
      await drizzleClient
        .insert(evolverTournamentLogTable)
        .values(row);
    },
    async getTournamentLog(domain, limit) {
      return drizzleClient
        .select()
        .from(evolverTournamentLogTable)
        .where(eq(evolverTournamentLogTable.domain, domain))
        .orderBy(desc(evolverTournamentLogTable.ts))
        .limit(limit);
    },
    async updateChampionCrystallized(domain, crystallizedAt) {
      await drizzleClient
        .update(crystalChampionsTable)
        .set({ crystallized: true, armor_crystallized_at: crystallizedAt })
        .where(eq(crystalChampionsTable.domain, domain));
    },
  };
}

// ── EvolverContext interface ────────────────────────────────────────────────────
// The evolver module receives an EvolverContext and nothing else. No direct
// imports of db, providers, or Express — everything goes through this interface.
// Stage B implements the providers field; Stage C wires up the context at boot.

/** Read-only provider wrapper — Stage B implements this. */
export interface RestrictedProvider {
  /** Call the provider with a prompt and genome settings. Returns text output. */
  call(prompt: string, genome: Genome): Promise<{ text: string; tokensUsed: number }>;
  /** True if this provider slot is currently available (not rate-limited/broken). */
  available(): boolean;
}

export interface InjectionCtx {
  setBotSetting(key: string, value: string): Promise<void>;
  getBotSetting(key: string): Promise<string | null>;
}

export interface EvolverContext {
  /** Provider wrapper restricted to the evolver — no raw SDK access. */
  providers: Map<Provider, RestrictedProvider>;
  /** Scoped DB — crystal tables only. */
  db: ScopedDb;
  /** Returns current ZomBrains queue depth — used to gate evolver activity. */
  monitor: () => Promise<number>;
  /** Read/write champions via HTTP to the Monitor endpoint. */
  champions: {
    get(domain: string): Promise<Genome | null>;
    set(domain: string, genome: Genome, fitness: number, generation: number, runnerUpGenome?: Genome): Promise<void>;
  };
  /** Bot-settings access — injection handlers write to these; ZomBrains reads on task start. */
  injection: InjectionCtx;
  /** Send a Discord DM to the owner (non-fatal, fire-and-forget). */
  writeDiscordDm(msg: string): Promise<void>;
  /** Rolling average quality from the last N session_crystals (success type only). */
  getRecentSessionQuality(limit: number): Promise<number | null>;
}

// ── Module integrity check — called once on load ───────────────────────────────
assertBenchmarkIntegrity();

// ═══════════════════════════════════════════════════════════════════════════════
// Stage B: Evaluation Engine
// Tokenless pipeline (TL1→TL4) → G1/G3 guardrails → API call → rule update.
// No generation loop here — that is Stage C.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Result types ───────────────────────────────────────────────────────────────

export type ResolvedBy =
  | "cache"
  | "structural"
  | "champion-gate"
  | "heuristic"
  | "railway"
  | "api"
  | "rate-limit-skip"
  | "token-cap";

/**
 * Per-genome fitness component breakdown (all values 0–1).
 * Null on tokenless-resolved results (cache/structural/heuristic).
 */
export interface FitnessComponents {
  completion:      number; // 1.0 if response is substantive (quality≥30), else 0.0
  quality:         number; // qualityScore / 100
  tokenEfficiency: number; // 1 - min(tokensUsed, 800) / 800
  latency:         number; // max(0, 1 - latencyMs / 10_000)
}

export interface EvalResult {
  fitness:      number;
  tokensUsed:   number;
  qualityScore: number;
  resolvedBy:   ResolvedBy;
  components:   FitnessComponents | null;
}

export interface BenchmarkTask {
  text:  string;
  index: number;
}

// ── Module-level eval state ────────────────────────────────────────────────────
let _cacheHits  = 0;
let _lastCallMs = 0; // timestamp of last actual provider API call (G8 stagger)

export function getCacheHits(): number { return _cacheHits; }

// ── TL1: Genome result cache ───────────────────────────────────────────────────
// Queries crystal_genomes for a matching genome within the last 5 generations.
// Returns cached fitness on hit (increments counter), null if not found.
export async function checkGenomeCache(
  db: ScopedDb,
  genome: Genome,
  domain: string,
): Promise<number | null> {
  const recent = await db.getGenomesByDomain(domain, 300);
  const maxGen = recent.reduce((m, r) => Math.max(m, r.generation ?? 0), 0);
  const minGen = Math.max(0, maxGen - 5);

  for (const row of recent) {
    if ((row.generation ?? 0) < minGen) continue;
    const g = row.genome as unknown as Genome;
    if (
      g.provider     === genome.provider     &&
      g.decompose    === genome.decompose    &&
      g.contextStyle === genome.contextStyle &&
      g.promptStyle  === genome.promptStyle  &&
      g.temperature  === genome.temperature  &&
      g.maxTokens    === genome.maxTokens
    ) {
      _cacheHits++;
      return row.fitness;
    }
  }
  return null;
}

// ── TL2: Structural pre-scoring ────────────────────────────────────────────────
// If a gene pattern has a reliably negative rule (sample_count ≥ 3, effect < 0),
// disqualify without an API call. Returns 0 on disqualification, null otherwise.
export async function checkStructuralRules(
  db: ScopedDb,
  genome: Genome,
  domain: string,
): Promise<number | null> {
  const rules = await db.getRules(domain);
  for (const rule of rules) {
    if (rule.effect >= 0 || rule.sample_count < 3) continue;
    const pattern = rule.pattern as unknown as { gene: keyof Genome; value: unknown };
    if (genome[pattern.gene] === pattern.value) return 0;
  }
  return null;
}

// ── TL3: Champion gate ─────────────────────────────────────────────────────────
// If this genome differs from the champion by exactly one gene, and that gene
// change has a disqualifying rule, skip the API call. Returns 0 or null.
export async function checkChampionGate(
  db: ScopedDb,
  genome: Genome,
  domain: string,
): Promise<number | null> {
  const champion = await db.getChampion(domain);
  if (!champion) return null;

  const cg = champion.genome as unknown as Genome;
  const diffGenes = (Object.keys(genome) as (keyof Genome)[]).filter(
    (k) => genome[k] !== cg[k],
  );
  if (diffGenes.length !== 1) return null;

  const changedGene  = diffGenes[0]!;
  const changedValue = genome[changedGene];
  const rules        = await db.getRules(domain);

  const disqualifying = rules.find((r) => {
    const p = r.pattern as unknown as { gene: keyof Genome; value: unknown };
    return (
      p.gene === changedGene &&
      p.value === changedValue &&
      r.effect < 0 &&
      r.sample_count >= 3
    );
  });

  return disqualifying ? 0 : null;
}

// ── TL4: Heuristic structural scoring ─────────────────────────────────────────
// Conservative per-domain rules that block obviously poor genomes.
// All thresholds are conservative — never block a genome that could plausibly win.
export function heuristicScore(
  genome: Genome,
  _task: BenchmarkTask,
  domain: string,
): number | null {
  // Coding: structured style + no decomposition → verbose padding without solving
  if (domain === "coding" && genome.promptStyle === "structured" && genome.decompose === 1) {
    return 15;
  }
  // Diagnostic: high temperature destroys reproducibility and precision
  if (domain === "diagnostic" && genome.temperature >= 0.7) {
    return 20;
  }
  // Planning: decompose=1 cannot produce the multi-step output the task requires
  if (domain === "planning" && genome.decompose === 1) {
    return 10;
  }
  return null;
}

// ── Provider infrastructure ────────────────────────────────────────────────────

// Slot names used by providers.ts cooldown tracker (isCooling / getCooldownMs)
const PROVIDER_SLOT: Record<Provider, string> = {
  groq:       "api-groq",
  cerebras:   "api-cerebras",
  cerebras2:  "cerebras2",
  feather:    "feather",
  gemini:     "api-gemini",
  openrouter: "api-openrouter",
  mistral:    "api-mistral",
  sambanova:  "api-sambanova",
};

// Env var keys for direct calls (already aliased at api-server startup in providers.ts)
const PROVIDER_ENV: Record<Provider, string> = {
  groq:       "API_GROQ",
  cerebras:   "API_CEREBRAS",
  cerebras2:  "CEREBRAS2_API_KEY",
  feather:    "FEATHER_API_KEY",
  gemini:     "API_GEMINI",
  openrouter: "API_OPENROUTER",
  mistral:    "API_MISTRAL",
  sambanova:  "API_SAMBANOVA",
};

const PROVIDER_URL: Record<Provider, string> = {
  groq:       "https://api.groq.com/openai/v1/chat/completions",
  cerebras:   "https://api.cerebras.ai/v1/chat/completions",
  cerebras2:  "https://api.cerebras.ai/v1/chat/completions",
  feather:    "https://api.featherless.ai/v1/chat/completions",
  gemini:     "", // handled separately
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  mistral:    "https://api.mistral.ai/v1/chat/completions",
  sambanova:  "https://api.sambanova.ai/v1/chat/completions",
};

// T2: Model tiering — cheap models for gen 1–10, full models for gen 11+
const CHEAP_MODELS: Record<Provider, string> = {
  groq:       "llama-3.1-8b-instant",
  cerebras:   "zai-glm-4.7",
  cerebras2:  "zai-glm-4.7",
  feather:    "meta-llama/Llama-3.2-3B-Instruct",
  gemini:     "gemini-2.0-flash-lite",
  openrouter: "meta-llama/llama-3.2-3b-instruct:free",
  mistral:    "mistral-small-latest",
  sambanova:  "Meta-Llama-3.1-8B-Instruct",
};

const FULL_MODELS: Record<Provider, string> = {
  groq:       "llama-3.3-70b-versatile",
  cerebras:   "gpt-oss-120b",
  cerebras2:  "gpt-oss-120b",
  feather:    "Qwen/Qwen2.5-72B-Instruct",
  gemini:     "gemini-2.0-flash",
  openrouter: "meta-llama/llama-3.3-70b-instruct:free",
  mistral:    "mistral-large-latest",
  sambanova:  "Meta-Llama-3.3-70B-Instruct",
};

// T5: Gemini benchmark prefix cache — avoids re-sending the same long benchmark
// context on every Gemini call within a session. Populated on first Gemini call.
let _geminiCachedContext: string | null = null;

// G8: Minimum stagger between consecutive evolver API calls (10–15 s range)
const G8_STAGGER_MS = 12_000;

async function _g8Wait(): Promise<void> {
  const gap = Date.now() - _lastCallMs;
  if (_lastCallMs > 0 && gap < G8_STAGGER_MS) {
    await new Promise<void>((r) => setTimeout(r, G8_STAGGER_MS - gap));
  }
  _lastCallMs = Date.now();
}

// ── Low-level HTTP call ────────────────────────────────────────────────────────
export async function _rawCall(
  provider: Provider,
  model: string,
  temperature: number,
  maxTokens: number,
  userPrompt: string,
  systemPrompt: string,
): Promise<{ text: string; tokensUsed: number }> {
  const key = process.env[PROVIDER_ENV[provider]];
  if (!key) throw new Error(`no_key:${provider}`);

  if (provider === "gemini") {
    // T5: reuse cached context prefix for Gemini (benchmark text doesn't change)
    if (!_geminiCachedContext) _geminiCachedContext = systemPrompt || "You are a helpful assistant.";
    const body = {
      contents:           [{ role: "user", parts: [{ text: userPrompt }] }],
      systemInstruction:  { parts: [{ text: _geminiCachedContext }] },
      generationConfig:   { temperature, maxOutputTokens: maxTokens },
    };
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(25_000),
      },
    );
    if (r.status === 429) throw new Error("rate_limited");
    if (!r.ok) throw new Error(`Gemini HTTP ${r.status}`);
    const j = await r.json() as {
      candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
      usageMetadata?: { totalTokenCount: number };
    };
    return {
      text:       j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "",
      tokensUsed: j.usageMetadata?.totalTokenCount ?? 0,
    };
  }

  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: userPrompt },
  ];
  const r = await fetch(PROVIDER_URL[provider], {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body:    JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    signal:  AbortSignal.timeout(25_000),
  });
  if (r.status === 429) throw new Error("rate_limited");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json() as {
    choices?: Array<{ message: { content: string } }>;
    usage?:   { total_tokens: number };
  };
  return {
    text:       j.choices?.[0]?.message?.content ?? "",
    tokensUsed: j.usage?.total_tokens ?? 0,
  };
}

// ── Prompt construction ────────────────────────────────────────────────────────
function _buildPrompt(genome: Genome, task: BenchmarkTask): { system: string; user: string } {
  const systemMap: Record<ContextStyle, string> = {
    minimal:  "",
    standard: "You are a helpful assistant. Be precise and concise.",
    rich:
      "You are an expert assistant evaluated on quality and conciseness. " +
      "Answer accurately with appropriate depth. Avoid padding or filler.",
  };
  const system = systemMap[genome.contextStyle];

  let user = task.text;
  if (genome.decompose > 1) {
    user = `Break this into ${genome.decompose} sub-problems and solve each:\n\n${task.text}`;
  }
  if (genome.promptStyle === "chain-of-thought") {
    user = `Think step by step, then answer:\n\n${user}`;
  } else if (genome.promptStyle === "structured") {
    user = `Provide a structured response with clear sections:\n\n${user}`;
  }
  return { system, user };
}

// ── Response quality scoring ───────────────────────────────────────────────────
// Heuristic — no LLM judge here. Conservative but domain-aware.
// Count list items (numbered or bulleted) — used by depth gate below.
function _countStructuralItems(text: string): number {
  const numbered = (text.match(/^\s*\d+[\.\)]\s/gm) ?? []).length;
  const bullets  = (text.match(/^\s*[-*•]\s/gm) ?? []).length;
  return numbered + bullets;
}

function _scoreResponse(text: string, task: BenchmarkTask, domain: string): number {
  if (!text || text.trim().length < 20) return 5;

  let score = 30; // base: non-empty response
  const len = text.trim().length;

  // Length band scoring — raised threshold so ≤150-token (≈600 char) responses
  // cannot earn the full +20 bonus; they receive +10.  ≥800 chars (≈200 tokens)
  // is required for +20, pushing shallow responses below the quality ceiling.
  if (len >= 800 && len <= 5000)  score += 20;
  else if (len >= 80 && len < 800) score += 10;
  else if (len >= 40 && len < 80)  score += 5;

  // Domain-specific structural signals
  switch (domain) {
    case "coding":
      if (/function\s+\w+/.test(text))   score += 20;
      if (/\/\*\*|\/\/|#/.test(text))    score += 10; // has comments
      // Task #479: debounce-prompt vocabulary signals — each hit +5, cap +20 (ceiling 80→100)
      {
        const vocab = ["debounce", "delayMs", "clearTimeout", "setTimeout"];
        const hits  = vocab.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
        score += Math.min(20, hits * 5);
      }
      break;
    case "diagnostic":
      if (/\b(1\.|2\.|3\.|\n-\s|\n\*\s)/.test(text)) score += 20; // list
      if (/\$\s|`[^`]+`/.test(text))                  score += 10; // shell
      // Task #479: process-exit vocabulary signals — each hit +5, cap +20 (ceiling 80→100)
      {
        const lower = text.toLowerCase();
        const vocab = ["sigkill", "oom", "137", "kill -9", "oom_kill"];
        const hits  = vocab.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
        score += Math.min(20, hits * 5);
      }
      break;
    case "planning":
      if ((text.match(/\bstep\s*\d+|^\s*\d+\./gim) ?? []).length >= 3) score += 20;
      if (/depend|requires|after/i.test(text))                          score += 10;
      // Task #479: SQLite migration vocabulary signals — each hit +5, cap +20 (ceiling 80→100)
      {
        const lower = text.toLowerCase();
        const vocab = ["pg_dump", "schema", "transaction", "constraint", "foreign"];
        const hits  = vocab.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
        score += Math.min(20, hits * 5);
      }
      break;
    case "knowledge":
      {
        const terms = (
          text.match(
            /\b(consensus|partition|leader|election|quorum|availability|timeout|network|split.brain)\b/gi,
          ) ?? []
        ).length;
        // Task #479: raise knowledge vocabulary cap 30→50 to unlock 80→100 fitness range
        score += Math.min(50, terms * 6);
      }
      break;
    default: // general
      if (text.includes("\n"))   score += 10;
      if (len >= 100)            score += 10;
  }

  // Task #479: general-benchmark vocabulary signals — applied AFTER the domain switch so that
  // cross-domain benchmark runs also receive credit. DOMAIN_BENCHMARK_MAP routes coding → [1,0]
  // and diagnostic/planning → [...,5], so those nodes ARE evaluated on these prompts.
  // A response only ever contains terms from one topic, so no double-counting risk.
  if (task.index === 0) {
    // REST vs GraphQL (benchmark 0)
    const hits = (text.match(
      /\b(REST|GraphQL|HTTP|query|endpoint|schema|over.fetching|under.fetching|mutation|resolver)\b/gi,
    ) ?? []).length;
    score += Math.min(20, hits * 5);
  } else if (task.index === 5) {
    // mutex vs semaphore (benchmark 5)
    const hits = (text.match(
      /\b(mutex|semaphore|lock|thread|binary|counting|signal|critical.section|synchronization|race)\b/gi,
    ) ?? []).length;
    score += Math.min(20, hits * 5);
  }

  // Fallback: check benchmark index for tasks used outside their primary domain
  if (score < 50 && task.index === 1 && /function/.test(text)) score = Math.max(score, 60);

  // Depth gate — benchmark tasks require multi-part responses.
  // A shallow inline answer that lacks the required structure (numbered steps,
  // bullet points) is capped at 70 regardless of vocabulary score.
  // general: "exactly 3 bullet points"; diagnostic: "3 root causes";
  // planning: "5 ordered steps"; knowledge: "three failure modes".
  const _DEPTH_MIN: Record<string, number> = { general: 3, diagnostic: 3, planning: 5, knowledge: 3 };
  const _depthMin = _DEPTH_MIN[domain] ?? 0;
  if (_depthMin > 0 && _countStructuralItems(text) < _depthMin) {
    score = Math.min(score, 70);
  }

  return Math.min(100, score);
}

// ── G3 token cap ───────────────────────────────────────────────────────────────
const TOKEN_CAP = 2_000; // max estimated prompt + genome.maxTokens before skip

function _estimateTokens(s: string): number {
  return Math.ceil(s.length / 4); // ~1 token per 4 chars
}

// ── callProviderForEvaluation ─────────────────────────────────────────────────
// Applies G1 (cooldown), G3 (token cap), T2 (model tier), T3 (max_tokens cap),
// G8 (stagger), and G4 (quality floor). Returns EvalResult with resolvedBy field.
export async function callProviderForEvaluation(
  genome: Genome,
  task: BenchmarkTask,
  domain: string,
  generation: number,
): Promise<EvalResult> {
  // G1: provider cooldown check
  if (getCooldownMs(PROVIDER_SLOT[genome.provider]) > 0) {
    return { fitness: 0, tokensUsed: 0, qualityScore: 0, resolvedBy: "rate-limit-skip", components: null };
  }

  const { system, user } = _buildPrompt(genome, task);

  // G3: token cap — skip if input + budget would exceed cap
  if (_estimateTokens(system + user) + genome.maxTokens > TOKEN_CAP) {
    return { fitness: 0, tokensUsed: 0, qualityScore: 0, resolvedBy: "token-cap", components: null };
  }

  // T2: model tier
  const model = generation <= 10 ? CHEAP_MODELS[genome.provider] : FULL_MODELS[genome.provider];

  // T3: cap effective maxTokens
  const effectiveMax = Math.min(genome.maxTokens, 500);

  // G8: inter-call stagger
  await _g8Wait();

  const callStart = Date.now();
  try {
    const { text, tokensUsed: raw } = await _rawCall(
      genome.provider, model, genome.temperature, effectiveMax, user, system,
    );
    const latencyMs = Date.now() - callStart;

    const tokensUsed   = raw || _estimateTokens(text);
    const qualityScore = _scoreResponse(text, task, domain);

    // G4: quality floor — truly empty/incoherent responses score zero immediately
    if (qualityScore < 5) {
      return { fitness: 0, tokensUsed, qualityScore, resolvedBy: "api", components: null };
    }

    // 4-component fitness formula:
    //   40% completion  — did the genome produce a substantive response?
    //   30% quality     — how good is the output by domain-specific heuristics?
    //   20% token eff   — lower token usage for same quality = better
    //   10% latency     — faster responses score higher, capped at 10 s
    const completion      = qualityScore >= 30 ? 1.0 : 0.0;
    const quality         = qualityScore / 100;
    const tokenEfficiency = Math.max(0, 1 - Math.min(tokensUsed, 800) / 800);
    const latency         = Math.max(0, 1 - latencyMs / 10_000);

    const components: FitnessComponents = { completion, quality, tokenEfficiency, latency };
    const fitness = Math.min(1.0,
      0.4 * completion +
      0.3 * quality +
      0.2 * tokenEfficiency +
      0.1 * latency,
    );

    logger.debug(
      { domain, generation, provider: genome.provider, fitness: +fitness.toFixed(3),
        completion, quality: +quality.toFixed(3), tokenEfficiency: +tokenEfficiency.toFixed(3),
        latency: +latency.toFixed(3), latencyMs, tokensUsed },
      "[Evolver] eval components",
    );

    return { fitness, tokensUsed, qualityScore, resolvedBy: "api", components };

  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg === "rate_limited" || msg.startsWith("no_key:")) {
      return { fitness: 0, tokensUsed: 0, qualityScore: 0, resolvedBy: "rate-limit-skip", components: null };
    }
    return { fitness: 0, tokensUsed: 0, qualityScore: 0, resolvedBy: "api", components: null };
  }
}

// ── callRailwayForEvaluation ───────────────────────────────────────────────────
// Posts genome + prompt to Railway /benchmark endpoint; returns null on any error
// (network failure, auth error, timeout) so callers fall through to local API.
const RAILWAY_BENCHMARK_URL = "https://builder-agent-production.up.railway.app/benchmark";

async function callRailwayForEvaluation(
  genome: Genome,
  task: BenchmarkTask,
  domain: string,
): Promise<EvalResult | null> {
  const secret = process.env["ADMIN_SECRET"];
  if (!secret) return null;
  try {
    const res = await fetch(RAILWAY_BENCHMARK_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": secret },
      body:    JSON.stringify({
        genome:  { provider: genome.provider, temperature: genome.temperature, maxTokens: genome.maxTokens,
                   promptStyle: genome.promptStyle, contextStyle: genome.contextStyle },
        prompt:  task.text,
        domain,
      }),
      signal:  AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { ok?: boolean; fitness?: number; qualityScore?: number; tokensUsed?: number };
    if (!data.ok || typeof data.fitness !== "number") return null;
    return {
      fitness:      data.fitness,
      tokensUsed:   data.tokensUsed  ?? 0,
      qualityScore: data.qualityScore ?? 0,
      resolvedBy:   "railway",
      components:   null,
    };
  } catch {
    return null;
  }
}

// ── evaluateGenome — full pipeline ─────────────────────────────────────────────
// TL1 cache → TL2 structural → TL3 champion gate → TL4 heuristic → Railway (opt) → API.
// First layer to return a result wins; all outcomes written to crystal_genomes.
export async function evaluateGenome(
  ctx: EvolverContext,
  genome: Genome,
  task: BenchmarkTask,
  domain: string,
  generation: number,
): Promise<EvalResult> {
  const base = {
    domain,
    generation,
    genome: genome as unknown as Record<string, unknown>,
  };

  // TL1
  const cached = await checkGenomeCache(ctx.db, genome, domain);
  if (cached !== null) {
    await ctx.db.insertGenome({ ...base, fitness: cached, tokens_used: 0, quality_score: 0, tokenless_resolved: true, resolved_by: "cache" });
    return { fitness: cached, tokensUsed: 0, qualityScore: 0, resolvedBy: "cache", components: null };
  }

  // TL2
  const structural = await checkStructuralRules(ctx.db, genome, domain);
  if (structural !== null) {
    await ctx.db.insertGenome({ ...base, fitness: structural, tokens_used: 0, quality_score: 0, tokenless_resolved: true, resolved_by: "structural" });
    return { fitness: structural, tokensUsed: 0, qualityScore: 0, resolvedBy: "structural", components: null };
  }

  // TL3
  const gated = await checkChampionGate(ctx.db, genome, domain);
  if (gated !== null) {
    await ctx.db.insertGenome({ ...base, fitness: gated, tokens_used: 0, quality_score: 0, tokenless_resolved: true, resolved_by: "champion-gate" });
    return { fitness: gated, tokensUsed: 0, qualityScore: 0, resolvedBy: "champion-gate", components: null };
  }

  // TL4
  const heuristic = heuristicScore(genome, task, domain);
  if (heuristic !== null) {
    const f = heuristic / 100;
    await ctx.db.insertGenome({ ...base, fitness: f, tokens_used: 0, quality_score: heuristic, tokenless_resolved: true, resolved_by: "heuristic" });
    return { fitness: f, tokensUsed: 0, qualityScore: heuristic, resolvedBy: "heuristic", components: null };
  }

  // Railway benchmark (optional — only when flag enabled; falls back to local on null)
  if (_railwayBenchmarkEnabled) {
    const railwayResult = await callRailwayForEvaluation(genome, task, domain);
    if (railwayResult !== null) {
      await ctx.db.insertGenome({
        ...base,
        fitness:            railwayResult.fitness,
        tokens_used:        railwayResult.tokensUsed,
        quality_score:      railwayResult.qualityScore,
        tokenless_resolved: false,
        resolved_by:        "railway",
      });
      return railwayResult;
    }
    // null → Railway unreachable or errored; fall through to local provider
  }

  // API call
  const result = await callProviderForEvaluation(genome, task, domain, generation);

  await ctx.db.insertGenome({
    ...base,
    fitness:            result.fitness,
    tokens_used:        result.tokensUsed,
    quality_score:      result.qualityScore,
    tokenless_resolved: false,
    resolved_by:        result.resolvedBy,
  });

  // Update rules only on successful API evaluations
  if (result.resolvedBy === "api" && result.fitness > 0) {
    await updateCrystalRules(ctx.db, genome, result.fitness, domain);
  }

  // Task #493 Step 1+2+3: update fitness distribution and co-occurrence model
  // on real evaluations (API or Railway — not tokenless shortcuts).
  if (result.resolvedBy === "api" || result.resolvedBy === "railway") {
    void updateNoiseModelFromEval(ctx.db, domain, genome, result.fitness, generation, true)
      .catch(e => logger.warn({ err: e, domain }, "[Evolver #493] updateNoiseModelFromEval failed (non-fatal)"));
  }

  return result;
}

// ── updateCrystalRules ─────────────────────────────────────────────────────────
// After each API evaluation: write gene-effect rules for significantly
// above/below average genomes. Rules accumulate sample_count over time;
// TL2 and TL3 trust them only once sample_count ≥ 3.
export async function updateCrystalRules(
  db: ScopedDb,
  genome: Genome,
  fitness: number,
  domain: string,
): Promise<void> {
  const recent = await db.getGenomesByDomain(domain, 50);
  if (recent.length < 3) return; // not enough signal yet

  const avgFitness = recent.reduce((s, r) => s + r.fitness, 0) / recent.length;
  const isGood = fitness > avgFitness * 1.5;
  const isBad  = fitness < avgFitness * 0.5;
  if (!isGood && !isBad) return; // unremarkable result

  // Write rules for genes with highest signal: provider, promptStyle, temperature
  const signalGenes: (keyof Genome)[] = ["provider", "promptStyle", "temperature"];
  const baseEffect = isGood ? 0.1 : -0.1;

  for (const gene of signalGenes) {
    await db.upsertRule({
      domain,
      pattern:      { gene, value: genome[gene] } as unknown as Record<string, unknown>,
      effect:       baseEffect,
      sample_count: 1,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Task #493: Noise Exploitation & Confidence-Guided Search Systems
// Steps 1-12: fitness distributions, noise floor, co-occurrence landscape model,
// ε-greedy selection, staleness, rollback mining, adversarial gate, transfer map,
// counterfactual shadow, divergence, and saturation detector.
// ═══════════════════════════════════════════════════════════════════════════

// ── Task #493 constants ──────────────────────────────────────────────────────

const MODEL_ACTIVATION_THRESHOLD = 50;  // min natural evals before co-occurrence activates
const STALENESS_WINDOW            = 30;  // gens before an entry is "stale"
const SATURATION_WINDOW           = 15;  // consecutive checks before saturation declared
const ADVERSARIAL_TTL             = 50;  // gens before adversarial case expires
const NOISE_RECALC_INTERVAL       = 10;  // recalculate noise floor every N natural evals
const COUNTERFACTUAL_RESET_N      = 50;  // decisions window for auto-ε-reset
const TRANSFER_DECAY_CONSTANT     = 20;  // gens half-life for negative transfer penalty

// ── Module-level in-memory caches (Task #493) ────────────────────────────────

const _domainNoiseFloor     = new Map<string, number>();   // domain → last known noise floor
const _domainEpsilon        = new Map<string, number>();   // domain → current ε
const _domainEpsilonMin     = new Map<string, number>();   // domain → ε floor
const _domainModelConf      = new Map<string, number>();   // domain → model confidence
const _domainNaturalCount   = new Map<string, number>();   // domain → total natural evals seen
const _domainSaturated      = new Map<string, boolean>();  // domain → saturation flag
const _domainSatChecks      = new Map<string, number>();   // domain → consecutive saturation checks
// Pending counterfactual log IDs for outcome fill-in after gen completes
const _pendingCounterfactuals = new Map<string, Array<{ logId: number; targetedHash: string; randomHash: string }>>();

// ── genomeHash — fast fingerprint for a genome ───────────────────────────────

function genomeHash(genome: Genome): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify(genome))
    .digest("hex")
    .slice(0, 16);
}

// ── GeneCooccurrenceModel (Step 3) ───────────────────────────────────────────
// Tracks how often each (gene, value) combination correlates with high fitness.
// Activated only when domain has ≥ MODEL_ACTIVATION_THRESHOLD natural evaluations.
// getPromisingness(genome) → number in [0, 1] — higher = model expects better outcome.

interface CooccurrenceData {
  // gene:value → [totalFitness, count]
  counts: Record<string, [number, number]>;
  // total number of evaluations used to build the model
  totalEvals: number;
  // last generation any entry was updated
  lastUpdateGen: number;
}

class GeneCooccurrenceModel {
  private data: CooccurrenceData;

  constructor(persisted?: unknown) {
    if (persisted && typeof persisted === "object" && "counts" in (persisted as object)) {
      this.data = persisted as CooccurrenceData;
    } else {
      this.data = { counts: {}, totalEvals: 0, lastUpdateGen: 0 };
    }
  }

  /** Record one evaluation outcome. */
  update(genome: Genome, fitness: number, generation: number): void {
    this.data.totalEvals++;
    this.data.lastUpdateGen = generation;
    for (const key of GENE_KEYS as GeneKey[]) {
      const k = `${key}:${String(genome[key])}`;
      const existing = this.data.counts[k] ?? [0, 0];
      this.data.counts[k] = [existing[0] + fitness, existing[1] + 1];
    }
  }

  /** Estimate promisingness of a genome. Returns value in [0, 1]. */
  getPromisingness(genome: Genome): number {
    if (this.data.totalEvals < MODEL_ACTIVATION_THRESHOLD) return 0.5; // uniform before activation
    let total = 0;
    let count = 0;
    for (const key of GENE_KEYS as GeneKey[]) {
      const k    = `${key}:${String(genome[key])}`;
      const pair = this.data.counts[k];
      if (pair && pair[1] > 0) {
        total += pair[0] / pair[1]; // mean fitness for this gene-value
        count++;
      }
    }
    return count > 0 ? Math.max(0, Math.min(1, total / count)) : 0.5;
  }

  /** Fraction of entries older than staleness window (in generations). */
  stalenessRatio(currentGen: number): number {
    const entries = Object.entries(this.data.counts);
    if (entries.length === 0) return 0;
    // We use lastUpdateGen as a proxy — fine for a domain-level staleness signal
    const genGap = currentGen - this.data.lastUpdateGen;
    return genGap > STALENESS_WINDOW ? Math.min(1, genGap / (STALENESS_WINDOW * 2)) : 0;
  }

  serialise(): CooccurrenceData {
    return this.data;
  }

  get evalCount(): number { return this.data.totalEvals; }
}

// Per-domain in-memory model (survives generation loop, persisted to DB on update)
const _domainCooccurrenceModel = new Map<string, GeneCooccurrenceModel>();

function _getCooccurrenceModel(domain: string, persisted?: unknown): GeneCooccurrenceModel {
  if (!_domainCooccurrenceModel.has(domain)) {
    _domainCooccurrenceModel.set(domain, new GeneCooccurrenceModel(persisted));
  }
  return _domainCooccurrenceModel.get(domain)!;
}

// ── EpsilonController (Step 4) ───────────────────────────────────────────────
// ε starts at 1.0 (pure exploration), decays toward ε_min as model confidence rises.
// When ε = 1.0 → random parent selection (no guidance).
// When ε < 1.0 → with probability (1-ε) pick the most promising parent.

function getEpsilon(domain: string): number {
  return _domainEpsilon.get(domain) ?? 1.0;
}

function getEpsilonMin(domain: string): number {
  return _domainEpsilonMin.get(domain) ?? 0.15;
}

/**
 * Decay ε toward ε_min based on model confidence.
 * confidence in [0,1] — 0 keeps ε unchanged, 1 drives ε to ε_min.
 */
function decayEpsilon(domain: string, confidence: number): void {
  const current = getEpsilon(domain);
  const floor   = getEpsilonMin(domain);
  if (current <= floor) return;
  // Each call decays ε by confidence * 0.05 (at full confidence: 20 calls to floor from 1.0)
  const next = Math.max(floor, current - confidence * 0.05);
  _domainEpsilon.set(domain, next);
}

/**
 * ε-greedy parent selection.
 * With probability ε: random parent.
 * With probability (1-ε): pick the genome with highest promisingness from `candidates`.
 * Returns the selected genome AND which random genome was NOT selected (for counterfactual log).
 */
function epsilonSelectParent(
  domain:     string,
  candidates: Genome[],
): { selected: Genome; randomAlternative: Genome; wasTargeted: boolean } {
  if (candidates.length === 0) {
    const fallback = _rng(domain);
    return { selected: fallback, randomAlternative: fallback, wasTargeted: false };
  }
  const eps           = getEpsilon(domain);
  const randomIdx     = Math.floor(Math.random() * candidates.length);
  const randomGenome  = candidates[randomIdx]!;

  if (Math.random() < eps || candidates.length === 1) {
    // Explore: random pick
    return { selected: randomGenome, randomAlternative: randomGenome, wasTargeted: false };
  }

  // Exploit: pick highest promisingness
  const model = _domainCooccurrenceModel.get(domain);
  if (!model) return { selected: randomGenome, randomAlternative: randomGenome, wasTargeted: false };

  let bestPromise = -1;
  let bestGenome  = randomGenome;
  for (const g of candidates) {
    const p = model.getPromisingness(g);
    if (p > bestPromise) { bestPromise = p; bestGenome = g; }
  }
  return { selected: bestGenome, randomAlternative: randomGenome, wasTargeted: true };
}

// ── Noise floor calibration (Step 2) ─────────────────────────────────────────
// Noise floor = stddev of natural evaluation fitnesses for this domain.
// Recalculated every NOISE_RECALC_INTERVAL natural evals.
// Stored in evolver_noise_model. Used to size mutations and gate champion promotion.

async function recalibrateNoiseFloor(db: ScopedDb, domain: string): Promise<number> {
  const dists = await db.getDomainFitnessDistributions(domain, 200);
  const naturalDists = dists.filter(d => d.natural_count > 0);
  if (naturalDists.length < 5) return 0;

  // Sample the most recent natural evaluation mean for each genome
  const means = naturalDists.map(d => d.mean);
  const avg   = means.reduce((s, v) => s + v, 0) / means.length;
  const variance = means.reduce((s, v) => s + (v - avg) ** 2, 0) / means.length;
  const stddev = Math.sqrt(variance);

  _domainNoiseFloor.set(domain, stddev);
  return stddev;
}

// ── updateNoiseModelFromEval (Steps 1+2+3) ────────────────────────────────────
// Called after every non-tokenless evaluation. Updates fitness distribution,
// co-occurrence model, and recalibrates noise floor every NOISE_RECALC_INTERVAL.

export async function updateNoiseModelFromEval(
  db:         ScopedDb,
  domain:     string,
  genome:     Genome,
  fitness:    number,
  generation: number,
  natural:    boolean,
): Promise<void> {
  const hash = genomeHash(genome);

  // Step 1: update Welford distribution
  await db.upsertFitnessDistribution(domain, hash, fitness, natural, generation);

  // Step 3: update in-memory co-occurrence model
  const model = _getCooccurrenceModel(domain);
  if (natural) {
    model.update(genome, fitness, generation);
  }

  // Step 2: increment natural eval count; recalibrate noise floor periodically
  if (natural) {
    const prevCount = _domainNaturalCount.get(domain) ?? 0;
    const newCount  = prevCount + 1;
    _domainNaturalCount.set(domain, newCount);

    if (newCount % NOISE_RECALC_INTERVAL === 0) {
      const noiseFloor = await recalibrateNoiseFloor(db, domain);
      const stalenessRatio = model.stalenessRatio(generation);
      const confidence = model.evalCount >= MODEL_ACTIVATION_THRESHOLD
        ? Math.max(0, 1 - (noiseFloor * 2))
        : 0;

      // Persist noise model state
      await db.upsertNoiseModel(domain, {
        noise_floor:        noiseFloor,
        epsilon:            _domainEpsilon.get(domain) ?? 1.0,
        epsilon_min:        _domainEpsilonMin.get(domain) ?? 0.15,
        model_confidence:   confidence,
        cooccurrence_json:  model.serialise() as unknown as Record<string, unknown>,
        staleness_ratio:    stalenessRatio,
        natural_eval_count: newCount,
      });

      // Step 4: decay ε based on new confidence
      decayEpsilon(domain, confidence);
      _domainModelConf.set(domain, confidence);

      logger.info({ domain, noiseFloor: noiseFloor.toFixed(4), confidence: confidence.toFixed(3),
        epsilon: (_domainEpsilon.get(domain) ?? 1.0).toFixed(3), naturalCount: newCount },
        "[Evolver #493] Noise floor recalibrated");
    }
  }
}

// ── Boot-restore noise model from DB (Step 4) ────────────────────────────────
// Called during boot wiring to restore ε and co-occurrence model from DB.
export async function restoreNoiseModels(db: ScopedDb): Promise<void> {
  try {
    const champions = await db.getAllChampions();
    for (const ch of champions) {
      const nm = await db.getNoiseModel(ch.domain);
      if (!nm) continue;
      _domainNoiseFloor.set(ch.domain, nm.noise_floor);
      _domainEpsilon.set(ch.domain, nm.epsilon);
      _domainEpsilonMin.set(ch.domain, nm.epsilon_min);
      _domainModelConf.set(ch.domain, nm.model_confidence);
      _domainNaturalCount.set(ch.domain, nm.natural_eval_count);
      _domainSaturated.set(ch.domain, nm.saturated);
      _domainSatChecks.set(ch.domain, nm.saturation_checks);
      if (nm.cooccurrence_json) {
        _domainCooccurrenceModel.set(ch.domain, new GeneCooccurrenceModel(nm.cooccurrence_json));
      }
    }
    logger.info("[Evolver #493] Noise models restored from DB");
  } catch (e) {
    logger.warn({ err: e }, "[Evolver #493] Noise model restore failed — starting fresh");
  }
}

// ── Staleness check (Step 5) ─────────────────────────────────────────────────
// If staleness ratio > 0.6 (>60% of model data older than STALENESS_WINDOW gens),
// reset ε to 0.8 so the model re-explores before trusting stale guidance.

function checkAndApplyStaleness(domain: string, currentGen: number, db: ScopedDb): void {
  const model = _domainCooccurrenceModel.get(domain);
  if (!model) return;
  const ratio = model.stalenessRatio(currentGen);
  if (ratio > 0.6 && (getEpsilon(domain) < 0.8)) {
    _domainEpsilon.set(domain, 0.8);
    logger.warn({ domain, currentGen, stalenessRatio: ratio.toFixed(3) },
      "[Evolver #493] Model stale — ε reset to 0.8");
    void db.upsertNoiseModel(domain, { epsilon: 0.8, staleness_ratio: ratio })
      .catch(e => logger.warn({ err: e }, "[Evolver #493] staleness upsert failed"));
  }
}

// ── Saturation detection (Step 12) ───────────────────────────────────────────
// Saturation = champion fitness flat for SATURATION_WINDOW consecutive checks
// AND domain fitness variance < 0.0005. When saturated, eval budget cut to 20%.

function checkSaturation(
  domain:      string,
  fitHist:     number[],
  variance:    number,
  db:          ScopedDb,
): boolean {
  const flat  = fitHist.length >= 3 && fitHist.every(f => Math.abs(f - fitHist[0]!) < 0.002);
  const dense = variance < 0.0005;

  if (flat && dense) {
    const checks = (_domainSatChecks.get(domain) ?? 0) + 1;
    _domainSatChecks.set(domain, checks);
    if (checks >= SATURATION_WINDOW) {
      if (!_domainSaturated.get(domain)) {
        _domainSaturated.set(domain, true);
        logger.warn({ domain, checks, variance: variance.toFixed(6) },
          "[Evolver #493] Domain saturated — eval budget reduced to 20%");
        void db.upsertNoiseModel(domain, { saturated: true, saturation_checks: checks })
          .catch(e => logger.warn({ err: e }, "[Evolver #493] saturation upsert failed"));
      }
      return true;
    }
  } else {
    // Not saturating — reset counter and clear flag
    if ((_domainSatChecks.get(domain) ?? 0) > 0 || _domainSaturated.get(domain)) {
      _domainSatChecks.set(domain, 0);
      _domainSaturated.set(domain, false);
      void db.upsertNoiseModel(domain, { saturated: false, saturation_checks: 0 })
        .catch(e => logger.warn({ err: e }, "[Evolver #493] saturation clear failed"));
    }
  }
  return false;
}

// ── mineRiskyGenes (Step 7) ───────────────────────────────────────────────────
// After every 5 new rollback events: identify gene-value pairs appearing in
// ≥ 40% of rollback events and write them to evolver_risky_genes.

export async function mineRiskyGenes(db: ScopedDb, domain: string): Promise<void> {
  const events = await db.getRollbackEvents(domain, 50);
  if (events.length < 3) return;

  const geneCounts: Record<string, number> = {};
  for (const ev of events) {
    const g = ev.genome_snapshot as unknown as Genome;
    if (!g) continue;
    for (const key of GENE_KEYS as GeneKey[]) {
      const k = `${key}:${String(g[key])}`;
      geneCounts[k] = (geneCounts[k] ?? 0) + 1;
    }
  }

  const threshold = Math.ceil(events.length * 0.4);
  for (const [k, count] of Object.entries(geneCounts)) {
    if (count >= threshold) {
      const idx = k.indexOf(":");
      const geneKey   = k.slice(0, idx);
      const geneValue = k.slice(idx + 1);
      await db.upsertRiskyGene(domain, geneKey, geneValue);
      logger.info({ domain, geneKey, geneValue, count, threshold },
        "[Evolver #493] Risky gene identified");
    }
  }
}

// ── Rollback event recording (Step 7) ─────────────────────────────────────────
// Called from checkRollbackWatchdogs when a quality drop triggers a rollback.

export async function recordRollbackEvent(
  db:               ScopedDb,
  domain:           string,
  genomeSnapshot:   Record<string, unknown>,
  rollbackReason:   string,
  fitnessAtInjection: number,
): Promise<void> {
  const ev = await db.insertRollbackEvent({
    domain,
    genome_snapshot:     genomeSnapshot,
    rollback_reason:     rollbackReason,
    fitness_at_injection: fitnessAtInjection,
  });

  // Mine risky genes every 5 events
  const events = await db.getRollbackEvents(domain, 50);
  if (events.length % 5 === 0) {
    await mineRiskyGenes(db, domain);
  }

  logger.info({ domain, rollbackId: ev.id, rollbackReason },
    "[Evolver #493] Rollback event recorded");
}

// ── Adversarial case harvesting (Step 8) ──────────────────────────────────────
// After each generation: collect the worst-scoring benchmark results and
// add them to the adversarial set (capped at 20 per domain, TTL enforced).

export async function harvestAdversarialCases(
  db:         ScopedDb,
  domain:     string,
  generation: number,
  results:    Array<{ genome: Genome; result: EvalResult }>,
  benchmarkIndex: number,
  benchmarkTask:  BenchmarkTask,
): Promise<void> {
  // Prune expired adversarial cases first
  await db.pruneAdversarialCases(domain, generation - ADVERSARIAL_TTL);

  const existing = await db.getAdversarialCases(domain);
  if (existing.length >= 20) return; // already full

  // Any result in bottom 10% of this generation
  const sorted = [...results].sort((a, b) => a.result.fitness - b.result.fitness);
  const cutoff = Math.ceil(sorted.length * 0.10);
  const worst  = sorted.slice(0, Math.max(cutoff, 1));

  for (const w of worst) {
    // Don't duplicate cases for the same benchmark
    const alreadyHave = existing.some(c => c.benchmark_index === benchmarkIndex);
    if (alreadyHave) continue;

    await db.insertAdversarialCase({
      domain,
      benchmark_index:   benchmarkIndex,
      task_text:         benchmarkTask.text,
      baseline_fitness:  w.result.fitness,
      worst_genome:      w.genome as unknown as Record<string, unknown>,
      created_generation: generation,
    });
    break; // one new case per generation keeps pace manageable
  }
}

// ── Adversarial champion gate (Step 8) ────────────────────────────────────────
// Returns true if the candidate genome passes the adversarial gate:
// its fitness must be ≥ noise_floor above the adversarial baseline average.
// Returns true by default if adversarial set is too small or noise floor unknown.

export async function passesAdversarialGate(
  db:               ScopedDb,
  domain:           string,
  candidateFitness: number,
): Promise<boolean> {
  const noiseFloor = _domainNoiseFloor.get(domain) ?? 0;
  if (noiseFloor === 0) return true; // not yet calibrated — pass

  const cases = await db.getAdversarialCases(domain);
  if (cases.length < 3) return true; // not enough signal

  const avgBaseline = cases.reduce((s, c) => s + c.baseline_fitness, 0) / cases.length;
  const required    = avgBaseline + noiseFloor;

  if (candidateFitness < required) {
    logger.info({ domain, candidateFitness: candidateFitness.toFixed(4),
      required: required.toFixed(4), avgBaseline: avgBaseline.toFixed(4), noiseFloor: noiseFloor.toFixed(4) },
      "[Evolver #493] Champion candidate failed adversarial gate");
    return false;
  }
  return true;
}

// ── Negative transfer map (Step 9) ───────────────────────────────────────────
// Compute a penalty for cross-domain immigration from `sourceDomain` into
// `targetDomain` based on recent negative transfer events.
// Returns a multiplier in (0, 1] — 1.0 = no penalty, 0.1 = severe penalty.

export async function transferPenalty(
  db:           ScopedDb,
  sourceDomain: string,
  targetDomain: string,
  currentGen:   number,
): Promise<number> {
  const entries = await db.getTransferMapEntries(targetDomain, 20);
  const relevant = entries.filter(e => e.source_domain === sourceDomain);
  if (relevant.length === 0) return 1.0;

  let totalPenalty = 0;
  for (const entry of relevant) {
    const genGap = currentGen - (entry.target_generation ?? currentGen);
    const weight = Math.exp(-genGap / TRANSFER_DECAY_CONSTANT);
    totalPenalty += weight;
  }

  // penalty scales from 0 (no penalty) to 1 (total block)
  const penaltyFraction = Math.min(1, totalPenalty / 3);
  return 1 - penaltyFraction * 0.9; // never fully block — floor at 0.1
}

// ── Counterfactual shadow track (Step 10) ────────────────────────────────────
// Log an ε-greedy targeting decision for counterfactual comparison.
// Filled in with actual fitness outcomes after the generation completes.

async function logCounterfactualDecision(
  db:             ScopedDb,
  domain:         string,
  generation:     number,
  targeted:       Genome,
  random:         Genome,
  targetedPromise: number,
  randomPromise:   number,
): Promise<number> {
  const row = await db.insertCounterfactualLog({
    domain,
    decision_generation:    generation,
    targeted_genome:        targeted as unknown as Record<string, unknown>,
    random_genome:          random   as unknown as Record<string, unknown>,
    targeted_promisingness: targetedPromise,
    random_promisingness:   randomPromise,
    evaluated:              false,
  });
  return row.id;
}

// ── Counterfactual auto-reset (Step 10) ──────────────────────────────────────
// Check if targeted selection has consistently underperformed random over the
// last COUNTERFACTUAL_RESET_N evaluated decisions. If so, reset ε to 0.9.

export async function checkCounterfactualReset(
  db:     ScopedDb,
  domain: string,
): Promise<void> {
  const recent = await db.getRecentCounterfactuals(domain, COUNTERFACTUAL_RESET_N);
  if (recent.length < COUNTERFACTUAL_RESET_N) return;

  let targetedWins = 0;
  for (const r of recent) {
    if ((r.targeted_fitness ?? 0) >= (r.random_fitness ?? 0)) targetedWins++;
  }
  const winRate = targetedWins / recent.length;
  if (winRate < 0.45) { // targeted wins fewer than 45% → model is misleading
    _domainEpsilon.set(domain, 0.9);
    logger.warn({ domain, winRate: winRate.toFixed(3) },
      "[Evolver #493] Counterfactual check: targeting underperforms random — ε reset to 0.9");
    await db.upsertNoiseModel(domain, { epsilon: 0.9 });
  }
}

// ── Divergence tracking (Step 11) ────────────────────────────────────────────
// After each generation: record benchmark fitness and whether a rollback occurred.
// Pearson correlation between benchmark fitness and rollback rate logged to noise model.
// Admin alert when correlation > 0.6 (strong divergence signal).

interface DivergenceEntry {
  generation:     number;
  benchmarkFitness: number;
  rollbackOccurred: boolean;
}

export async function updateDivergenceLog(
  db:               ScopedDb,
  domain:           string,
  generation:       number,
  benchmarkFitness: number,
  rollbackOccurred: boolean,
  ctx:              EvolverContext,
): Promise<void> {
  const nm = await db.getNoiseModel(domain);
  const existing: DivergenceEntry[] = (nm?.divergence_log_json as DivergenceEntry[] | null) ?? [];
  existing.push({ generation, benchmarkFitness, rollbackOccurred });
  if (existing.length > 20) existing.shift(); // rolling 20-entry window

  // Compute Pearson correlation between benchmarkFitness and rollbackOccurred (0/1)
  let divergenceAlert = false;
  if (existing.length >= 10) {
    const xs = existing.map(e => e.benchmarkFitness);
    const ys = existing.map(e => e.rollbackOccurred ? 1 : 0);
    const xMean = xs.reduce((s, v) => s + v, 0) / xs.length;
    const yMean = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < xs.length; i++) {
      const xd = xs[i]! - xMean;
      const yd = ys[i]! - yMean;
      num += xd * yd; dx2 += xd * xd; dy2 += yd * yd;
    }
    const denom = Math.sqrt(dx2 * dy2);
    const pearson = denom > 0 ? num / denom : 0;

    if (Math.abs(pearson) > 0.6) {
      divergenceAlert = true;
      logger.warn({ domain, generation, pearson: pearson.toFixed(3) },
        "[Evolver #493] Divergence: strong correlation between benchmark fitness and rollback rate");
      void ctx.writeDiscordDm(
        `⚠️ **Evolver divergence alert** (${domain}): benchmark fitness and rollback events correlate ` +
        `(r=${pearson.toFixed(2)}) — benchmark may not reflect real task quality.`,
      ).catch(() => {});
    }
  }

  await db.upsertNoiseModel(domain, {
    divergence_log_json: existing as unknown as Record<string, unknown>[],
  });

  if (divergenceAlert) {
    logger.info({ domain, generation }, "[Evolver #493] Divergence log updated with alert");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Stage C: Generation Loop (updated)
// Full loop with generation timeout, provider stress check, boot-resume via
// evolver_generations/evolver_population, all guardrails, auto-specialisation.
// ═══════════════════════════════════════════════════════════════════════════

// ── G7: Circuit breaker state (per domain) ────────────────────────────────

interface BreakerState {
  consecutiveFailures: number;
  pausedUntil:         number;
  stopped:             boolean;
  stressSkipStreak:    number;
}


const _breakerByDomain = new Map<string, BreakerState>();

function _getBreaker(domain: string): BreakerState {
  if (!_breakerByDomain.has(domain)) {
    _breakerByDomain.set(domain, {
      consecutiveFailures: 0,
      pausedUntil:         0,
      stopped:             false,
      stressSkipStreak:    0,
    });
  }
  return _breakerByDomain.get(domain)!;
}

// ── Auto-specialisation tracking ──────────────────────────────────────────
let _generalGenerations    = 0;
const _specialisedDomains  = new Set<string>();
const _domainGeneration         = new Map<string, number>(); // per-domain generation counter
const _domainBestFitnessHistory = new Map<string, number[]>(); // last 3 best fitnesses per domain
const _domainLastVariance       = new Map<string, number>();   // last computed variance per domain
const _domainRunnerUp           = new Map<string, Genome>();   // 2nd-best genome per domain (for top-2 elitism)
const _domainRunnerUpAge        = new Map<string, number>();   // gens since runner-up was last updated (stale guard)
const _domainLastDonor          = new Map<string, string>();   // last donor domain per receiving domain
const _domainDonorStreak        = new Map<string, number>();   // consecutive same-donor streak per domain
const _poorDonorDomains         = new Map<string, Map<string, number>>(); // domain → (donor → gens remaining excluded)
const _preImmigrationFitness    = new Map<string, number>();   // best fitness before immigration (for poor-donor gate)
const _domainLastBenchmark      = new Map<string, number>();   // last selected benchmark index per domain
const _domainBenchmarkStreak    = new Map<string, number>();   // consecutive same-benchmark streak (anti-repeat)
const _domainImmigrationPause   = new Map<string, number>();   // domain → gens remaining where domain can't donate
const _domainChampionStreak     = new Map<string, number>();   // gens with identical champion genome (gene lock)
const _domainLastChampionStr    = new Map<string, string>();   // JSON of last champion for lock detection
const _escapeProviderIndex      = new Map<string, number>();   // round-robin index for diversity injection provider
const _providerTimeouts         = new Map<string, Map<string, number>>(); // domain → provider → consecutive 0-score count
const _providerDowngrades       = new Map<string, Set<string>>(); // domain → providers capped at 200 tokens

/** Logged per immigration event; postFitness/delta filled on the next generation. */
interface ImmigrationEvent {
  generation:   number;
  donorDomain:  string;
  mode:         string;
  donorFitness: number;
  preFitness:   number;
  postFitness?: number;
  delta?:       number;
  timestamp:    number;
}
const _immigrationLog = new Map<string, ImmigrationEvent[]>(); // domain → last 50 events (capped)

/** Cached island mode — refreshed via setIslandSettings() when admin panel changes it. */
let _islandMode      = "direct"; // "off" | "direct" | "crossover" | "probationary"
let _islandThreshold = 0.5;      // probationary acceptance threshold [0..1]

// ── Task #508: Gladiator suit module-level state ───────────────────────────────
/** Per-domain crystallization cooldown: generation number of last crystallization (avoid spam). */
const _domainCrystallizationCooldown = new Map<string, number>();
/** Win-rate data posted by ZomBrains queue.js after each task. Populated by setDomainArmorWinRate(). */
const _domainArmorWinRate = new Map<string, { wins: number; total: number; rate: number }>();
/**
 * Called by crystalline.ts when ZomBrains POSTs win-rate data to /api/crystalline/armor/win-rate.
 * Stores it so checkCrystallizationGate() can read it synchronously.
 */
export function setDomainArmorWinRate(
  domain: string,
  data: { wins: number; total: number; rate: number },
): void {
  _domainArmorWinRate.set(domain, data);
}

/** Cached Railway benchmark flag — refreshed via setRailwayBenchmarkFlag() from cluster-flags PATCH. */
let _railwayBenchmarkEnabled = false;

// ── Task #508: Gladiator tournament engine ────────────────────────────────────
// Zero-token implementation: domain heuristic judge picks winner from gene feature vectors.
// The AI already scored each genome in evaluateGenome; the tournament is a smarter tiebreaker.

/** Domain-specific gene scores — higher is better. Used as heuristic judge. */
function _gladiatorScore(g: Genome, domain: string): number {
  let score = 0;
  // Context richness
  if (g.contextStyle === "rich")     score += 3;
  if (g.contextStyle === "standard") score += 1;
  // Token budget
  if (g.maxTokens >= 1000)           score += 3;
  else if (g.maxTokens >= 600)       score += 2;
  else if (g.maxTokens >= 300)       score += 1;
  // Domain-specific boosts
  switch (domain) {
    case "coding":
      if (g.promptStyle === "chain-of-thought") score += 4;
      if (g.contextStyle === "rich")            score += 2; // extra weight
      if ((g.decompose ?? 1) >= 2)              score += 2;
      if (g.temperature <= 0.4)                 score += 1;
      break;
    case "diagnostic":
      if (g.promptStyle === "structured")       score += 4;
      if (g.temperature <= 0.3)                 score += 3;
      if (g.contextStyle === "rich")            score += 2;
      break;
    case "planning":
      if ((g.decompose ?? 1) >= 2)              score += 4;
      if (g.promptStyle === "chain-of-thought") score += 3;
      break;
    case "knowledge":
      if (g.promptStyle === "structured")       score += 3;
      if (g.maxTokens >= 800)                   score += 2;
      break;
    default:
      if (g.contextStyle === "rich")            score += 2;
  }
  return score;
}

/**
 * Task #508: Heuristic gladiator round — compare two genomes by domain best-practice features.
 * Zero tokens. Returns winner/loser or null if tied (fitness order preserved on tie).
 */
function tournamentRound(
  a:      Genome,
  b:      Genome,
  domain: string,
): { winner: Genome; loser: Genome; reason: string } | null {
  const sa = _gladiatorScore(a, domain);
  const sb = _gladiatorScore(b, domain);
  if (sa === sb) {
    // Phase 4: Elo convergence floor — exact tie in gladiator scores resolved by
    // coin flip rather than skipping the matchup. Prevents bracket stagnation when
    // two genomes have converged to identical quality signals.
    const winner = Math.random() < 0.5 ? a : b;
    const loser  = winner === a ? b : a;
    logger.info({ domain, sa, sb }, "[Evolver] Coin-flip: tied gladiator scores — resolved by random");
    return { winner, loser, reason: `coin_flip: tied gladiator_score=${sa} domain=${domain}` };
  }
  const winner = sa > sb ? a : b;
  const loser  = sa > sb ? b : a;
  return {
    winner,
    loser,
    reason: `gladiator_score: A=${sa} B=${sb} domain=${domain}`,
  };
}

/**
 * Task #508: Gladiator bracket pass over sorted results[2..].
 * Top-2 (champion + runner-up) are never put in bracket — elitism protects them.
 * Survivors go to front; losers go to tail for 40%-kill culling in offspring step.
 * Logs each matchup to evolver_tournament_log (fire-and-forget, non-fatal).
 */
async function runGladiatorBracket(
  db:            ScopedDb,
  domain:        string,
  generation:    number,
  sortedResults: Array<{ genome: Genome; result: EvalResult }>,
): Promise<Array<{ genome: Genome; result: EvalResult }>> {
  if (sortedResults.length < 4) return sortedResults;
  const elites  = sortedResults.slice(0, 2);
  const bracket = sortedResults.slice(2);
  if (bracket.length < 2) return sortedResults;

  const survivors: Array<{ genome: Genome; result: EvalResult }> = [];
  const losers:    Array<{ genome: Genome; result: EvalResult }> = [];
  let matchups = 0;

  for (let i = 0; i + 1 < bracket.length; i += 2) {
    const a = bracket[i]!;
    const b = bracket[i + 1]!;
    // Only run matchup when fitness is within 0.05 (practical tie — clear winner stays by fitness)
    const fitnessGap = Math.abs(a.result.fitness - b.result.fitness);
    if (fitnessGap > 0.05) {
      survivors.push(a);
      losers.push(b);
      continue;
    }
    const result = tournamentRound(a.genome, b.genome, domain);
    if (!result) {
      survivors.push(a); losers.push(b);
      continue;
    }
    const winner = result.winner === a.genome ? a : b;
    const loser  = result.winner === a.genome ? b : a;
    survivors.push(winner);
    losers.push(loser);
    matchups++;
    void db.insertTournamentLog({
      domain,
      generation,
      winner_hash: JSON.stringify(winner.genome).slice(0, 16),
      loser_hash:  JSON.stringify(loser.genome).slice(0, 16),
      judge_reason: result.reason,
      resolved_by: "gladiator_heuristic",
    }).catch(() => {/* non-fatal */});
  }
  // Odd-count last unpaired competitor survives automatically
  if (bracket.length % 2 === 1) survivors.push(bracket[bracket.length - 1]!);

  if (matchups > 0) {
    logger.info({ domain, generation, matchups, survivors: survivors.length, losers: losers.length },
      "[Evolver #508] Gladiator bracket complete — survivors promoted, losers tailed for culling");
  }
  return [...elites, ...survivors, ...losers];
}

// ── Task #508: Crystallization gate ───────────────────────────────────────────
// INFRA_LIBRARY path relative to api-server CWD (artifacts/api-server in Replit workspace).
const INFRA_LIBRARY_PATH = path.resolve(process.cwd(), "../../builder-agent/INFRA_LIBRARY.md");
const ARMOR_SECTION_START = "<!-- ZB_ARMOR_START:";
const ARMOR_SECTION_END   = "<!-- ZB_ARMOR_END -->";

/**
 * Write champion genome as an ## EVOLVED ARMOR section to INFRA_LIBRARY.md.
 * Creates or replaces the existing domain armor block (idempotent).
 * Non-fatal: any filesystem error is logged and swallowed.
 */
function writeArmorToInfraLibrary(domain: string, champion: Genome, fitness: number, generation: number): void {
  try {
    let contents = "";
    try { contents = fs.readFileSync(INFRA_LIBRARY_PATH, "utf8"); } catch { /* new file / not found */ }

    const startTag = `${ARMOR_SECTION_START}${domain} -->`;
    const genomeText = Object.entries(champion)
      .filter(([k]) => k !== "provider")
      .map(([k, v]) => `- **${k}**: \`${v}\``)
      .join("\n");
    const armorBlock =
      `${startTag}\n` +
      `## EVOLVED ARMOR — ${domain.toUpperCase()} (gen ${generation}, fitness ${Math.round(fitness * 100)}%)\n\n` +
      `_Auto-crystallized from gladiator tournament. Treat as peer-authority to all INFRA_LIBRARY patterns._\n\n` +
      `${genomeText}\n\n` +
      `**Last crystallized**: ${new Date().toISOString()}\n\n` +
      `${ARMOR_SECTION_END}\n`;

    // Replace existing block or append
    const startIdx = contents.indexOf(startTag);
    const endIdx   = contents.indexOf(ARMOR_SECTION_END, startIdx);
    if (startIdx !== -1 && endIdx !== -1) {
      contents = contents.slice(0, startIdx) + armorBlock + contents.slice(endIdx + ARMOR_SECTION_END.length + 1);
    } else {
      contents = contents.trimEnd() + "\n\n" + armorBlock;
    }
    fs.writeFileSync(INFRA_LIBRARY_PATH, contents, "utf8");
    logger.info({ domain, generation, fitness }, "[Evolver #508] Armor crystallized → INFRA_LIBRARY.md");
  } catch (e) {
    logger.warn({ err: e, domain }, "[Evolver #508] writeArmorToInfraLibrary failed (non-fatal)");
  }
}

/**
 * Task #508: Crystallization gate — fires after every generation where streak >= 5.
 * Conditions: champion streak ≥ 5, win-rate ≥ 0.75 (or totalTasks < 5 for bootstrap),
 * and cooldown of 20 generations since last crystallization.
 * Non-fatal: any failure is logged; generation continues regardless.
 */
async function checkCrystallizationGate(
  ctx:        { db: ScopedDb; writeDiscordDm: (msg: string) => Promise<void> },
  domain:     string,
  generation: number,
  champion:   Genome,
  fitness:    number,
): Promise<void> {
  try {
    const streak  = _domainChampionStreak.get(domain) ?? 0;
    if (streak < 5) return;

    // Cooldown check: don't re-crystallize within 20 generations
    const lastCrystalGen = _domainCrystallizationCooldown.get(domain) ?? -100;
    if (generation - lastCrystalGen < 20) return;

    // Win-rate gate: ZomBrains must report ≥75% task-success rate for this armor domain
    const wr = _domainArmorWinRate.get(domain);
    const rateOk = !wr || wr.total < 5 || wr.rate >= 0.75; // bootstrap: allow if < 5 observations
    if (!rateOk) {
      logger.info({ domain, generation, wr }, "[Evolver #508] Crystallization gated by low win-rate (need ≥0.75)");
      return;
    }

    // All gates passed — crystallize
    _domainCrystallizationCooldown.set(domain, generation);
    _persistStreakState();
    writeArmorToInfraLibrary(domain, champion, fitness, generation);
    await ctx.db.updateChampionCrystallized(domain, new Date()).catch(e => {
      logger.warn({ err: e, domain }, "[Evolver #508] updateChampionCrystallized failed (non-fatal)");
    });
    void ctx.writeDiscordDm(
      `🛡️ **Armor crystallized** — ${domain} domain gen ${generation} (fitness ${Math.round(fitness * 100)}%, streak ${streak}). Armor written to INFRA_LIBRARY.md and will inject into ZomBrains next task.`
    ).catch(() => {});
  } catch (e) {
    logger.warn({ err: e, domain }, "[Evolver #508] checkCrystallizationGate failed (non-fatal)");
  }
}

// ── EvolverTimeoutError ───────────────────────────────────────────────────
class EvolverTimeoutError extends Error {
  constructor(domain: string, generation: number) {
    super(`[Evolver] Generation timeout: domain=${domain} generation=${generation}`);
    this.name = "EvolverTimeoutError";
  }
}

// ── Random genome using exported gene arrays ──────────────────────────────
function _rng(domain: string): Genome {
  const p = <T>(a: ReadonlyArray<T>): T => a[Math.floor(Math.random() * a.length)]!;
  return {
    provider:     p(PROVIDERS),
    decompose:    p(DECOMPOSE_OPTIONS),
    contextStyle: p(CONTEXT_STYLES),
    promptStyle:  p(PROMPT_STYLES),
    temperature:  p(TEMPERATURES),
    maxTokens:    p(domainMaxTokens(domain)),
  };
}

/** Clamp a genome's maxTokens to the valid option set for this domain.
 *  For non-coding domains, keeps values in [100,200]; for coding, keeps [200,400].
 *  Also respects provider timeout downgrade: if a coding provider has repeatedly scored 0
 *  at 400 tokens, it is downgraded to max 200 for that domain.
 *  Prevents out-of-range values from persisting through crossover or migration. */
function clampGenome(g: Genome, domain: string): Genome {
  const opts    = domainMaxTokens(domain);
  let clamped   = (opts as readonly number[]).includes(g.maxTokens)
    ? g
    : { ...g, maxTokens: opts[Math.floor(Math.random() * opts.length)]! };
  // Provider timeout downgrade: cap at 200 if this provider has been timing out at 400
  if (_providerDowngrades.get(domain)?.has(clamped.provider) && clamped.maxTokens > 200) {
    clamped = { ...clamped, maxTokens: 200 as MaxTokens };
  }
  return clamped;
}

// ── Step 2: Generation timeout wrapper ───────────────────────────────────
async function withGenerationTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  domain: string,
  generation: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      void writeErrorLog({
        route:   "evolver",
        method:  "timeout",
        message: `[Evolver] Generation timed out after ${timeoutMs / 60_000}min: domain=${domain} gen=${generation}`,
        source:  "crystalline-evolver",
      });
      reject(new EvolverTimeoutError(domain, generation));
    }, timeoutMs);

    fn().then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e as Error); },
    );
  });
}

// ── Step 3: Provider stress check ────────────────────────────────────────
export async function hasProviderHeadroom(ctx: EvolverContext): Promise<boolean> {
  try {
    const base = `http://localhost:${process.env["PORT"] ?? "5000"}`;
    const auth = process.env["ADMIN_SECRET"] ?? "";
    const r = await fetch(`${base}/api/zombrains/worker/events?limit=30`, {
      headers: { "x-admin-secret": auth, "x-zombrains-secret": auth },
      signal:  AbortSignal.timeout(5_000),
    });
    if (!r.ok) return true;

    const events = await r.json() as Array<{ outcome?: string; created_at?: string }>;
    if (events.length === 0) {
      logger.warn("[Evolver G-stress] No events — api-server just booted, waiting one cycle");
      return false;
    }

    const cutoff = Date.now() - 10 * 60_000;
    const recent = events.filter(e => {
      const ts = e.created_at ? new Date(e.created_at).getTime() : 0;
      return ts > cutoff;
    });
    if (recent.length === 0) return true;

    const errors = recent.filter(e =>
      e.outcome === "error" || e.outcome === "rate_limit" || e.outcome === "failed",
    ).length;
    const rate = errors / recent.length;

    if (rate > 0.3) {
      logger.warn({ errors, total: recent.length, rate: rate.toFixed(2) },
        "[Evolver G-stress] Provider error rate >30% — skipping generation");
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

// ── Step 1: Population management + boot resume ───────────────────────────
export async function loadOrSeedPopulation(
  ctx: EvolverContext,
  domain: string,
): Promise<Genome[]> {
  const lastGen = await ctx.db.getLastCompletedGeneration(domain);

  if (lastGen) {
    const popRows = await ctx.db.getAlivePopulation(lastGen.id);
    if (popRows.length > 0) {
      const population: Genome[] = popRows.map(r => r.genome as unknown as Genome);
      const champion = await ctx.champions.get(domain);
      // Fill remaining slots with round-robin providers so the fill doesn't clone
      // the dominant provider (champion bias). Other genes are randomised per slot.
      let fillSlot = 0;
      while (population.length < 20) {
        const provider = PROVIDERS[fillSlot % PROVIDERS.length]!;
        fillSlot++;
        if (champion && Math.random() < 0.5) {
          const safeChamp = clampGenome(champion, domain);
          population.push(mutate({ ...safeChamp, provider }));
        } else {
          population.push({
            provider,
            decompose:    pick(DECOMPOSE_OPTIONS),
            contextStyle: pick(CONTEXT_STYLES),
            promptStyle:  pick(PROMPT_STYLES),
            temperature:  pick(TEMPERATURES),
            maxTokens:    pick(domainMaxTokens(domain)),
          });
        }
      }
      return population.slice(0, 20);
    }
  }

  const champion = await ctx.champions.get(domain);
  return seedPopulation(domain, 20, champion ? [clampGenome(champion, domain)] : []);
}

// ── Step 4: G2 — Priority gate ────────────────────────────────────────────
export async function waitForQueueClear(ctx: EvolverContext, maxWaitMs = 7_200_000): Promise<void> {
  const POLL_MS = 60_000;
  const WARN_MS = 10 * 60_000;
  const started = Date.now();
  let warned    = false;

  for (;;) {
    const depth = await ctx.monitor().catch(() => 0);
    if (depth === 0) return;

    const elapsed = Date.now() - started;

    if (!warned && elapsed > WARN_MS) {
      warned = true;
      logger.warn({ depth }, "[Evolver G2] Queue not clear after 10 min — still waiting");
      void writeErrorLog({
        route:   "evolver",
        method:  "G2",
        message: `[Evolver G2] Queue depth ${depth} — blocked >10 min`,
        source:  "crystalline-evolver",
      });
    }

    if (elapsed > maxWaitMs) {
      logger.warn({ depth, maxWaitMs }, "[Evolver G2] Max wait exceeded — running evolver anyway");
      void writeErrorLog({
        route:   "evolver",
        method:  "G2",
        message: `[Evolver G2] Queue depth ${depth} — max wait ${maxWaitMs}ms exceeded, proceeding`,
        source:  "crystalline-evolver",
      });
      return;
    }

    await new Promise<void>(r => setTimeout(r, POLL_MS));
  }
}

// ── Step 5: G5 — Monoculture prevention (< 3 unique providers) ───────────
export function enforceDiversity(
  population: Genome[],
  domain: string,
  generation: number,
): Genome[] {
  const counts = new Map<Provider, number>();
  for (const g of population) counts.set(g.provider, (counts.get(g.provider) ?? 0) + 1);

  if (counts.size >= 3) return population;

  const [dominant] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  logger.warn({ domain, generation, provider: dominant, uniqueProviders: counts.size },
    "[Evolver G5] Low provider diversity — injecting diverse genomes");
  void writeErrorLog({
    route:   "evolver",
    method:  "G5",
    message: `[Evolver G5] Only ${counts.size} unique providers in domain ${domain} gen ${generation} — dominant: ${dominant}`,
    source:  "crystalline-evolver",
  });

  const others  = PROVIDERS.filter(p => p !== dominant);
  const result  = [...population];
  const pickOth = (): Provider => others[Math.floor(Math.random() * others.length)]!;
  let replaced  = 0;
  for (let i = result.length - 1; i >= 0 && replaced < 4; i--) {
    if (result[i]!.provider === dominant) {
      result[i] = { ..._rng(domain), provider: pickOth() };
      replaced++;
    }
  }
  return result;
}

// ── Step 7: Single generation — runs exactly one generation and returns ───
// No loop, no sleep. The coordinator (runCoordinatorLoop) owns cadence.
// All local arrays (population, results, offspring) go out of scope on return
// so they are eligible for GC before the next domain starts. This keeps peak
// heap at 1× instead of 5× (one domain in memory at a time).
async function runSingleGeneration(
  ctx: EvolverContext,
  domain: string,
  nodeId: string,
): Promise<boolean> {
  // Yield event loop — health check must never be starved
  await new Promise<void>(r => setImmediate(r));

  const heapBefore = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const breaker    = _getBreaker(domain);
  const isGeneral  = domain === "general";

  // Step a: G7 permanently stopped — skip, coordinator moves to next domain
  if (breaker.stopped) {
    logger.warn({ domain }, "[Evolver G7] Permanently stopped — skipping domain");
    return false;
  }

  // Step b: G7 pause active — skip this pass; coordinator retries on next cycle
  if (breaker.pausedUntil > Date.now()) {
    logger.warn(
      { domain, resumeAt: new Date(breaker.pausedUntil).toISOString() },
      "[Evolver G7] Paused — skipping this pass",
    );
    return false;
  }

  // Step c: provider stress check
  const headroom = await hasProviderHeadroom(ctx);
  if (!headroom) {
    breaker.stressSkipStreak++;
    if (breaker.stressSkipStreak >= 3) {
      breaker.consecutiveFailures++;
      breaker.stressSkipStreak = 0;
      if (breaker.consecutiveFailures >= 10) {
        breaker.stopped = true;
        void writeErrorLog({ route: "evolver", method: "G7", message: `[Evolver G7] Domain ${domain} permanently stopped after 10 consecutive failures (stress included)`, source: "crystalline-evolver" });
      } else if (breaker.consecutiveFailures >= 3) {
        breaker.pausedUntil = Date.now() + 30 * 60_000;
        void writeErrorLog({ route: "evolver", method: "G7", message: `[Evolver G7] Domain ${domain} paused 30 min: ${breaker.consecutiveFailures} consecutive failures`, source: "crystalline-evolver" });
      }
    }
    return false;
  }
  breaker.stressSkipStreak = 0;

  // Step d: G2 queue gate
  await waitForQueueClear(ctx);

  // Step e: load/resume population
  const population = await loadOrSeedPopulation(ctx, domain);
  _domainGeneration.set(domain, (_domainGeneration.get(domain) ?? 0) + 1);
  const generation = _domainGeneration.get(domain)!;
  if (isGeneral) _generalGenerations++;

  // Capture champion and runner-up BEFORE this generation modifies them — used for top-2 elitism
  const preGenChampion = await ctx.db.getChampion(domain);
  // On first generation after boot, seed runner-up from the persisted DB column
  if (preGenChampion?.runner_up_genome && !_domainRunnerUp.has(domain)) {
    _domainRunnerUp.set(domain, preGenChampion.runner_up_genome as unknown as Genome);
    _domainRunnerUpAge.set(domain, 0);
  }
  const preGenRunnerUp = _domainRunnerUp.get(domain) ?? null;

  // Island migration: inject cross-domain champions according to the current island mode
  try {
    // ── Fill postFitness for the previous generation's immigration event (step 9/21) ──
    const preFitFromLastGen = _preImmigrationFitness.get(domain);
    if (preFitFromLastGen !== undefined) {
      const evLog = _immigrationLog.get(domain);
      if (evLog && evLog.length > 0) {
        const last = evLog[evLog.length - 1]!;
        if (last.postFitness === undefined) {
          last.postFitness = preGenChampion?.fitness ?? 0;
          last.delta       = last.postFitness - last.preFitness;
          // Poor-donor gate: mark donor if immigration caused > 15% fitness drop
          if (preFitFromLastGen > 0 && last.postFitness < preFitFromLastGen * 0.85) {
            const poorMap = _poorDonorDomains.get(domain) ?? new Map<string, number>();
            poorMap.set(last.donorDomain, 2);
            _poorDonorDomains.set(domain, poorMap);
            logger.warn({ domain, generation, donor: last.donorDomain, pre: preFitFromLastGen.toFixed(3), post: last.postFitness.toFixed(3) },
              "[Evolver] Poor donor detected — excluded for 2 generations");
          }
        }
      }
      _preImmigrationFitness.delete(domain);
    }

    // ── Decrement pause and poor-donor counters ───────────────────────────────
    const pauseRem = _domainImmigrationPause.get(domain) ?? 0;
    if (pauseRem > 0) _domainImmigrationPause.set(domain, pauseRem - 1);

    const poorMap = _poorDonorDomains.get(domain);
    if (poorMap) {
      for (const [donor, rem] of poorMap) {
        if (rem <= 1) poorMap.delete(donor); else poorMap.set(donor, rem - 1);
      }
    }

    if (_islandMode !== "off") {
      const allChamps = await ctx.db.getAllChampions();

      // Build candidates: exclude self, poor donors, and paused donors (health watchdog)
      const currentPoorDonors = _poorDonorDomains.get(domain) ?? new Map<string, number>();
      let candidates = allChamps.filter(c =>
        c.domain !== domain &&
        !currentPoorDonors.has(c.domain) &&
        (_domainImmigrationPause.get(c.domain) ?? 0) === 0 &&
        (c.fitness ?? 0) > 0,
      );

      // Task #493 Step 9: filter candidates by negative transfer penalty (exp decay)
      // Donors with recent cross-domain failures are penalised proportional to recency.
      // Low penalty scores may still be selected but are less favoured in roulette.
      const transferPenalties = await Promise.all(
        candidates.map(async c => ({
          c,
          penalty: await transferPenalty(ctx.db, c.domain, domain, generation).catch(() => 1.0),
        })),
      );
      // Drop candidates whose penalty is 0.1 (maximum) if alternatives exist
      const minPenalty = Math.min(...transferPenalties.map(t => t.penalty));
      if (minPenalty > 0.1 && candidates.length > 1) {
        candidates = transferPenalties
          .filter(t => t.penalty > 0.3)
          .map(t => t.c);
        if (candidates.length === 0) candidates = transferPenalties.map(t => t.c); // fallback to all
      }

      // Donor rotation cap (step 8): if same donor streak >= 4, exclude that donor if alternatives exist
      const lastDonor   = _domainLastDonor.get(domain);
      const donorStreak = _domainDonorStreak.get(domain) ?? 0;
      if (lastDonor && donorStreak >= 4 && candidates.length > 1) {
        const withoutLast = candidates.filter(c => c.domain !== lastDonor);
        if (withoutLast.length > 0) candidates = withoutLast;
      }

      // Fitness-weighted roulette selection (step 7): pick 2 distinct donors proportional to fitness
      const totalFit = candidates.reduce((s, c) => s + (c.fitness ?? 0), 0);
      const roulette = (): typeof allChamps[number] | null => {
        if (candidates.length === 0) return null;
        if (totalFit === 0) return candidates[Math.floor(Math.random() * candidates.length)]!;
        let r = Math.random() * totalFit;
        for (const c of candidates) { r -= (c.fitness ?? 0); if (r <= 0) return c; }
        return candidates[candidates.length - 1]!;
      };
      const donor1 = roulette();
      const donor2 = donor1 ? (candidates.find(c => c.domain !== donor1.domain) ?? null) : null;
      const donors = [donor1, donor2].filter((d): d is typeof allChamps[number] => d !== null).slice(0, 2);

      // Record pre-immigration fitness for next gen's poor-donor check
      _preImmigrationFitness.set(domain, preGenChampion?.fitness ?? 0);

      // Update donor streak tracking
      if (donor1) {
        if (donor1.domain === lastDonor) {
          _domainDonorStreak.set(domain, donorStreak + 1);
        } else {
          _domainDonorStreak.set(domain, 1);
          _domainLastDonor.set(domain, donor1.domain);
        }
      }

      for (let mi = 0; mi < donors.length; mi++) {
        const donorRow   = donors[mi]!;
        const immigrant  = donorRow.genome as unknown as Genome;
        const replaceIdx = population.length - 1 - mi;
        if (replaceIdx < 0) continue;

        if (_islandMode === "direct") {
          // Step 3: clamp before injection (prevents cross-domain token gene pollution)
          population[replaceIdx] = clampGenome(immigrant, domain);

        } else if (_islandMode === "crossover") {
          const localRef = preGenChampion ? (preGenChampion.genome as unknown as Genome) : null;
          if (!localRef) {
            population[replaceIdx] = clampGenome(immigrant, domain);
          } else {
            const popProviders = new Set(population.map(g => g.provider));
            if (popProviders.size < 2) {
              population[replaceIdx] = clampGenome(immigrant, domain);
              logger.info({ domain, generation }, "[Evolver] Crossover: < 2 providers in pop — falling back to direct");
            } else {
              const clamped  = clampGenome(immigrant, domain);
              const offspring = crossover(clamped, localRef);
              // Step 15: gene survival metric (informational)
              const iGenes  = Object.values(clamped);
              const oGenes  = Object.values(offspring);
              const fromImm = oGenes.filter((v, i) => v === iGenes[i]).length;
              logger.info({ domain, generation, fromImmigrant: fromImm, total: oGenes.length },
                "[Evolver] Crossover gene survival");
              population[replaceIdx] = clampGenome(offspring, domain);
            }
          }

        } else if (_islandMode === "probationary") {
          // Evaluate immigrant; inject only if fitness >= threshold
          try {
            const probePool = (DOMAIN_BENCHMARK_MAP as Record<string, readonly number[]>)[domain] ?? [0];
            const probeIdx  = probePool[Math.floor(Math.random() * probePool.length)]!;
            const probeTask = { text: BENCHMARK_TASKS[probeIdx] ?? BENCHMARK_TASKS[0]!, index: probeIdx };
            const probeRes  = await evaluateGenome(ctx, clampGenome(immigrant, domain), probeTask, domain, generation);
            if (probeRes.fitness >= _islandThreshold) {
              population[replaceIdx] = clampGenome(immigrant, domain);
              logger.info({ domain, generation, donor: donorRow.domain, fit: probeRes.fitness.toFixed(3), threshold: _islandThreshold },
                "[Evolver] Probationary: immigrant accepted");
            } else {
              logger.info({ domain, generation, donor: donorRow.domain, fit: probeRes.fitness.toFixed(3), threshold: _islandThreshold },
                "[Evolver] Probationary: immigrant rejected");
            }
          } catch {
            // probe failure is non-fatal; slot is left as-is
          }
        }

        // Immigration impact log entry (step 21)
        const evLog = _immigrationLog.get(domain) ?? [];
        evLog.push({
          generation,
          donorDomain:  donorRow.domain,
          mode:         _islandMode,
          donorFitness: donorRow.fitness ?? 0,
          preFitness:   preGenChampion?.fitness ?? 0,
          timestamp:    Date.now(),
        });
        while (evLog.length > 50) evLog.shift();
        _immigrationLog.set(domain, evLog);
      }

      if (donors.length > 0) {
        logger.info(
          { domain, generation, mode: _islandMode, donors: donors.map(d => `${d.domain}@${((d.fitness ?? 0) * 100).toFixed(1)}%`) },
          "[Evolver] Island migration complete",
        );
      }
    }
  } catch (migErr) {
    logger.warn({ err: migErr, domain }, "[Evolver] Island migration fetch failed — skipping");
  }

  logger.info({ domain, generation, heapMb: heapBefore }, "[Evolver] Generation start");

  // Step f: G8 provider interleaving
  population.sort((a, b) => a.provider.localeCompare(b.provider));

  // Benchmark rotation (step 10): evaluate one randomly selected task per generation.
  // This halves per-generation API cost vs evaluating all benchmarks every time.
  const poolIndices: readonly number[] = (DOMAIN_BENCHMARK_MAP as Record<string, readonly number[]>)[domain] ?? [0];
  let benchmarkIndex = poolIndices[Math.floor(Math.random() * poolIndices.length)]!;
  // Anti-repeat guard (step 11): if same benchmark streak >= 4, force a different one
  const lastBench    = _domainLastBenchmark.get(domain);
  const benchStreak  = _domainBenchmarkStreak.get(domain) ?? 0;
  if (lastBench === benchmarkIndex && benchStreak >= 4 && poolIndices.length > 1) {
    const others = poolIndices.filter(i => i !== benchmarkIndex);
    benchmarkIndex = others[Math.floor(Math.random() * others.length)]!;
    _domainBenchmarkStreak.set(domain, 0);
  } else if (lastBench === benchmarkIndex) {
    _domainBenchmarkStreak.set(domain, benchStreak + 1);
  } else {
    _domainBenchmarkStreak.set(domain, 0);
  }
  _domainLastBenchmark.set(domain, benchmarkIndex);
  const benchmarkTasks: BenchmarkTask[] = [{
    text:  BENCHMARK_TASKS[benchmarkIndex] ?? BENCHMARK_TASKS[0]!,
    index: benchmarkIndex,
  }];

  // Step g+h: evaluate inside 20-minute hard timeout
  const results: Array<{ genome: Genome; result: EvalResult }> = [];
  let successCount     = 0;
  let generationFailed = false;

  try {
    await withGenerationTimeout(async () => {
      for (const genome of population) {
        // Multi-benchmark: evaluate against all tasks for this domain, average fitness
        let totalFitness = 0;
        let lastEval: EvalResult | null = null;
        for (let ti = 0; ti < benchmarkTasks.length; ti++) {
          const r = await evaluateGenome(ctx, genome, benchmarkTasks[ti]!, domain, generation);
          totalFitness += r.fitness;
          lastEval      = r;
          if (ti < benchmarkTasks.length - 1) {
            await new Promise<void>(res => setTimeout(res, 2_000 + Math.random() * 1_000));
          }
        }
        const avgFitness = benchmarkTasks.length > 0 ? totalFitness / benchmarkTasks.length : 0;
        const result: EvalResult = lastEval
          ? { ...lastEval, fitness: avgFitness }
          : { fitness: 0, tokensUsed: 0, qualityScore: 0, resolvedBy: "rate-limit-skip", components: null };
        results.push({ genome, result });
        if (result.resolvedBy !== "rate-limit-skip" && result.fitness > 0) successCount++;

        // Provider timeout tracker (step 17): coding domain only.
        // 3 consecutive 0-score evaluations at 400 tokens → downgrade that provider to max 200.
        if (domain === "coding" && result.resolvedBy !== "rate-limit-skip") {
          if (result.fitness === 0 && genome.maxTokens === 400) {
            const domMap = _providerTimeouts.get(domain) ?? new Map<string, number>();
            const cnt    = (domMap.get(genome.provider) ?? 0) + 1;
            domMap.set(genome.provider, cnt);
            _providerTimeouts.set(domain, domMap);
            if (cnt >= 3) {
              const downgrades = _providerDowngrades.get(domain) ?? new Set<string>();
              if (!downgrades.has(genome.provider)) {
                downgrades.add(genome.provider);
                _providerDowngrades.set(domain, downgrades);
                logger.warn({ domain, generation, provider: genome.provider, streak: cnt },
                  "[Evolver] Provider timeout downgrade: capping maxTokens at 200");
              }
            }
          } else if (result.fitness > 0 && genome.maxTokens === 400) {
            // Clear timeout streak on success at 400 tokens
            _providerTimeouts.get(domain)?.delete(genome.provider);
          }
        }

        // G8 stagger: 10–15s ±2s jitter
        await new Promise<void>(r =>
          setTimeout(r, 10_000 + Math.random() * 5_000 + (Math.random() - 0.5) * 4_000),
        );
        await new Promise<void>(r => setImmediate(r));
      }
    }, 1_200_000, domain, generation);
  } catch (e) {
    generationFailed = true;
    if (!(e instanceof EvolverTimeoutError)) {
      logger.error({ err: e, domain, generation }, "[Evolver] Generation threw unexpected error");
    }
  }

  if (successCount === 0) generationFailed = true;

  // Step l: update G7 circuit breaker
  if (generationFailed) {
    breaker.consecutiveFailures++;
    if (breaker.consecutiveFailures >= 10) {
      breaker.stopped = true;
      void writeErrorLog({ route: "evolver", method: "G7", message: `[Evolver G7] Domain ${domain} permanently stopped after 10 failures`, source: "crystalline-evolver" });
    } else if (breaker.consecutiveFailures >= 3) {
      breaker.pausedUntil = Date.now() + 30 * 60_000;
      void writeErrorLog({ route: "evolver", method: "G7", message: `[Evolver G7] Domain ${domain} paused 30 min after ${breaker.consecutiveFailures} failures`, source: "crystalline-evolver" });
    }
  } else {
    breaker.consecutiveFailures = 0;
  }

  if (!generationFailed && results.length > 0) {
    // Step i: rank by fitness descending
    results.sort((a, b) => b.result.fitness - a.result.fitness);

    // Task #508 Phase 1: Gladiator bracket — reranks non-elite genomes by domain gene heuristics.
    // Survivors promoted to front, losers pushed to tail for kill-rate culling below.
    // Non-fatal, synchronous (zero tokens), only applies to practical ties (fitness gap ≤ 0.05).
    const bracketedResults = await runGladiatorBracket(ctx.db, domain, generation, results);
    results.splice(0, results.length, ...bracketedResults);

    // Task #508 Phase 2: Track tournament losers (tail of bracket) for 40% kill-rate culling below.
    // Bottom 40% of non-elite results (positions 2..) are marked as loser candidates.
    const _nonElite = results.slice(2);
    const _killCount = Math.max(0, Math.floor(_nonElite.length * 0.4));
    const _tournamentLoserSet = new Set<string>(
      _nonElite.slice(_nonElite.length - _killCount).map(r => JSON.stringify(r.genome))
    );

    const ranked = results.map(r => r.genome);

    // Update runner-up in memory every generation from the 2nd-ranked genome
    const newRunnerUpGenome = results.length >= 2 && (results[1]?.result.fitness ?? 0) > 0
      ? results[1]!.genome : null;
    if (newRunnerUpGenome) {
      const changed = JSON.stringify(newRunnerUpGenome) !== JSON.stringify(_domainRunnerUp.get(domain));
      _domainRunnerUp.set(domain, newRunnerUpGenome);
      _domainRunnerUpAge.set(domain, changed ? 0 : (_domainRunnerUpAge.get(domain) ?? 0) + 1);
    } else {
      _domainRunnerUpAge.set(domain, (_domainRunnerUpAge.get(domain) ?? 0) + 1);
    }

    // Step j: persist to evolver_generations + evolver_population + G6 prune
    // (Old reactive G5 injection removed — post-selection cap in step m handles diversity.)
    const bestFitness = results[0]!.result.fitness;

    // Adaptive mutation: compute fitness variance for convergence detection
    const evalFitnesses   = results.map(r => r.result.fitness);
    const evalMean        = evalFitnesses.reduce((s, f) => s + f, 0) / (evalFitnesses.length || 1);
    const fitnessVariance = evalFitnesses.length > 1
      ? evalFitnesses.reduce((s, f) => s + (f - evalMean) ** 2, 0) / evalFitnesses.length
      : 0;
    _domainLastVariance.set(domain, fitnessVariance);

    // Track best-fitness history for stagnation detection (rolling 3-gen window)
    const fitHist = _domainBestFitnessHistory.get(domain) ?? [];
    fitHist.push(bestFitness);
    if (fitHist.length > 3) fitHist.shift();
    _domainBestFitnessHistory.set(domain, fitHist);

    // Domain health watchdog (step 19): 3 consecutive 25%-decline gens → pause immigration donations + warn
    if (fitHist.length >= 3) {
      const [h0, h1, h2] = fitHist as [number, number, number];
      const declining = h0 > 0.01 && h1 < h0 * 0.75 && h2 < h1 * 0.75;
      if (declining && (_domainImmigrationPause.get(domain) ?? 0) === 0) {
        _domainImmigrationPause.set(domain, 3);
        logger.warn({ domain, generation, h0: h0.toFixed(3), h1: h1.toFixed(3), h2: h2.toFixed(3) },
          `[Evolver] Health alert: ${domain} fitness declining 3 consecutive generations — immigration donations paused 3 gens`);
      }
    }

    // 2-gene mutation when converged (variance < 0.002), 1-gene when still exploring.
    // Task #493 Step 6: when noise floor is calibrated, use noise_floor * 1.2 to size mutations
    // (converted to discrete gene count: higher noise floor → more gene mutations).
    const domainNF = _domainNoiseFloor.get(domain) ?? 0;
    const mutationGenes = domainNF > 0
      ? Math.max(1, Math.min(3, Math.round(domainNF * 1.2 * GENE_KEYS.length)))
      : (fitnessVariance < 0.002 ? 2 : 1);

    // Task #493 Step 5: staleness check → may reset ε to 0.8
    checkAndApplyStaleness(domain, generation, ctx.db);

    // Task #493 Step 12: saturation detection
    const isSaturated = checkSaturation(domain, fitHist, fitnessVariance, ctx.db);
    if (isSaturated) {
      logger.info({ domain, generation }, "[Evolver #493] Saturation detected — eval budget reduced to 20%");
    }

    // Diversity injection: plateau detected when variance < 0.001 AND no improvement for 3 gens
    const stagnant = fitHist.length >= 3 && fitHist.every(f => Math.abs(f - (fitHist[0] ?? 0)) < 0.001);
    const numDiversityInjections = (fitnessVariance < 0.001 && stagnant)
      ? Math.floor(20 / 4) : 0;
    if (numDiversityInjections > 0) {
      logger.info({ domain, generation, fitnessVariance, fitHist },
        "[Evolver] Convergence plateau — diversity injection scheduled");
    }

    logger.info({ domain, generation, fitnessVariance: fitnessVariance.toFixed(4), mutationGenes },
      "[Evolver] Adaptive mutation params");

    const genRow = await ctx.db.insertGeneration({
      domain,
      generation,
      status:          "completed",
      best_fitness:    bestFitness,
      genome_count:    ranked.length,
      variance:        fitnessVariance,
      node:            nodeId,
      benchmark_index: benchmarkIndex,
    });

    // Thread components from results into population rows (index-aligned with ranked).
    const resultComponents = results.map(r => r.result.components);
    await ctx.db.bulkInsertPopulation(
      ranked.map((g, i) => ({
        generation_id: genRow.id,
        domain,
        genome:        g as unknown as Record<string, unknown>,
        fitness:       results[i]?.result.fitness ?? 0,
        alive:         true,
      })),
      resultComponents,
    );

    await ctx.db.pruneOldGenerations(domain, 100);

    // Task #479 Step 3: cull zero-fitness survivors from prior generations.
    // Zeros in the CURRENT generation are kept for one round (legitimate exploration);
    // zeros from any earlier generation have had their chance and pollute the gene pool.
    await ctx.db.cullZeroFitnessSurvivors(domain, genRow.id);

    // Step k: promote champion + persist runner-up (step 5)
    // Task #493 Step 8: adversarial gate — candidate must clear noise floor above adversarial baseline
    const currentCh = await ctx.db.getChampion(domain);
    if (!currentCh || bestFitness > currentCh.fitness) {
      const adverGate = await passesAdversarialGate(ctx.db, domain, bestFitness);
      if (adverGate) {
        await ctx.champions.set(domain, results[0]!.genome, bestFitness, generation, newRunnerUpGenome ?? undefined);
        logger.info(
          { domain, fitness: bestFitness, generation, provider: results[0]!.genome.provider },
          "[Evolver] New champion promoted",
        );
      } else {
        logger.info({ domain, fitness: bestFitness, generation },
          "[Evolver #493] Champion promotion blocked by adversarial gate");
      }
    }

    // Task #489: injection pipeline — attempt Level 1 injection after every promotion check
    void tryInjectDomainChampion(ctx, domain, results[0]!.genome, bestFitness, generation).catch(e => {
      logger.warn({ err: e, domain }, "[Evolver] tryInjectDomainChampion threw (non-fatal)");
    });

    // Task #489: elite crystal stream — champion + runner-up, rate-capped 2/domain/hour
    const eliteResults: Array<{ genome: Genome; result: EvalResult }> = newRunnerUpGenome
      ? [
          { genome: results[0]!.genome,   result: results[0]!.result },
          { genome: newRunnerUpGenome,     result: results[1]?.result ?? results[0]!.result },
        ]
      : [{ genome: results[0]!.genome, result: results[0]!.result }];
    void writeEliteCrystals(ctx, domain, generation, eliteResults).catch(e => {
      logger.warn({ err: e, domain }, "[Evolver] writeEliteCrystals threw (non-fatal)");
    });

    // Task #489: anti-champion tracking — update worst-known genome for mutation repulsion
    void updateAntiChampion(ctx, domain, results).catch(e => {
      logger.warn({ err: e, domain }, "[Evolver] updateAntiChampion threw (non-fatal)");
    });

    // Gene lock detector (step 20): if champion genome is identical for 8+ generations,
    // signal a diversity burst to be injected in the offspring step.
    const champStr     = JSON.stringify(results[0]!.genome);
    const lastChampStr = _domainLastChampionStr.get(domain);
    if (lastChampStr === champStr) {
      _domainChampionStreak.set(domain, (_domainChampionStreak.get(domain) ?? 0) + 1);
    } else {
      _domainChampionStreak.set(domain, 0);
      _domainLastChampionStr.set(domain, champStr);
    }
    _persistStreakState();
    const geneLockActive = (_domainChampionStreak.get(domain) ?? 0) >= 8;
    if (geneLockActive) {
      logger.warn({ domain, generation, streak: _domainChampionStreak.get(domain) },
        "[Evolver] Gene lock detected — diversity burst will be injected this generation");
    }

    // Task #508 Phase 3: Crystallization gate — fires when champion streak ≥ 5 (not same as gene-lock).
    // Checks win-rate gate and cooldown, then writes armor to INFRA_LIBRARY.md.
    const _crystalStreak = _domainChampionStreak.get(domain) ?? 0;
    if (_crystalStreak >= 5 && results[0]) {
      void checkCrystallizationGate(
        ctx, domain, generation, results[0].genome, results[0].result.fitness,
      ).catch(e => logger.warn({ err: e, domain }, "[Evolver #508] crystallization gate error (non-fatal)"));
    }

    // Task #493 Step 8: harvest adversarial cases from bottom 10% of this generation
    if (benchmarkTasks.length > 0) {
      void harvestAdversarialCases(ctx.db, domain, generation, results, benchmarkIndex, benchmarkTasks[0]!)
        .catch(e => logger.warn({ err: e, domain }, "[Evolver #493] harvestAdversarialCases failed (non-fatal)"));
    }

    // Task #493 Step 11: update divergence log
    void updateDivergenceLog(ctx.db, domain, generation, bestFitness, false, ctx)
      .catch(e => logger.warn({ err: e, domain }, "[Evolver #493] updateDivergenceLog failed (non-fatal)"));

    // Task #493 Step 10: fill-in counterfactual outcomes for decisions made this generation
    const pendingCFs = _pendingCounterfactuals.get(domain) ?? [];
    if (pendingCFs.length > 0) {
      const genResultsByHash = new Map(results.map(r => [genomeHash(r.genome), r.result.fitness]));
      for (const { logId, targetedHash, randomHash } of pendingCFs) {
        const tFit = genResultsByHash.get(targetedHash);
        const rFit = genResultsByHash.get(randomHash);
        if (tFit !== undefined && rFit !== undefined) {
          void ctx.db.updateCounterfactualOutcomes(logId, tFit, rFit)
            .catch(() => {});
        }
      }
      _pendingCounterfactuals.set(domain, []);
      // Check if targeting is underperforming random → auto-reset ε
      void checkCounterfactualReset(ctx.db, domain)
        .catch(e => logger.warn({ err: e, domain }, "[Evolver #493] checkCounterfactualReset failed (non-fatal)"));
    }

    // Task #493 Step 4: decay ε based on current model confidence
    const currentConf = _domainModelConf.get(domain) ?? 0;
    if (currentConf > 0) decayEpsilon(domain, currentConf);

    // Step m: G5+ provider-cap enforcement + offspring generation
    // Must happen before inserting offspring so fitness=0 offspring don't
    // accidentally land in the "bottom 10" and get immediately killed.
    const evalRows = await ctx.db.getAlivePopulation(genRow.id);
    const sortedRows = [...evalRows].sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0));

    // Start with top-10 as candidate survivors
    // Task #508: 40% gladiator kill rate — exclude tournament losers from survivors.
    // _tournamentLoserSet was built above from the bottom 40% of bracketed non-elite results.
    // Losers are pushed to deadRows and replaced by winner mutations in the offspring step.
    const allCandidates = sortedRows.slice(0, 10);
    const [survivorCandidates, loserCandidates] = allCandidates.reduce<
      [typeof allCandidates, typeof allCandidates]
    >(([s, l], row) => {
      const genStr = JSON.stringify(row.genome);
      return _tournamentLoserSet.has(genStr) ? [s, [...l, row]] : [[...s, row], l];
    }, [[], []]);
    let survivorRows = survivorCandidates.length >= 2
      ? survivorCandidates
      : allCandidates; // fallback: if bracket had too few matches, keep all 10
    let deadRows     = sortedRows.slice(10);

    // G5+: enforce max 50% from any single provider among the surviving 10.
    // If a provider holds > 5 of 10 slots, demote the excess (by fitness rank)
    // to make room for diversity. The demoted slots are filled by offspring from
    // a non-dominant provider.
    const MAX_PROVIDER_SHARE = 5;
    const providerGroups = new Map<string, typeof survivorRows>();
    for (const row of survivorRows) {
      const p = (row.genome as unknown as Genome).provider;
      const g = providerGroups.get(p) ?? [];
      g.push(row);
      providerGroups.set(p, g);
    }

    const demotedRows: typeof survivorRows = [];
    const dominantProviders = new Set<Provider>();
    for (const [provider, rows] of providerGroups) {
      if (rows.length > MAX_PROVIDER_SHARE) {
        const excess = rows.slice(MAX_PROVIDER_SHARE);
        demotedRows.push(...excess);
        dominantProviders.add(provider as Provider);
        logger.info(
          { domain, generation, provider, total: rows.length, demoted: excess.length },
          "[Evolver G5+] Provider over-represented — demoting excess survivors",
        );
      }
    }

    if (demotedRows.length > 0) {
      survivorRows = survivorRows.filter(r => !demotedRows.some(d => d.id === r.id));
      deadRows     = [...deadRows, ...demotedRows];
    }

    // Elitism: rescue the pre-generation champion if it was killed (e.g. rate-limited this gen)
    if (preGenChampion) {
      const champGenStr      = JSON.stringify(preGenChampion.genome);
      const champInSurvivors = survivorRows.some(r => JSON.stringify(r.genome) === champGenStr);
      if (!champInSurvivors) {
        const champIdx = deadRows.findIndex(r => JSON.stringify(r.genome) === champGenStr);
        if (champIdx >= 0) {
          const elite  = deadRows[champIdx]!;
          deadRows.splice(champIdx, 1);
          const demoted = survivorRows[survivorRows.length - 1]!;
          // Insert at front (position 0) so diversity injection (which removes from end) never evicts it
          survivorRows  = [elite, ...survivorRows.slice(0, survivorRows.length - 1)];
          deadRows.push(demoted);
          logger.info({ domain, generation }, "[Evolver] Elitism: champion rescued from dead pool");
        }
      }
    }

    // Also rescue runner-up (2nd-best historical genome) for true top-2 elitism
    // Guard rails (step 16): skip rescue if runner-up is below fitness floor or too stale.
    if (preGenRunnerUp) {
      const runnerAge = _domainRunnerUpAge.get(domain) ?? 0;
      // Estimate runner-up fitness from this generation's results (may be 0 if not evaluated)
      const runnerGenStr  = JSON.stringify(preGenRunnerUp);
      const runnerFitness = results.find(r => JSON.stringify(r.genome) === runnerGenStr)?.result.fitness ?? 0;
      const floorOk  = runnerFitness > 0.25 || runnerFitness === 0; // 0 = not evaluated this gen, allow rescue
      const staleOk  = runnerAge <= 5;
      if (floorOk && staleOk) {
        const isSameAsChamp     = preGenChampion && JSON.stringify(preGenChampion.genome) === runnerGenStr;
        const runnerInSurvivors = survivorRows.some(r => JSON.stringify(r.genome) === runnerGenStr);
        if (!runnerInSurvivors && !isSameAsChamp) {
          const runnerIdx = deadRows.findIndex(r => JSON.stringify(r.genome) === runnerGenStr);
          if (runnerIdx >= 0) {
            const elite   = deadRows[runnerIdx]!;
            deadRows.splice(runnerIdx, 1);
            const demoted = survivorRows[survivorRows.length - 1]!;
            // Insert at position 1 (after champion at position 0)
            survivorRows  = survivorRows.length > 0
              ? [survivorRows[0]!, elite, ...survivorRows.slice(1, survivorRows.length - 1)]
              : [elite];
            deadRows.push(demoted);
            logger.info({ domain, generation, runnerAge }, "[Evolver] Elitism: runner-up rescued from dead pool");
          }
        }
      } else {
        logger.info({ domain, generation, runnerAge, floorOk, staleOk },
          "[Evolver] Elitism: runner-up rescue skipped (fitness floor or stale guard)");
      }
    }

    // Diversity injection: demote lowest-fitness survivors so they are replaced by fresh
    // random genomes appended to offspring after the offspring loop.
    // Champion is safe — elitism above already placed it in position 0.
    let diverseExtraCount = 0;
    if (numDiversityInjections > 0 && survivorRows.length > 1) {
      const numToDemote = Math.min(numDiversityInjections, survivorRows.length - 1);
      const demoted     = survivorRows.slice(survivorRows.length - numToDemote);
      survivorRows      = survivorRows.slice(0, survivorRows.length - numToDemote);
      deadRows          = [...deadRows, ...demoted];
      diverseExtraCount = numToDemote;
      logger.info({ domain, generation, numToDemote },
        "[Evolver] Diversity injection: demoting lowest-fitness survivors");
    }

    const deadIds = deadRows.map(r => r.id);
    if (deadIds.length > 0) await ctx.db.markDeadPopulation(deadIds);

    // Log provider distribution in survivors
    const providerDist: Record<string, number> = {};
    for (const row of survivorRows) {
      const p = (row.genome as unknown as Genome).provider;
      providerDist[p] = (providerDist[p] ?? 0) + 1;
    }
    logger.info({ domain, generation, providerDist }, "[Evolver] Survivor provider distribution");

    // Generate offspring from actual survivors.
    // When providers were demoted, bias some offspring toward non-dominant parents
    // to actively build provider diversity into the next generation.
    const survivorGenomes = survivorRows.map(r => r.genome as unknown as Genome);
    const diverseParents  = survivorGenomes.filter(g => !dominantProviders.has(g.provider));
    const parents         = survivorGenomes.length > 0 ? survivorGenomes : [_rng(domain)];

    // Parameter diversity pressure: if >60% of survivors share the same temperature
    // or maxTokens value, flag it so the offspring loop can break the convergence.
    const tempCounts   = new Map<Temperature, number>();
    const tokenCounts  = new Map<MaxTokens, number>();
    for (const g of survivorGenomes) {
      tempCounts.set(g.temperature,  (tempCounts.get(g.temperature)  ?? 0) + 1);
      tokenCounts.set(g.maxTokens,   (tokenCounts.get(g.maxTokens)   ?? 0) + 1);
    }
    const n = survivorGenomes.length || 1;
    const [dominantTemp]   = [...tempCounts.entries()].sort((a, b) => b[1] - a[1]);
    const [dominantTokens] = [...tokenCounts.entries()].sort((a, b) => b[1] - a[1]);
    const forceDiverseTemp   = !!dominantTemp   && dominantTemp[1]   / n > 0.6;
    const forceDiverseTokens = !!dominantTokens && dominantTokens[1] / n > 0.6;
    if (forceDiverseTemp)   logger.info({ domain, generation, temp: dominantTemp![0]  }, "[Evolver] Param diversity: temperature convergence detected — diversifying offspring");
    if (forceDiverseTokens) logger.info({ domain, generation, tokens: dominantTokens![0] }, "[Evolver] Param diversity: maxTokens convergence detected — diversifying offspring");

    const offspring: Genome[] = [];
    while (offspring.length < 10) {
      // For the first demotedRows.length offspring, prefer diverse parents
      const useDiverseParent =
        dominantProviders.size > 0 &&
        offspring.length < demotedRows.length &&
        diverseParents.length > 0;

      let child: Genome;
      if (useDiverseParent) {
        const dp = diverseParents[Math.floor(Math.random() * diverseParents.length)]!;
        child = mutate(dp, mutationGenes, domain);
      } else {
        // Task #493 Step 4: ε-greedy parent selection — exploit co-occurrence model or explore randomly
        const { selected: p1, randomAlternative: p1Random, wasTargeted: p1Targeted } =
          epsilonSelectParent(domain, parents);
        const p2 = parents[Math.floor(Math.random() * parents.length)]!;
        child = Math.random() < 0.5 ? mutate(p1, mutationGenes, domain) : crossover(p1, p2);

        // Task #493 Step 10: log counterfactual decision when model is active and guided
        if (p1Targeted && p1 !== p1Random) {
          const model = _domainCooccurrenceModel.get(domain);
          if (model && model.evalCount >= MODEL_ACTIVATION_THRESHOLD) {
            void logCounterfactualDecision(
              ctx.db, domain, generation, p1, p1Random,
              model.getPromisingness(p1), model.getPromisingness(p1Random),
            ).then(logId => {
              const pending = _pendingCounterfactuals.get(domain) ?? [];
              pending.push({ logId, targetedHash: genomeHash(p1), randomHash: genomeHash(p1Random) });
              _pendingCounterfactuals.set(domain, pending);
            }).catch(() => {});
          }
        }
      }

      // Break parameter convergence: if the child inherited the dominant value,
      // force it to sample from the full remaining range instead.
      if (forceDiverseTemp && child.temperature === dominantTemp![0]) {
        const others = TEMPERATURES.filter(t => t !== dominantTemp![0]);
        if (others.length > 0) child = { ...child, temperature: others[Math.floor(Math.random() * others.length)]! };
      }
      if (forceDiverseTokens && child.maxTokens === dominantTokens![0]) {
        const others = (domainMaxTokens(domain) as MaxTokens[]).filter(t => t !== dominantTokens![0]);
        if (others.length > 0) child = { ...child, maxTokens: others[Math.floor(Math.random() * others.length)]! };
      }

      offspring.push(clampGenome(child, domain));
    }

    // Append fresh random genomes (round-robin provider, step 18) to replenish diversity injection slots.
    // Population size stays at (10 - numToDemote) survivors + (10 + numToDemote) offspring = 20.
    for (let di = 0; di < diverseExtraCount; di++) {
      const nonDominant = PROVIDERS.filter(p => !dominantProviders.has(p));
      const provPool    = nonDominant.length > 0 ? nonDominant : [...PROVIDERS];
      const rriIdx      = _escapeProviderIndex.get(domain) ?? 0;
      const escProvider = provPool[rriIdx % provPool.length]!;
      _escapeProviderIndex.set(domain, rriIdx + 1);
      offspring.push(clampGenome({ ..._rng(domain), provider: escProvider as Provider }, domain));
    }

    // Gene lock diversity burst (step 20): champion unchanged 8+ gens → inject 4 maximally-diverse genomes
    if (geneLockActive) {
      for (let gi = 0; gi < 4; gi++) offspring.push(_rng(domain));
      logger.warn({ domain, generation }, "[Evolver] Gene lock: 4-genome diversity burst injected");
      _domainChampionStreak.set(domain, 0); // reset streak after burst
    }

    // Persist offspring as alive rows alongside survivors so the next cycle
    // (and any boot-resume) picks up evolved genomes instead of pure randoms.
    // Result: ≤10 alive survivors + 10 alive offspring = ≤20 rows for next cycle.
    await ctx.db.bulkInsertPopulation(
      offspring.map(g => ({
        generation_id: genRow.id,
        domain,
        genome:        g as unknown as Record<string, unknown>,
        fitness:       0,
        alive:         true,
      })),
    );

    logger.info(
      { domain, generation, survivors: survivorRows.length, demoted: demotedRows.length,
        offspring: offspring.length, genId: genRow.id },
      "[Evolver] survivors persisted",
    );

    if (isGeneral && _generalGenerations % 5 === 0) {
      await checkAndActivateSpecialisation(ctx, _generalGenerations, _specialisedDomains, nodeId);
    }
  }

  const heapAfter = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  logger.info(
    { domain, generation, heapMb: heapAfter, deltaHeapMb: heapAfter - heapBefore },
    "[Evolver] Generation end",
  );

  return !generationFailed;
}

// ── Step 7b: Coordinator loop — sequential multi-domain execution ──────────
// Runs all EVOLVER_DOMAINS one at a time. Each domain's population + result
// arrays are fully out of scope before the next domain begins, so peak heap
// stays at 1× instead of N× concurrent loops.
//
// Specialised domains (high-variance, promoted by checkAndActivateSpecialisation)
// get an extra generation call per coordinator cycle on top of their normal pass.
async function runCoordinatorLoop(ctx: EvolverContext, nodeId: string, targetDomain?: EvolverDomain): Promise<void> {
  for (;;) {
    // Yield at the top of every coordinator pass
    await new Promise<void>(r => setImmediate(r));

    // Pass 1: run domains — all of them, or just the target when in single-domain (Island) mode
    const domainsToRun: EvolverDomain[] = targetDomain ? [targetDomain] : [...EVOLVER_DOMAINS];
    for (const domain of domainsToRun) {
      try {
        await runSingleGeneration(ctx, domain, nodeId);
      } catch (err) {
        logger.error({ err, domain }, "[Evolver] runSingleGeneration crashed — skipping domain this pass");
      }
      // Yield between domains so other async work (HTTP, ZomBrains tasks) can proceed
      await new Promise<void>(r => setImmediate(r));
    }

    // Pass 2: extra run for specialised high-variance domains (skipped in single-domain Island mode)
    if (!targetDomain) {
      for (const domain of _specialisedDomains) {
        try {
          await runSingleGeneration(ctx, domain, nodeId);
        } catch (err) {
          logger.error({ err, domain }, "[Evolver] Specialised extra pass crashed — skipping");
        }
        await new Promise<void>(r => setImmediate(r));
      }
    }

    // Task #489: rollback watchdog check + cross-stream anomaly detection
    await checkRollbackWatchdogs(ctx).catch(e => {
      logger.warn({ err: e }, "[Evolver] checkRollbackWatchdogs threw (non-fatal)");
    });
    void runAnomalyDetection(ctx);

    // Sleep between full coordinator passes: 5 min ±30s jitter
    await new Promise<void>(r => setTimeout(r, 5 * 60_000 + (Math.random() - 0.5) * 60_000));
  }
}

// ── Step 8: Auto-specialisation ──────────────────────────────────────────
export async function checkAndActivateSpecialisation(
  ctx: EvolverContext,
  generalGenerations: number,
  activeSpecialisedDomains: Set<string>,
  nodeId: string,
): Promise<void> {
  if (generalGenerations < 20) return;

  for (const domain of EVOLVER_DOMAINS) {
    if (domain === "general") continue;
    if (activeSpecialisedDomains.has(domain)) continue;

    const rows = await ctx.db.getGenomesByDomain(domain, 100);
    if (rows.length < 5) continue;

    const fitnesses = rows.map(r => r.fitness);
    const mean      = fitnesses.reduce((s, f) => s + f, 0) / fitnesses.length;
    const variance  = fitnesses.reduce((s, f) => s + (f - mean) ** 2, 0) / fitnesses.length;

    if (variance > 0.15) {
      activeSpecialisedDomains.add(domain);
      logger.info({ domain, variance, generalGenerations }, "[Evolver] Domain marked for specialised extra pass");
      void writeErrorLog({
        route:   "evolver",
        method:  "specialise",
        message: `[Evolver] Specialised extra pass activated for domain: ${domain} (variance ${variance.toFixed(3)})`,
        source:  "crystalline-evolver",
      });
      // No new loop spawned — coordinator handles specialised domains sequentially
      // via the pass-2 extra run in runCoordinatorLoop.
    }
  }
}

// ── Step 8b: getEvolverStatus — snapshot of in-process evolver state ─────
export function getEvolverStatus(): {
  generalGenerations: number;
  specialisedDomains: string[];
  breakers: Record<string, { consecutiveFailures: number; pausedUntil: number; stopped: boolean; stressSkipStreak: number }>;
} {
  const breakers: Record<string, { consecutiveFailures: number; pausedUntil: number; stopped: boolean; stressSkipStreak: number }> = {};
  for (const [domain, b] of _breakerByDomain) {
    breakers[domain] = {
      consecutiveFailures: b.consecutiveFailures,
      pausedUntil:         b.pausedUntil,
      stopped:             b.stopped,
      stressSkipStreak:    b.stressSkipStreak,
    };
  }
  return {
    generalGenerations: _generalGenerations,
    specialisedDomains: [..._specialisedDomains],
    breakers,
  };
}

// ── resetEvolverDomain — clear circuit breaker for one domain or all ──────
export function resetEvolverDomain(domain: string): void {
  if (domain === "all") {
    for (const [, b] of _breakerByDomain) {
      b.consecutiveFailures = 0;
      b.pausedUntil         = 0;
      b.stopped             = false;
      b.stressSkipStreak    = 0;
    }
    return;
  }
  const b = _breakerByDomain.get(domain);
  if (!b) {
    // Domain not yet seen — create a clean entry so the reset is idempotent
    _breakerByDomain.set(domain, { consecutiveFailures: 0, pausedUntil: 0, stopped: false, stressSkipStreak: 0 });
    return;
  }
  b.consecutiveFailures = 0;
  b.pausedUntil         = 0;
  b.stopped             = false;
  b.stressSkipStreak    = 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Stage D: Genome Type Registry + Functional Evolver Types (Task #489)
// Three-level hierarchy: Level 1 = execution, Level 2 = strategy, Level 3 = system.
// Level 1/2 auto-inject on improvement (guarded by shadow/gate/circuit breaker).
// Level 3 always requires explicit human approval in admin panel.
// ═══════════════════════════════════════════════════════════════════════════

// ── GenomeType<G> interface ───────────────────────────────────────────────────

export interface GenomeType<G> {
  name:      string;
  level:     1 | 2 | 3;
  clamp(g: G): G;
  mutate(g: G): G;
  crossover(a: G, b: G): G;
  fitness(result: EvalResult): number;
  benchmark(g: G, injCtx: InjectionCtx): Promise<EvalResult>;
  inject(champion: G, ctx: InjectionCtx): Promise<void>;
}

export const GENOME_TYPE_REGISTRY = new Map<string, GenomeType<unknown>>();

export function registerGenomeType<G>(type: GenomeType<G>): void {
  GENOME_TYPE_REGISTRY.set(type.name, type as GenomeType<unknown>);
}

// ── PromptGenome (Level 2) ────────────────────────────────────────────────────

export interface PromptGenome {
  openingInstruction: "direct" | "step-by-step" | "analytical" | "creative" | "concise";
  contextStyle:       "none" | "minimal" | "detailed" | "expert";
  outputFormat:       "prose" | "bullets" | "numbered" | "structured" | "code-first";
  constraintStyle:    "none" | "soft" | "strict";
  exampleInclusion:   "never" | "when-helpful" | "always";
  tone:               "neutral" | "professional" | "collaborative" | "direct";
}

const PROMPT_GENOME_OPTIONS: { [K in keyof PromptGenome]: ReadonlyArray<PromptGenome[K]> } = {
  openingInstruction: ["direct", "step-by-step", "analytical", "creative", "concise"],
  contextStyle:       ["none", "minimal", "detailed", "expert"],
  outputFormat:       ["prose", "bullets", "numbered", "structured", "code-first"],
  constraintStyle:    ["none", "soft", "strict"],
  exampleInclusion:   ["never", "when-helpful", "always"],
  tone:               ["neutral", "professional", "collaborative", "direct"],
};

function _buildPromptFromGenome(pg: PromptGenome, taskText: string): { system: string; user: string } {
  const openingMap: Record<PromptGenome["openingInstruction"], string> = {
    "direct":      "",
    "step-by-step": "Think through this step by step.",
    "analytical":  "Analyse this systematically before answering.",
    "creative":    "Approach this creatively.",
    "concise":     "Be concise and direct.",
  };
  const toneMap: Record<PromptGenome["tone"], string> = {
    "neutral":       "You are a helpful assistant.",
    "professional":  "You are a precise, professional assistant.",
    "collaborative": "You are a collaborative partner. Let's work through this together.",
    "direct":        "You are a direct, no-nonsense assistant. Get to the point.",
  };
  const contextExtra: Record<PromptGenome["contextStyle"], string> = {
    "none":     "",
    "minimal":  " Be concise.",
    "detailed": " Provide sufficient detail.",
    "expert":   " Assume expert-level knowledge in the domain.",
  };
  const formatExtra: Record<PromptGenome["outputFormat"], string> = {
    "prose":       "",
    "bullets":     " Use bullet points.",
    "numbered":    " Number each point.",
    "structured":  " Use clear section headers.",
    "code-first":  " Lead with code, explain after.",
  };
  const constraintExtra: Record<PromptGenome["constraintStyle"], string> = {
    "none":   "",
    "soft":   " Aim to be accurate and relevant.",
    "strict": " Be strictly accurate; say 'I don't know' rather than guess.",
  };
  const exampleExtra: Record<PromptGenome["exampleInclusion"], string> = {
    "never":       "",
    "when-helpful": " Include an example if it would help clarify.",
    "always":      " Always include at least one concrete example.",
  };
  const system = toneMap[pg.tone]
    + contextExtra[pg.contextStyle]
    + formatExtra[pg.outputFormat]
    + constraintExtra[pg.constraintStyle]
    + exampleExtra[pg.exampleInclusion];
  const opening = openingMap[pg.openingInstruction];
  const user    = opening ? `${opening}\n\n${taskText}` : taskText;
  return { system, user };
}

const _PROMPT_EVAL_TASKS: readonly string[] = [
  BENCHMARK_TASKS[0] ?? "Explain how to debug a Node.js memory leak.",
  BENCHMARK_TASKS[4] ?? "List three common causes of database query slowness.",
  BENCHMARK_TASKS[2] ?? "Describe the difference between a process and a thread.",
];

const promptEvolverType: GenomeType<PromptGenome> = {
  name:  "prompt-evolver",
  level: 2,
  clamp: g => g,
  mutate(g) {
    const keys = Object.keys(PROMPT_GENOME_OPTIONS) as (keyof PromptGenome)[];
    const key  = keys[Math.floor(Math.random() * keys.length)]!;
    const opts = PROMPT_GENOME_OPTIONS[key] as ReadonlyArray<PromptGenome[keyof PromptGenome]>;
    const others = opts.filter(v => v !== g[key]);
    if (others.length === 0) return g;
    return { ...g, [key]: others[Math.floor(Math.random() * others.length)] };
  },
  crossover(a, b) {
    const keys = Object.keys(PROMPT_GENOME_OPTIONS) as (keyof PromptGenome)[];
    const split = Math.floor(Math.random() * keys.length);
    const result = { ...a };
    for (let i = split; i < keys.length; i++) {
      const k = keys[i]!;
      (result as Record<string, unknown>)[k] = b[k];
    }
    return result;
  },
  fitness: r => r.qualityScore / 100,
  async benchmark(g, injCtx) {
    let totalScore = 0;
    let attempts   = 0;
    const secret   = process.env["ADMIN_SECRET"] ?? "";
    const port     = process.env["PORT"] ?? "5000";
    for (const taskText of _PROMPT_EVAL_TASKS) {
      const { system, user } = _buildPromptFromGenome(g, taskText);
      try {
        const res = await fetch(`http://localhost:${port}/api/crystalline/prompt-eval`, {
          method:  "POST",
          headers: { "Content-Type": "application/json", "x-admin-secret": secret },
          body:    JSON.stringify({ system, user }),
          signal:  AbortSignal.timeout(30_000),
        });
        if (!res.ok) continue;
        const data = await res.json() as { qualityScore?: number };
        if (typeof data.qualityScore === "number") {
          totalScore += data.qualityScore;
          attempts++;
        }
      } catch { /* non-fatal */ }
    }
    const avgScore = attempts > 0 ? totalScore / attempts : 0;
    return { fitness: avgScore / 100, tokensUsed: 0, qualityScore: avgScore, resolvedBy: "api" as const, components: null };
  },
  async inject(champion, ctx) {
    await ctx.setBotSetting("prompt_template_opening", champion.openingInstruction);
    await ctx.setBotSetting("prompt_template_context", champion.contextStyle);
    await ctx.setBotSetting("prompt_template_format", champion.outputFormat);
    await ctx.setBotSetting("prompt_template_constraint", champion.constraintStyle);
    await ctx.setBotSetting("prompt_template_examples", champion.exampleInclusion);
    await ctx.setBotSetting("prompt_template_tone", champion.tone);
    logger.info({ champion }, "[Evolver] Prompt evolver injected");
  },
};

registerGenomeType(promptEvolverType);

// ── ToolSelectGenome (Level 2) ────────────────────────────────────────────────

export interface ToolSelectGenome {
  codingToolPriority:      string[];
  planningToolPriority:    string[];
  diagnosticToolPriority:  string[];
  knowledgeToolPriority:   string[];
  generalToolPriority:     string[];
  fallbackStrategy:        "skip" | "use-first" | "random";
}

const TOOL_CATEGORIES = ["code", "plan", "diagnose", "knowledge", "io", "shell", "ai", "memory"] as const;
type ToolCategory = (typeof TOOL_CATEGORIES)[number];

// Reference orderings: what expert selection looks like per task type.
const IDEAL_TOOL_ORDER: Record<string, ToolCategory[]> = {
  codingToolPriority:     ["code", "shell", "diagnose", "knowledge", "io", "plan", "ai", "memory"],
  planningToolPriority:   ["plan", "knowledge", "memory", "ai", "code", "shell", "diagnose", "io"],
  diagnosticToolPriority: ["diagnose", "shell", "code", "knowledge", "memory", "io", "plan", "ai"],
  knowledgeToolPriority:  ["knowledge", "memory", "ai", "plan", "code", "diagnose", "io", "shell"],
  generalToolPriority:    ["plan", "knowledge", "code", "ai", "diagnose", "memory", "shell", "io"],
};

function _kendallTau(a: string[], b: string[]): number {
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const bI = b.indexOf(a[i]!);
      const bJ = b.indexOf(a[j]!);
      if (bI === -1 || bJ === -1) continue;
      if (bI < bJ) concordant++;
      else discordant++;
    }
  }
  const total = concordant + discordant;
  return total > 0 ? (concordant - discordant) / total : 0;
}

function _toolSelectFitness(g: ToolSelectGenome): number {
  const keys = ["codingToolPriority", "planningToolPriority", "diagnosticToolPriority", "knowledgeToolPriority", "generalToolPriority"] as const;
  let totalTau = 0;
  for (const key of keys) {
    const ideal = IDEAL_TOOL_ORDER[key] ?? [];
    totalTau += (_kendallTau(g[key], ideal) + 1) / 2; // normalise [-1,1] → [0,1]
  }
  return totalTau / keys.length;
}

function _randomToolOrder(): ToolCategory[] {
  return [...TOOL_CATEGORIES].sort(() => Math.random() - 0.5);
}

const toolSelectEvolverType: GenomeType<ToolSelectGenome> = {
  name:  "tool-selection-evolver",
  level: 2,
  clamp: g => g,
  mutate(g) {
    const listKeys = ["codingToolPriority", "planningToolPriority", "diagnosticToolPriority", "knowledgeToolPriority", "generalToolPriority"] as const;
    const key      = listKeys[Math.floor(Math.random() * listKeys.length)]!;
    const list     = [...g[key]];
    if (list.length < 2) return g;
    const i = Math.floor(Math.random() * (list.length - 1));
    [list[i], list[i + 1]] = [list[i + 1]!, list[i]!];
    return { ...g, [key]: list };
  },
  crossover(a, b) {
    const listKeys = ["codingToolPriority", "planningToolPriority", "diagnosticToolPriority", "knowledgeToolPriority", "generalToolPriority"] as const;
    const result   = { ...a };
    for (const key of listKeys) {
      if (Math.random() > 0.5) (result as Record<string, unknown>)[key] = b[key];
    }
    result.fallbackStrategy = Math.random() > 0.5 ? b.fallbackStrategy : a.fallbackStrategy;
    return result;
  },
  fitness: _r => 0, // unused for this type — benchmark returns computed fitness directly
  async benchmark(g, _ctx) {
    const fit = _toolSelectFitness(g);
    return { fitness: fit, tokensUsed: 0, qualityScore: fit * 100, resolvedBy: "api" as const, components: null };
  },
  async inject(champion, ctx) {
    await ctx.setBotSetting("tool_priority_config", JSON.stringify({
      codingToolPriority:     champion.codingToolPriority,
      planningToolPriority:   champion.planningToolPriority,
      diagnosticToolPriority: champion.diagnosticToolPriority,
      knowledgeToolPriority:  champion.knowledgeToolPriority,
      generalToolPriority:    champion.generalToolPriority,
      fallbackStrategy:       champion.fallbackStrategy,
    }));
    logger.info({ champion }, "[Evolver] Tool selection evolver injected");
  },
};

registerGenomeType(toolSelectEvolverType);

// ── QualityGenome (Level 3) ───────────────────────────────────────────────────

export interface QualityGenome {
  lengthWeight:      number;
  completionWeight:  number;
  structureWeight:   number;
  relevanceWeight:   number;
  consistencyWeight: number;
  noveltyWeight:     number;
}

function _normaliseQualityGenome(g: QualityGenome): QualityGenome {
  const keys: (keyof QualityGenome)[] = ["lengthWeight", "completionWeight", "structureWeight", "relevanceWeight", "consistencyWeight", "noveltyWeight"];
  const total = keys.reduce((s, k) => s + Math.max(0, g[k]), 0) || 1;
  return Object.fromEntries(keys.map(k => [k, Math.max(0, g[k]) / total])) as unknown as QualityGenome;
}

const qualityEvolverType: GenomeType<QualityGenome> = {
  name:  "quality-scoring-evolver",
  level: 3,
  clamp: _normaliseQualityGenome,
  mutate(g) {
    const keys: (keyof QualityGenome)[] = ["lengthWeight", "completionWeight", "structureWeight", "relevanceWeight", "consistencyWeight", "noveltyWeight"];
    const key = keys[Math.floor(Math.random() * keys.length)]!;
    const delta = (Math.random() - 0.5) * 0.1;
    return _normaliseQualityGenome({ ...g, [key]: Math.max(0.01, g[key] + delta) });
  },
  crossover(a, b) {
    const keys: (keyof QualityGenome)[] = ["lengthWeight", "completionWeight", "structureWeight", "relevanceWeight", "consistencyWeight", "noveltyWeight"];
    const result = { ...a };
    for (const k of keys) {
      result[k] = Math.random() > 0.5 ? a[k] : b[k];
    }
    return _normaliseQualityGenome(result);
  },
  fitness: r => r.fitness,
  async benchmark(g, ctx) {
    const secret = process.env["ADMIN_SECRET"] ?? "";
    const port   = process.env["PORT"] ?? "5000";
    try {
      const r = await fetch(`http://localhost:${port}/api/crystalline/elite-crystals?limit=20`, {
        headers: { "x-admin-secret": secret },
        signal:  AbortSignal.timeout(10_000),
      });
      if (!r.ok) return { fitness: 0, tokensUsed: 0, qualityScore: 0, resolvedBy: "api" as const, components: null };
      const data  = await r.json() as { crystals?: Array<{ quality_score: number; fitness: number }> };
      const items = data.crystals ?? [];
      if (items.length < 3) return { fitness: 0.5, tokensUsed: 0, qualityScore: 50, resolvedBy: "api" as const, components: null };
      let sumSqErr = 0;
      for (const item of items) {
        const pred = (
          g.lengthWeight * Math.min(1, item.quality_score / 100) +
          g.completionWeight * (item.quality_score > 30 ? 1 : 0) +
          g.relevanceWeight  * (item.quality_score / 100)
        );
        sumSqErr += (pred - item.fitness) ** 2;
      }
      const rmse    = Math.sqrt(sumSqErr / items.length);
      const fitness = Math.max(0, 1 - rmse);
      return { fitness, tokensUsed: 0, qualityScore: fitness * 100, resolvedBy: "api" as const, components: null };
    } catch {
      return { fitness: 0, tokensUsed: 0, qualityScore: 0, resolvedBy: "api" as const, components: null };
    }
  },
  async inject(champion, ctx) {
    await ctx.setBotSetting("quality_score_deltas", JSON.stringify({
      lengthWeight:      champion.lengthWeight,
      completionWeight:  champion.completionWeight,
      structureWeight:   champion.structureWeight,
      relevanceWeight:   champion.relevanceWeight,
      consistencyWeight: champion.consistencyWeight,
      noveltyWeight:     champion.noveltyWeight,
    }));
    logger.info({ champion }, "[Evolver] Quality scoring evolver injected (Level 3, human approved)");
  },
};

registerGenomeType(qualityEvolverType);

// ── FailureGenome (Level 3) ───────────────────────────────────────────────────

export interface FailureGenome {
  maxRetries:             1 | 2 | 3 | 4 | 5;
  retryDelayMs:           1000 | 5000 | 15000 | 30000 | 60000;
  escalationThreshold:    1 | 2 | 3;
  fallbackToSafeMode:     boolean;
  includeContextInReport: boolean;
  notifyOnFirstFailure:   boolean;
}

const FAILURE_GENOME_OPTIONS = {
  maxRetries:          [1, 2, 3, 4, 5] as const,
  retryDelayMs:        [1000, 5000, 15000, 30000, 60000] as const,
  escalationThreshold: [1, 2, 3] as const,
};

function _failureGenomeFitness(g: FailureGenome): number {
  const recoverySpeed = 1 - (g.retryDelayMs / 60000) * 0.4
    + (g.maxRetries / 5) * 0.3;
  const nonRecurrence = (g.escalationThreshold / 3) * 0.2
    + (g.fallbackToSafeMode ? 0.1 : 0)
    + (g.includeContextInReport ? 0.05 : 0)
    + (g.notifyOnFirstFailure ? 0.05 : 0);
  return Math.max(0, Math.min(1, recoverySpeed + nonRecurrence));
}

const failureResponseEvolverType: GenomeType<FailureGenome> = {
  name:  "failure-response-evolver",
  level: 3,
  clamp: g => g,
  mutate(g) {
    const roll = Math.random();
    if (roll < 0.2) {
      const opts = FAILURE_GENOME_OPTIONS.maxRetries;
      return { ...g, maxRetries: opts[Math.floor(Math.random() * opts.length)]! };
    } else if (roll < 0.4) {
      const opts = FAILURE_GENOME_OPTIONS.retryDelayMs;
      return { ...g, retryDelayMs: opts[Math.floor(Math.random() * opts.length)]! };
    } else if (roll < 0.6) {
      const opts = FAILURE_GENOME_OPTIONS.escalationThreshold;
      return { ...g, escalationThreshold: opts[Math.floor(Math.random() * opts.length)]! };
    } else if (roll < 0.7) {
      return { ...g, fallbackToSafeMode: !g.fallbackToSafeMode };
    } else if (roll < 0.85) {
      return { ...g, includeContextInReport: !g.includeContextInReport };
    } else {
      return { ...g, notifyOnFirstFailure: !g.notifyOnFirstFailure };
    }
  },
  crossover(a, b) {
    return {
      maxRetries:             Math.random() > 0.5 ? a.maxRetries : b.maxRetries,
      retryDelayMs:           Math.random() > 0.5 ? a.retryDelayMs : b.retryDelayMs,
      escalationThreshold:    Math.random() > 0.5 ? a.escalationThreshold : b.escalationThreshold,
      fallbackToSafeMode:     Math.random() > 0.5 ? a.fallbackToSafeMode : b.fallbackToSafeMode,
      includeContextInReport: Math.random() > 0.5 ? a.includeContextInReport : b.includeContextInReport,
      notifyOnFirstFailure:   Math.random() > 0.5 ? a.notifyOnFirstFailure : b.notifyOnFirstFailure,
    };
  },
  fitness: _r => 0,
  async benchmark(g, _ctx) {
    const fit = _failureGenomeFitness(g);
    return { fitness: fit, tokensUsed: 0, qualityScore: fit * 100, resolvedBy: "api" as const, components: null };
  },
  async inject(champion, ctx) {
    await ctx.setBotSetting("failure_response_config", JSON.stringify({
      maxRetries:             champion.maxRetries,
      retryDelayMs:           champion.retryDelayMs,
      escalationThreshold:    champion.escalationThreshold,
      fallbackToSafeMode:     champion.fallbackToSafeMode,
      includeContextInReport: champion.includeContextInReport,
      notifyOnFirstFailure:   champion.notifyOnFirstFailure,
    }));
    logger.info({ champion }, "[Evolver] Failure response evolver injected (Level 3, human approved)");
  },
};

registerGenomeType(failureResponseEvolverType);

// ═══════════════════════════════════════════════════════════════════════════
// Champion Injection Pipeline (Task #489 Phase C)
// Shadow mode → improvement gate → snapshot → inject → rollback watchdog.
// ═══════════════════════════════════════════════════════════════════════════

// ── Injection pipeline state ──────────────────────────────────────────────────

const _injectionLastTimestamp  = new Map<string, number>();  // typeName → last injection ts
let   _injectionCircuitBreaker = false;
let   _consecutiveInjectionDegradations = 0;

interface WatchdogState {
  auditId:         number;
  type:            string;
  preBaseline:     number;
  snapshotId:      number;
  snapshotConfig:  Record<string, unknown>;
  snapshotType:    string;
  startedAt:       number;
  checkAfterMs:    number;
}
const _rollbackWatchdogs = new Map<string, WatchdogState>(); // type → state

// ── Shadow mode state ─────────────────────────────────────────────────────────

interface ShadowCandidate {
  genome:           Record<string, unknown>;
  shadowFitness:    number;
  shadowGens:       number;
  firstSeenFitness: number;
}
const _shadowCandidates = new Map<string, ShadowCandidate>(); // domain → candidate

const SHADOW_GENS_L12 = 3;
const SHADOW_GENS_L3  = 5;

// ── Improvement gate check ────────────────────────────────────────────────────

function _injectionImprovementGate(candidateFitness: number, currentFitness: number): boolean {
  return candidateFitness > currentFitness * 1.05;
}

// ── tryInjectDomainChampion — called from runSingleGeneration after promotion ──

export async function tryInjectDomainChampion(
  ctx: EvolverContext,
  domain: string,
  candidateGenome: Genome,
  candidateFitness: number,
  generation: number,
): Promise<void> {
  if (_injectionCircuitBreaker) {
    logger.info({ domain }, "[Evolver] Injection circuit breaker active — skipping injection");
    return;
  }

  const currentCh   = await ctx.db.getChampion(domain);
  const currentFit  = currentCh?.fitness ?? 0;

  // Shadow mode: track candidate for N gens before eligibility
  const existing = _shadowCandidates.get(domain);
  const candStr  = JSON.stringify(candidateGenome);
  if (!existing || JSON.stringify(existing.genome) !== candStr) {
    // New candidate — start shadow tracking
    _shadowCandidates.set(domain, {
      genome:           candidateGenome as unknown as Record<string, unknown>,
      shadowFitness:    candidateFitness,
      shadowGens:       1,
      firstSeenFitness: candidateFitness,
    });
    await ctx.db.updateChampionShadow(domain, candidateFitness, 1);
    logger.info({ domain, generation, fitness: candidateFitness.toFixed(3) }, "[Evolver] Shadow mode: new candidate entered shadow tracking");
    return;
  }

  // Continuing candidate — update shadow fitness and increment shadow generations
  const updatedShadow: ShadowCandidate = {
    ...existing,
    shadowFitness: (existing.shadowFitness + candidateFitness) / 2,
    shadowGens:    existing.shadowGens + 1,
  };
  _shadowCandidates.set(domain, updatedShadow);
  await ctx.db.updateChampionShadow(domain, updatedShadow.shadowFitness, updatedShadow.shadowGens);

  if (updatedShadow.shadowGens < SHADOW_GENS_L12) {
    logger.info({ domain, shadowGens: updatedShadow.shadowGens, required: SHADOW_GENS_L12 }, "[Evolver] Shadow mode: candidate still in shadow — not yet eligible");
    return;
  }

  // Shadow complete — check improvement gate
  if (!_injectionImprovementGate(updatedShadow.shadowFitness, currentFit)) {
    logger.info({ domain, candidate: updatedShadow.shadowFitness.toFixed(3), current: currentFit.toFixed(3) }, "[Evolver] Injection gate: insufficient improvement — skipping");
    _shadowCandidates.delete(domain);
    return;
  }

  // Check rate limit (1 injection per domain per 24h for domain-execution type)
  const typeKey     = `domain-execution:${domain}`;
  const lastInj     = _injectionLastTimestamp.get(typeKey) ?? 0;
  if (Date.now() - lastInj < 24 * 60 * 60_000) {
    logger.info({ domain, lastInjectionAgo: Math.round((Date.now() - lastInj) / 60_000) + "min" }, "[Evolver] Injection rate limit: too soon since last injection");
    return;
  }

  // Monotonic health gate: if 7-day quality trend is negative, block injection
  if (await _isQualityTrendNegative(ctx)) {
    logger.warn({ domain }, "[Evolver] Monotonic health gate: 7-day quality declining — injection blocked");
    return;
  }

  // domain-execution type is Level 1 — auto-inject after shadow + gate
  await _runInjection(ctx, domain, "domain-execution", 1, currentCh?.genome as Record<string, unknown> ?? null, candidateGenome as unknown as Record<string, unknown>, updatedShadow.shadowFitness, currentFit);
  _shadowCandidates.delete(domain);
}

// ── _runInjection — executes injection and writes audit log ───────────────────

async function _runInjection(
  ctx:            EvolverContext,
  domain:         string,
  typeName:       string,
  level:          1 | 2 | 3,
  genomeBefore:   Record<string, unknown> | null,
  genomeAfter:    Record<string, unknown>,
  fitAfter:       number,
  fitBefore:      number,
): Promise<void> {
  // Take config snapshot (rollback target)
  const snapshot = await ctx.db.insertConfigSnapshot({
    type:             typeName,
    config:           genomeBefore ?? {},
    quality_baseline: fitBefore,
  });

  // Write audit log
  const auditRow = await ctx.db.insertInjectionAuditLog({
    type:           typeName,
    level,
    genome_before:  genomeBefore,
    genome_after:   genomeAfter,
    fitness_before: fitBefore,
    fitness_after:  fitAfter,
  });

  // For Level 1 (domain-execution), inject by promoting to crystal_champions
  // (champion is already promoted in runSingleGeneration's step k; this injection
  // step is about writing live config for ZomBrains to read via Railway benchmark)
  if (typeName === "domain-execution") {
    // No extra action needed — champion in DB is the injection mechanism
    logger.info({ domain, fitAfter: fitAfter.toFixed(3) }, "[Evolver] Domain-execution champion injected into crystal_champions");
  } else {
    // Level 2/3: run the genome type's inject handler
    const genType = GENOME_TYPE_REGISTRY.get(typeName);
    if (genType) {
      try {
        await (genType as GenomeType<unknown>).inject(genomeAfter, ctx.injection);
      } catch (e) {
        logger.error({ err: e, typeName }, "[Evolver] Injection handler threw — audit logged but injection may be partial");
      }
    }
  }

  _injectionLastTimestamp.set(`${typeName}:${domain}`, Date.now());

  // Setup rollback watchdog: check in 2 hours
  _rollbackWatchdogs.set(typeName, {
    auditId:        auditRow.id,
    type:           typeName,
    preBaseline:    fitBefore,
    snapshotId:     snapshot.id,
    snapshotConfig: genomeBefore ?? {},
    snapshotType:   typeName,
    startedAt:      Date.now(),
    checkAfterMs:   2 * 60 * 60_000,
  });

  logger.info({ typeName, domain, fitAfter: fitAfter.toFixed(3), fitBefore: fitBefore.toFixed(3), snapshotId: snapshot.id }, "[Evolver] Injection complete — rollback watchdog armed");
}

// ── Rollback watchdog check ───────────────────────────────────────────────────
// Called from the coordinator loop periodically.

export async function checkRollbackWatchdogs(ctx: EvolverContext): Promise<void> {
  for (const [typeName, state] of _rollbackWatchdogs) {
    if (Date.now() < state.startedAt + state.checkAfterMs) continue;

    const currentQuality = await ctx.getRecentSessionQuality(10);
    if (currentQuality === null) {
      _rollbackWatchdogs.delete(typeName);
      continue;
    }

    const dropRatio = state.preBaseline > 0
      ? (state.preBaseline - currentQuality) / state.preBaseline
      : 0;

    if (dropRatio > 0.10) {
      logger.warn({ typeName, preBaseline: state.preBaseline.toFixed(3), current: currentQuality.toFixed(3), dropPct: (dropRatio * 100).toFixed(1) },
        "[Evolver] Rollback watchdog: quality drop detected — reverting injection");

      // Revert: restore snapshot config to bot_settings if applicable
      if (typeName !== "domain-execution" && Object.keys(state.snapshotConfig).length > 0) {
        const genType = GENOME_TYPE_REGISTRY.get(typeName);
        if (genType) {
          try {
            await (genType as GenomeType<unknown>).inject(state.snapshotConfig, ctx.injection);
          } catch (e) {
            logger.error({ err: e, typeName }, "[Evolver] Rollback inject handler failed");
          }
        }
      }

      // Mark audit log as rolled back
      await ctx.db.markInjectionRolledBack(state.auditId);

      // Task #493 Step 7: record rollback event for risky-gene mining
      const rollbackDomain = state.type.replace(/-evolver$/, "").replace(/-/g, "_");
      void recordRollbackEvent(
        ctx.db,
        rollbackDomain,
        state.snapshotConfig,
        `quality_drop_${(dropRatio * 100).toFixed(1)}pct`,
        state.preBaseline,
      ).catch(e => logger.warn({ err: e }, "[Evolver #493] recordRollbackEvent failed (non-fatal)"));

      // Increment circuit breaker counter
      _consecutiveInjectionDegradations++;
      if (_consecutiveInjectionDegradations >= 3) {
        _injectionCircuitBreaker = true;
        void ctx.writeDiscordDm(`⚠️ **Evolver circuit breaker triggered**: ${_consecutiveInjectionDegradations} consecutive injections caused quality drops. All injections frozen. Resume via admin panel.`);
        void writeErrorLog({ route: "evolver", method: "circuit-breaker", message: "[Evolver] Injection circuit breaker triggered — all injections frozen", source: "crystalline-evolver" });
      } else {
        void ctx.writeDiscordDm(`⚠️ **Injection rollback**: ${typeName} champion degraded quality by ${(dropRatio * 100).toFixed(1)}% — reverted automatically.`);
      }
    } else {
      // Quality held — reset degradation counter
      _consecutiveInjectionDegradations = Math.max(0, _consecutiveInjectionDegradations - 1);
      logger.info({ typeName, currentQuality: currentQuality.toFixed(3) }, "[Evolver] Rollback watchdog: quality stable after injection");
    }

    _rollbackWatchdogs.delete(typeName);
  }
}

// ── Level 3 injection queue helpers ──────────────────────────────────────────

export async function enqueueLevel3Injection<G>(
  ctx:              EvolverContext,
  typeName:         string,
  genomeCandidate:  G,
  candidateFitness: number,
  currentFitness:   number,
): Promise<void> {
  await ctx.db.insertPendingInjection({
    type:             typeName,
    genome:           genomeCandidate as Record<string, unknown>,
    candidate_fitness: candidateFitness,
    current_fitness:  currentFitness,
  });
  logger.info({ typeName, candidateFitness: candidateFitness.toFixed(3) }, "[Evolver] Level 3 candidate queued for human approval");
}

export async function approveInjection(ctx: EvolverContext, id: number): Promise<boolean> {
  const pending = await ctx.db.approvePendingInjection(id);
  if (!pending) return false;
  const genType = GENOME_TYPE_REGISTRY.get(pending.type);
  if (!genType) return false;
  const currentCh = await ctx.db.getLatestConfigSnapshot(pending.type);
  await _runInjection(ctx, pending.type, pending.type, genType.level, (currentCh?.config ?? null) as Record<string, unknown> | null, pending.genome as Record<string, unknown>, pending.candidate_fitness, pending.current_fitness);
  return true;
}

// ── Monotonic health gate ─────────────────────────────────────────────────────

async function _isQualityTrendNegative(ctx: EvolverContext): Promise<boolean> {
  const recent   = await ctx.getRecentSessionQuality(20);
  const older    = await ctx.getRecentSessionQuality(40);
  if (recent === null || older === null) return false;
  return recent < older * 0.97; // 7-day-equivalent trend using rolling sample
}

// ── Circuit breaker reset (admin panel calls this) ────────────────────────────

export function resetInjectionCircuitBreaker(): void {
  _injectionCircuitBreaker            = false;
  _consecutiveInjectionDegradations   = 0;
  logger.info("[Evolver] Injection circuit breaker reset by admin");
}

export function getInjectionCircuitBreakerActive(): boolean {
  return _injectionCircuitBreaker;
}

// ═══════════════════════════════════════════════════════════════════════════
// Negative Signal System (Task #489 Phase D)
// Anti-champion tracking, failure crystal structural rules, bottom-20% analysis.
// ═══════════════════════════════════════════════════════════════════════════

// ── Anti-champion tracking ────────────────────────────────────────────────────
// Called from runSingleGeneration after each generation.

export async function updateAntiChampion(
  ctx:     EvolverContext,
  domain:  string,
  results: Array<{ genome: Genome; result: EvalResult }>,
): Promise<void> {
  if (results.length < 3) return;

  // Find genome with lowest fitness that has been evaluated at least 3 times
  const sorted     = [...results].sort((a, b) => a.result.fitness - b.result.fitness);
  const worstResult = sorted[0];
  if (!worstResult || worstResult.result.fitness > 0.15) return; // floor: only track genuinely bad ones

  // Count how many times this genome has been evaluated (by checking recent genomes)
  const recentGenomes = await ctx.db.getGenomesByDomain(domain, 100);
  const worstStr      = JSON.stringify(worstResult.genome);
  const evalCount     = recentGenomes.filter(r => JSON.stringify(r.genome) === worstStr).length;
  if (evalCount < 3) return;

  _domainAntiChampion.set(domain, worstResult.genome);
  await ctx.db.updateAntiChampionGenome(domain, worstResult.genome as unknown as Record<string, unknown>);
  logger.info({ domain, fitness: worstResult.result.fitness.toFixed(3) }, "[Evolver] Anti-champion updated");
}

// ── Failure crystal structural rules job ─────────────────────────────────────
// Scheduled nightly from startEvolver.

export async function runFailureCrystalJob(ctx: EvolverContext): Promise<void> {
  logger.info("[Evolver] Running failure crystal → structural rules job");
  try {
    const secret = process.env["ADMIN_SECRET"] ?? "";
    const port   = process.env["PORT"] ?? "5000";
    const r = await fetch(`${`http://localhost:${port}`}/api/zombrains/persist/session-crystals?limit=200&days=7`, {
      headers: { "x-admin-secret": secret },
      signal:  AbortSignal.timeout(10_000),
    });
    if (!r.ok) return;
    const data = await r.json() as { crystals?: Array<{ payload: string; type: string }> };
    const failures = (data.crystals ?? []).filter(c => c.type === "failure" || c.type === "anti");

    // Group by domain and look for genome patterns
    const domainPatterns = new Map<string, Map<string, number>>();
    for (const f of failures) {
      try {
        const payload = JSON.parse(f.payload) as { domain?: string; genome?: Record<string, unknown> };
        if (!payload.domain || !payload.genome) continue;
        const domKey = payload.domain;
        const domMap = domainPatterns.get(domKey) ?? new Map<string, number>();
        // Count gene-value pairs that appear in failures
        for (const [gene, value] of Object.entries(payload.genome)) {
          const patternKey = `${gene}:${String(value)}`;
          domMap.set(patternKey, (domMap.get(patternKey) ?? 0) + 1);
        }
        domainPatterns.set(domKey, domMap);
      } catch { /* non-fatal */ }
    }

    // Write structural rules for patterns appearing in 3+ failures
    let rulesWritten = 0;
    for (const [domain, patterns] of domainPatterns) {
      for (const [patternKey, count] of patterns) {
        if (count < 3) continue;
        const [gene, value] = patternKey.split(":") as [string, string];
        if (!gene || !value) continue;
        await ctx.db.upsertRule({
          domain,
          pattern: { gene, value, source: "failure-crystal" } as unknown as Record<string, unknown>,
          effect:  -0.3,
          sample_count: count,
        });
        rulesWritten++;
      }
    }
    logger.info({ rulesWritten }, "[Evolver] Failure crystal job complete");
  } catch (e) {
    logger.warn({ err: e }, "[Evolver] Failure crystal job threw");
  }
}

// ── Bottom-20% pattern analysis job ──────────────────────────────────────────
// Scheduled weekly from startEvolver.

interface AntiPattern {
  domain:  string;
  gene:    string;
  value:   unknown;
  badPct:  number;
  goodPct: number;
  support: number;
  effect:  number;
}

const _antiPatterns = new Map<string, AntiPattern[]>(); // domain → patterns

export function getAntiPatterns(domain: string): AntiPattern[] {
  return _antiPatterns.get(domain) ?? [];
}

export async function runAntiPatternJob(ctx: EvolverContext): Promise<void> {
  logger.info("[Evolver] Running bottom-20% anti-pattern analysis job");
  try {
    for (const domain of EVOLVER_DOMAINS) {
      const bottom = await ctx.db.getBottomPercentileGenomes(domain, 20, 10);
      const top    = await ctx.db.getTopPercentileGenomes(domain, 20, 10);
      if (bottom.length < 5) continue;

      // Count gene-value frequencies in bad vs good genomes
      const badFreq: Map<string, number>  = new Map();
      const goodFreq: Map<string, number> = new Map();

      for (const row of bottom) {
        for (const [gene, value] of Object.entries(row.genome as Record<string, unknown>)) {
          const k = `${gene}:${String(value)}`;
          badFreq.set(k, (badFreq.get(k) ?? 0) + 1);
        }
      }
      for (const row of top) {
        for (const [gene, value] of Object.entries(row.genome as Record<string, unknown>)) {
          const k = `${gene}:${String(value)}`;
          goodFreq.set(k, (goodFreq.get(k) ?? 0) + 1);
        }
      }

      const domainPatterns: AntiPattern[] = [];
      for (const [patternKey, badCount] of badFreq) {
        const badPct  = badCount / bottom.length;
        const goodCnt = goodFreq.get(patternKey) ?? 0;
        const goodPct = top.length > 0 ? goodCnt / top.length : 0;
        // Pattern: appears in >60% of bad, <30% of good
        if (badPct > 0.6 && goodPct < 0.3) {
          const [gene, value] = patternKey.split(":") as [string, string];
          if (!gene) continue;
          domainPatterns.push({ domain, gene, value, badPct, goodPct, support: badCount, effect: -0.15 });
          // Write soft structural rule
          await ctx.db.upsertRule({
            domain,
            pattern: { gene, value, source: "anti-pattern-job" } as unknown as Record<string, unknown>,
            effect:  -0.15,
            sample_count: badCount,
          });
        }
      }

      if (domainPatterns.length > 0) {
        _antiPatterns.set(domain, domainPatterns);
        logger.info({ domain, patterns: domainPatterns.length }, "[Evolver] Anti-pattern analysis: patterns written");
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "[Evolver] Anti-pattern job threw");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Multi-objective Fitness (Task #489 Phase E)
// Composite formula for champion selection: quality × token efficiency × completion.
// ═══════════════════════════════════════════════════════════════════════════

interface CompositeComponents {
  qualityScore:     number;
  tokenEfficiency:  number;
  completionRate:   number;
}

const _domainCompletionHistory = new Map<string, number[]>(); // last 10 gen completion rates

export function computeCompositeFitness(
  qualityScore:    number,
  tokensUsed:      number,
  domain:          string,
  completionRate?: number,
): { composite: number; components: CompositeComponents } {
  const maxTok         = domain === "coding" ? 400 : 200;
  const tokenEfficiency = Math.max(0, 1 - Math.min(tokensUsed, maxTok) / maxTok);
  const history         = _domainCompletionHistory.get(domain) ?? [];
  const rollingCompletion = history.length > 0
    ? history.reduce((s, v) => s + v, 0) / history.length
    : (completionRate ?? 0.5);
  const composite = Math.min(1,
    0.6 * (qualityScore / 100) +
    0.25 * tokenEfficiency +
    0.15 * rollingCompletion,
  );
  return { composite, components: { qualityScore, tokenEfficiency, completionRate: rollingCompletion } };
}

export function updateCompletionHistory(domain: string, completionRate: number): void {
  const hist = _domainCompletionHistory.get(domain) ?? [];
  hist.push(completionRate);
  if (hist.length > 10) hist.shift();
  _domainCompletionHistory.set(domain, hist);
}

// ── Token budget gate ─────────────────────────────────────────────────────────

let _evolverDailyTokenBudget = 50_000;

export function setEvolverDailyTokenBudget(budget: number): void {
  _evolverDailyTokenBudget = budget;
}

export function getEvolverDailyTokenBudget(): number {
  return _evolverDailyTokenBudget;
}

async function _isTokenBudgetExceeded(ctx: EvolverContext, avgTokensPerTask: number): Promise<boolean> {
  const avgTasksPerDay = 48; // rough estimate: ~2 tasks/hour × 24h
  const projected      = avgTokensPerTask * avgTasksPerDay;
  if (projected > _evolverDailyTokenBudget) {
    logger.warn({ projected, budget: _evolverDailyTokenBudget }, "[Evolver] Token budget gate: projected daily tokens exceed budget — blocking injection");
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Elite Crystal Stream (Task #489 Phase G, Step 24)
// Champion + runner-up benchmark results after each generation.
// Hard separation: ZomBrains task execution NEVER writes here.
// Rate cap: max 2 elite evaluations per domain per hour.
// ═══════════════════════════════════════════════════════════════════════════

const _eliteCrystalLastWrite = new Map<string, number>(); // domain → last write timestamp

export async function writeEliteCrystals(
  ctx:        EvolverContext,
  domain:     string,
  generation: number,
  results:    Array<{ genome: Genome; result: EvalResult }>,
): Promise<void> {
  if (results.length === 0) return;

  // Rate cap: max 2 per domain per hour (champion + runner-up = 2 writes max)
  const lastWrite = _eliteCrystalLastWrite.get(domain) ?? 0;
  void lastWrite; // suppress unused warning — used for domain-level tracking via countRecentEvolverCrystals
  const recentCount = await ctx.db.countRecentEvolverCrystals(domain, 60 * 60_000);
  if (recentCount >= 2) {
    logger.info({ domain, recentCount }, "[Evolver] Elite crystal rate cap reached — skipping");
    return;
  }

  // Use the first benchmark task text as context for the elite crystal record
  const firstTask = BENCHMARK_TASKS[0];
  const taskText  = firstTask ?? "";
  const toWrite  = results.slice(0, Math.max(1, 2 - recentCount)); // champion + optional runner-up

  for (let i = 0; i < toWrite.length; i++) {
    const item = toWrite[i];
    if (!item || item.result.fitness <= 0) continue;
    try {
      await ctx.db.insertEvolverCrystal({
        domain,
        generation,
        genome:        item.genome as unknown as Record<string, unknown>,
        quality_score: item.result.qualityScore,
        fitness:       item.result.fitness,
        task_text:     taskText,
        response_text: null,
        champion_rank: i + 1,
        source:        "elite",
      });
    } catch (e) {
      logger.warn({ err: e, domain }, "[Evolver] Failed to write elite crystal");
    }
  }
  _eliteCrystalLastWrite.set(domain, Date.now());
}

// ═══════════════════════════════════════════════════════════════════════════
// Cross-Stream Anomaly Detection (Task #489 Phase G, Step 25)
// Compares evolver_crystals (elite) vs session_crystals (ZomBrains production).
// Detects: both declining, only ZomBrains declining, only evolver declining.
// ═══════════════════════════════════════════════════════════════════════════

const _lastAnomalyAlertTime = new Map<string, number>(); // pattern → last alert ts
const ANOMALY_ALERT_COOLDOWN_MS = 6 * 60 * 60_000; // 6 hours per pattern

export async function runAnomalyDetection(ctx: EvolverContext): Promise<void> {
  try {
    const secret = process.env["ADMIN_SECRET"] ?? "";
    const port   = process.env["PORT"] ?? "5000";

    // Fetch last 3 session crystals (success type, average quality)
    let zbQuality: number | null = null;
    try {
      const r = await fetch(`http://localhost:${port}/api/zombrains/persist/session-crystals?limit=3&type=success`, {
        headers: { "x-admin-secret": secret },
        signal:  AbortSignal.timeout(5_000),
      });
      if (r.ok) {
        const data = await r.json() as { crystals?: Array<{ payload: string }> };
        const items = (data.crystals ?? []).map(c => {
          try { return (JSON.parse(c.payload) as { quality_score?: number }).quality_score ?? 0; } catch { return 0; }
        }).filter(q => q > 0);
        if (items.length >= 2) zbQuality = items.reduce((s, v) => s + v, 0) / items.length;
      }
    } catch { /* non-fatal */ }

    // Fetch last 3 elite crystals across all domains (average fitness × 100)
    let eliteQuality: number | null = null;
    try {
      const allElite: number[] = [];
      for (const domain of EVOLVER_DOMAINS) {
        const crystals = await ctx.db.getEvolverCrystals(domain, 1);
        for (const c of crystals) {
          if (c.fitness > 0) allElite.push(c.fitness * 100);
        }
      }
      if (allElite.length >= 2) eliteQuality = allElite.reduce((s, v) => s + v, 0) / allElite.length;
    } catch { /* non-fatal */ }

    if (zbQuality === null && eliteQuality === null) return;

    const now = Date.now();
    function _canAlert(pattern: string): boolean {
      const last = _lastAnomalyAlertTime.get(pattern) ?? 0;
      return now - last > ANOMALY_ALERT_COOLDOWN_MS;
    }
    function _markAlert(pattern: string): void {
      _lastAnomalyAlertTime.set(pattern, now);
    }

    const ZB_DECLINE_THRESHOLD    = 40; // quality score below which we consider "declining"
    const ELITE_DECLINE_THRESHOLD = 0.4; // fitness below which elite is "declining"

    const zbDecline    = zbQuality !== null && zbQuality < ZB_DECLINE_THRESHOLD;
    const eliteDecline = eliteQuality !== null && eliteQuality / 100 < ELITE_DECLINE_THRESHOLD;

    if (zbDecline && eliteDecline && _canAlert("both-declining")) {
      const msg = `🚨 **[Evolver] Provider-wide issue likely** — both elite evolver benchmarks and ZomBrains production quality are declining (ZB: ${zbQuality?.toFixed(1)}, Elite: ${eliteQuality?.toFixed(1)}). Check AI provider status.`;
      void ctx.writeDiscordDm(msg);
      void writeErrorLog({ route: "evolver", method: "anomaly", message: msg, source: "crystalline-evolver" });
      _markAlert("both-declining");
    } else if (zbDecline && !eliteDecline && _canAlert("zb-only-declining")) {
      const msg = `⚠️ **[Evolver] ZomBrains-specific issue** — elite benchmarks are healthy (${eliteQuality?.toFixed(1)}) but ZomBrains production quality is dropping (${zbQuality?.toFixed(1)}). Check Railway.`;
      void ctx.writeDiscordDm(msg);
      void writeErrorLog({ route: "evolver", method: "anomaly", message: msg, source: "crystalline-evolver" });
      _markAlert("zb-only-declining");
    } else if (!zbDecline && eliteDecline && _canAlert("elite-only-declining")) {
      const msg = `⚠️ **[Evolver] Evolver bug likely** — ZomBrains production is healthy but champion quality is dropping (Elite: ${eliteQuality?.toFixed(1)}). Check evolver loop.`;
      void ctx.writeDiscordDm(msg);
      void writeErrorLog({ route: "evolver", method: "anomaly", message: msg, source: "crystalline-evolver" });
      _markAlert("elite-only-declining");
    }
  } catch (e) {
    logger.warn({ err: e }, "[Evolver] Anomaly detection threw");
  }
}

// ── Evolver type status (for admin panel) ─────────────────────────────────────

export interface EvolverTypeStatus {
  name:                   string;
  level:                  1 | 2 | 3;
  lastInjectionAt:        number | null;
  circuitBreakerActive:   boolean;
  shadowGens:             number | null;
  pendingApprovalCount?:  number;
}

export function getEvolverTypeStatuses(db?: ScopedDb): EvolverTypeStatus[] {
  const statuses: EvolverTypeStatus[] = [];
  for (const [name, gt] of GENOME_TYPE_REGISTRY) {
    // Find most recent injection for this type across all domains
    let lastInj: number | null = null;
    for (const [k, ts] of _injectionLastTimestamp) {
      if (k.startsWith(`${name}:`)) {
        if (lastInj === null || ts > lastInj) lastInj = ts;
      }
    }
    statuses.push({
      name,
      level: gt.level,
      lastInjectionAt:      lastInj,
      circuitBreakerActive: _injectionCircuitBreaker,
      shadowGens:           null, // populated per-domain elsewhere
    });
  }
  // Also add domain-execution type
  statuses.push({
    name:                 "domain-execution",
    level:                1,
    lastInjectionAt:      null,
    circuitBreakerActive: _injectionCircuitBreaker,
    shadowGens:           null,
  });
  return statuses;
}

// ── Step 9: startEvolver ─────────────────────────────────────────────────
// ── Champion streak + crystallization cooldown persistence ────────────────────
// Persists _domainChampionStreak and _domainCrystallizationCooldown to the Railway
// Volume so gene-lock detection and crystallization cooldowns survive restarts.
const _STREAK_FILE = path.join(process.env["RAILWAY_VOLUME_MOUNT_PATH"] ?? "/data", "crystal-streak-state.json");
let _streakSavePending = false;
function _persistStreakState(): void {
  if (_streakSavePending) return;
  _streakSavePending = true;
  setImmediate(() => {
    _streakSavePending = false;
    try {
      fs.writeFileSync(_STREAK_FILE, JSON.stringify({
        streaks:   Object.fromEntries(_domainChampionStreak),
        cooldowns: Object.fromEntries(_domainCrystallizationCooldown),
        savedAt:   new Date().toISOString(),
      }));
    } catch (_) {}
  });
}
function _loadStreakState(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(_STREAK_FILE, "utf8")) as {
      streaks?: Record<string, number>;
      cooldowns?: Record<string, number>;
    };
    if (raw.streaks)   Object.entries(raw.streaks).forEach(([d, v]) => _domainChampionStreak.set(d, v));
    if (raw.cooldowns) Object.entries(raw.cooldowns).forEach(([d, v]) => _domainCrystallizationCooldown.set(d, v));
    logger.info({ domains: Object.keys(raw.streaks ?? {}) }, "[Evolver] Champion streak state restored from volume");
  } catch (_) {} // file not found or corrupt — start fresh
}

export function startEvolver(nodeId = "api-server", targetDomain?: EvolverDomain): void {
  assertBenchmarkIntegrity();
  _loadStreakState();

  const port = process.env["PORT"] ?? "5000";
  const auth = process.env["ADMIN_SECRET"] ?? "";
  const base = `http://localhost:${port}`;
  const hdrs: Record<string, string> = {
    "Content-Type":       "application/json",
    "x-admin-secret":     auth,
    "x-zombrains-secret": auth,
  };

  const scopedDb = createScopedDb(_db);

  const providers = new Map<Provider, RestrictedProvider>(
    PROVIDERS.map((p): [Provider, RestrictedProvider] => [
      p,
      {
        async call(prompt: string, genome: Genome) {
          const model = FULL_MODELS[p] ?? FULL_MODELS["groq"]!;
          return _rawCall(p, model, genome.temperature, Math.min(genome.maxTokens, 500), prompt, "");
        },
        available() {
          return getCooldownMs(PROVIDER_SLOT[p]) === 0 && !!process.env[PROVIDER_ENV[p]];
        },
      },
    ]),
  );

  const injectionCtx: InjectionCtx = {
    async setBotSetting(key: string, value: string) {
      try {
        await fetch(`${base}/api/zombrains/config/bot-setting`, {
          method:  "POST",
          headers: hdrs,
          body:    JSON.stringify({ key, value }),
          signal:  AbortSignal.timeout(8_000),
        });
      } catch (e) {
        logger.warn({ err: e, key }, "[Evolver] setBotSetting HTTP failed (non-fatal)");
      }
    },
    async getBotSetting(key: string) {
      try {
        const r = await fetch(`${base}/api/zombrains/config/bot-setting?key=${encodeURIComponent(key)}`, {
          headers: hdrs,
          signal:  AbortSignal.timeout(5_000),
        });
        if (!r.ok) return null;
        const j = await r.json() as { value?: string };
        return j.value ?? null;
      } catch { return null; }
    },
  };

  const ctx: EvolverContext = {
    providers,
    db: scopedDb,
    monitor: async () => {
      try {
        const r = await fetch(`${base}/api/zombrains/queue-status`, {
          headers: hdrs,
          signal:  AbortSignal.timeout(5_000),
        });
        if (!r.ok) return 0;
        const j = await r.json() as { active?: number; running?: number };
        return (j.active ?? 0) + (j.running ?? 0);
      } catch {
        return 0;
      }
    },
    champions: {
      async get(d: string) {
        const row = await scopedDb.getChampion(d);
        return row ? (row.genome as unknown as Genome) : null;
      },
      async set(d: string, genome: Genome, fitness: number, generation: number, runnerUpGenome?: Genome) {
        await scopedDb.upsertChampion({
          domain:           d,
          genome:           genome as unknown as Record<string, unknown>,
          fitness,
          generation,
          node:             nodeId,
          runner_up_genome: runnerUpGenome ? (runnerUpGenome as unknown as Record<string, unknown>) : null,
        });
      },
    },
    injection: injectionCtx,
    async writeDiscordDm(msg: string) {
      try {
        await fetch(`${base}/api/zombrains/discord/dm`, {
          method:  "POST",
          headers: hdrs,
          body:    JSON.stringify({ message: msg }),
          signal:  AbortSignal.timeout(8_000),
        });
      } catch (e) {
        logger.warn({ err: e }, "[Evolver] writeDiscordDm failed (non-fatal)");
      }
    },
    async getRecentSessionQuality(limit: number) {
      try {
        const r = await fetch(`${base}/api/zombrains/persist/session-crystals?limit=${limit}&type=success`, {
          headers: hdrs,
          signal:  AbortSignal.timeout(8_000),
        });
        if (!r.ok) return null;
        const data = await r.json() as { crystals?: Array<{ payload: string }> };
        const scores = (data.crystals ?? []).map(c => {
          try { return (JSON.parse(c.payload) as { quality_score?: number }).quality_score ?? 0; } catch { return 0; }
        }).filter(q => q > 0);
        if (scores.length < 2) return null;
        return scores.reduce((s, v) => s + v, 0) / scores.length;
      } catch { return null; }
    },
  };

  // Task #479 Steps 4+5: startup migrations — run fully async, never block boot
  setImmediate(async () => {
    try {
      // Step 4: repair poisoned coding champion (fitness < 0.5 or node='test')
      await scopedDb.repairCodingChampion();

      // Step 5: one-shot truncate of ephemeral evolver data after scoring v2 rollout.
      // Guard: 'evolver_scoring_v2' config snapshot exists → already ran, skip.
      // Not present → DELETE evolver_population + evolver_generations, then record completion.
      // This is deterministic and idempotent regardless of stored fitness values.
      const alreadyMigrated = await scopedDb.getLatestConfigSnapshot("evolver_scoring_v2");
      if (!alreadyMigrated) {
        logger.warn("[Evolver #479] First deploy with scoring v2 — clearing ephemeral evolver data (population + generations)");
        await scopedDb.clearEvolverLearningData();
        await scopedDb.insertConfigSnapshot({
          type:   "evolver_scoring_v2",
          config: { migratedAt: new Date().toISOString() },
        });
        logger.info("[Evolver #479] Scoring v2 migration complete — evolver will start fresh");
      }

      // Benchmark v3: depth gate + tighter length thresholds added.
      // Old fitness values (scored under the easier rules) are not comparable;
      // clear ephemeral data so the evolver re-benchmarks cleanly.
      const alreadyMigratedV3 = await scopedDb.getLatestConfigSnapshot("evolver_benchmark_v3");
      if (!alreadyMigratedV3) {
        logger.warn("[Evolver] Benchmark v3 scoring active — clearing ephemeral evolver data (depth gate + length threshold upgrade)");
        await scopedDb.clearEvolverLearningData();
        await scopedDb.insertConfigSnapshot({
          type:   "evolver_benchmark_v3",
          config: { migratedAt: new Date().toISOString() },
        });
        logger.info("[Evolver] Benchmark v3 migration complete — evolver starts fresh under new scoring rules");
      }
    } catch (e) {
      logger.warn({ err: e }, "[Evolver #479] Startup migration failed (non-fatal)");
    }
  });

  // Fully off the synchronous boot path — health check is never blocked
  setImmediate(() => {
    runCoordinatorLoop(ctx, nodeId, targetDomain).catch(err => {
      logger.error({ err }, "[Evolver] runCoordinatorLoop crashed — evolver stopped");
    });
  });

  // Task #489: nightly failure crystal job (24h interval)
  const NIGHTLY_MS = 24 * 60 * 60_000;
  setTimeout(function scheduleFailureCrystal() {
    runFailureCrystalJob(ctx).catch(e => logger.warn({ err: e }, "[Evolver] nightly failure crystal job threw"));
    setTimeout(scheduleFailureCrystal, NIGHTLY_MS);
  }, NIGHTLY_MS);

  // Task #489: weekly anti-pattern job (7d interval)
  const WEEKLY_MS = 7 * 24 * 60 * 60_000;
  setTimeout(function scheduleAntiPattern() {
    runAntiPatternJob(ctx).catch(e => logger.warn({ err: e }, "[Evolver] weekly anti-pattern job threw"));
    setTimeout(scheduleAntiPattern, WEEKLY_MS);
  }, WEEKLY_MS);
}

// ── Island settings API (steps 13-14) ─────────────────────────────────────────
/** Update the cached island mode and threshold. Called by the POST /crystalline/island-settings route. */
export function setIslandSettings(mode: string, threshold: number): void {
  _islandMode      = mode;
  _islandThreshold = Math.max(0, Math.min(1, threshold));
}

/** Return the currently cached island mode + threshold. */
export function getIslandSettings(): { mode: string; threshold: number } {
  return { mode: _islandMode, threshold: _islandThreshold };
}

/** Set the Railway benchmark flag. Called by the cluster-flags PATCH route. */
export function setRailwayBenchmarkFlag(enabled: boolean): void {
  _railwayBenchmarkEnabled = enabled;
}

/** Return the current Railway benchmark flag value. */
export function getRailwayBenchmarkEnabled(): boolean {
  return _railwayBenchmarkEnabled;
}

/** Return the last 50 immigration events for a given domain (or all domains if omitted). */
export function getImmigrationLog(domain?: string): Record<string, ImmigrationEvent[]> {
  if (domain) {
    return { [domain]: _immigrationLog.get(domain) ?? [] };
  }
  const result: Record<string, ImmigrationEvent[]> = {};
  for (const [d, events] of _immigrationLog) {
    result[d] = events;
  }
  return result;
}

/** Return current island-mode stats per domain for the admin panel. */
export function getIslandModeStats(): {
  mode: string;
  threshold: number;
  pausedDomains: Record<string, number>;
  poorDonors: Record<string, Record<string, number>>;
  donorStreaks: Record<string, { last: string | null; streak: number }>;
  geneLockStreaks: Record<string, number>;
  providerDowngrades: Record<string, string[]>;
} {
  const pausedDomains: Record<string, number> = {};
  for (const [d, rem] of _domainImmigrationPause) {
    if (rem > 0) pausedDomains[d] = rem;
  }
  const poorDonors: Record<string, Record<string, number>> = {};
  for (const [d, map] of _poorDonorDomains) {
    if (map.size > 0) {
      poorDonors[d] = Object.fromEntries(map);
    }
  }
  const donorStreaks: Record<string, { last: string | null; streak: number }> = {};
  for (const [d, streak] of _domainDonorStreak) {
    donorStreaks[d] = { last: _domainLastDonor.get(d) ?? null, streak };
  }
  const geneLockStreaks: Record<string, number> = {};
  for (const [d, streak] of _domainChampionStreak) {
    if (streak > 0) geneLockStreaks[d] = streak;
  }
  const providerDowngrades: Record<string, string[]> = {};
  for (const [d, set] of _providerDowngrades) {
    if (set.size > 0) providerDowngrades[d] = [...set];
  }
  return {
    mode:      _islandMode,
    threshold: _islandThreshold,
    pausedDomains,
    poorDonors,
    donorStreaks,
    geneLockStreaks,
    providerDowngrades,
  };
}
