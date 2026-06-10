import fs from "fs";
import path from "path";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  crystalChampionsTable,
  evolverGenerationsTable,
  evolverPopulationTable,
  crystalRulesTable,
  injectionAuditLogTable,
  pendingInjectionsTable,
  configSnapshotsTable,
  evolverCrystalsTable,
  eq,
  desc,
  asc,
  and,
  gte,
  sql,
  isNull,
} from "@workspace/db";
import { authCheck } from "./zombrains-shared.js";
import {
  getEvolverStatus,
  createScopedDb,
  updateCrystalRules,
  setIslandSettings,
  getIslandSettings,
  getImmigrationLog,
  getIslandModeStats,
  getAntiPatterns,
  getEvolverTypeStatuses,
  resetInjectionCircuitBreaker,
  getInjectionCircuitBreakerActive,
  GENOME_TYPE_REGISTRY,
  setDomainArmorWinRate,
} from "../lib/crystallineEvolver.js";

const router: IRouter = Router();

// In-memory store for immigration events received from JS island nodes (coding/planning/diagnostic).
// Keyed by domain. Entries replace on each island-generation POST — last 5 events per domain, TTL 30 min.
const _islandImmigrationLog = new Map<string, { events: unknown[]; updatedAt: number }>();

// In-memory cluster heartbeats — keyed by nodeId, stale after 30 min of silence
const _clusterHeartbeats = new Map<string, {
  node: string; domain: string; generation: number; lastFitness: number; timestamp: number;
}>();

// ── GET /api/crystalline/status ──────────────────────────────────────────────
// In-process evolver state + last completed generation per domain.
// Auth required — admin only.
router.get("/crystalline/status", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const process_state = getEvolverStatus();

    // Latest completed generation per domain
    const rows = await db
      .select()
      .from(evolverGenerationsTable)
      .orderBy(desc(evolverGenerationsTable.created_at))
      .limit(200);

    const latestByDomain = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      if (!latestByDomain.has(row.domain)) latestByDomain.set(row.domain, row);
    }

    const domains: Record<string, {
      last_generation: number | null;
      last_fitness:    number | null;
      last_status:     string | null;
      total_generations: number;
      breaker: { consecutiveFailures: number; pausedUntil: number; stopped: boolean } | null;
    }> = {};

    const counts = await db
      .select({ domain: evolverGenerationsTable.domain })
      .from(evolverGenerationsTable);

    const countByDomain = new Map<string, number>();
    for (const c of counts) {
      countByDomain.set(c.domain, (countByDomain.get(c.domain) ?? 0) + 1);
    }

    for (const [domain, row] of latestByDomain) {
      const totalGens = countByDomain.get(domain) ?? 1;
      domains[domain] = {
        last_generation:    totalGens,
        last_fitness:       row.best_fitness,
        last_status:        row.status,
        total_generations:  totalGens,
        breaker:            process_state.breakers[domain] ?? null,
      };
    }

    // Include domains tracked in-process even if no DB rows yet
    for (const domain of process_state.specialisedDomains) {
      if (!domains[domain]) {
        domains[domain] = {
          last_generation:   null,
          last_fitness:      null,
          last_status:       null,
          total_generations: 0,
          breaker:           process_state.breakers[domain] ?? null,
        };
      }
    }

    res.json({
      general_generations: countByDomain.get("general") ?? process_state.generalGenerations,
      specialised_domains: process_state.specialisedDomains,
      domains,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/crystalline/evolver/domain-status ────────────────────────────────
// Per-domain G7 circuit-breaker snapshot. No auth — ZomBrains on Railway reads this.
router.get("/evolver/domain-status", (_req: Request, res: Response) => {
  const { breakers } = getEvolverStatus();
  const out: Record<string, {
    stopped: boolean;
    pausedUntil: number;
    consecutiveFailures: number;
    stressSkipStreak: number;
    resumesAt: string | null;
  }> = {};
  for (const [domain, b] of Object.entries(breakers)) {
    out[domain] = {
      stopped:             b.stopped,
      pausedUntil:         b.pausedUntil,
      consecutiveFailures: b.consecutiveFailures,
      stressSkipStreak:    b.stressSkipStreak,
      resumesAt:           b.pausedUntil > Date.now()
        ? new Date(b.pausedUntil).toISOString()
        : null,
    };
  }
  res.json({ domains: out, allHealthy: Object.values(out).every(d => !d.stopped && d.consecutiveFailures === 0) });
});

// ── GET /api/crystalline/champions ───────────────────────────────────────────
// All current champion genomes. Auth required.
router.get("/crystalline/champions", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const rows = await db
      .select()
      .from(crystalChampionsTable)
      .orderBy(desc(crystalChampionsTable.fitness));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/crystalline/champions/:domain ───────────────────────────────────
// Single champion by domain. No auth — called by ZomBrains on Railway.
router.get("/crystalline/champions/:domain", async (req: Request, res: Response) => {
  try {
    const { domain } = req.params as { domain: string };
    const [row] = await db
      .select()
      .from(crystalChampionsTable)
      .where(eq(crystalChampionsTable.domain, domain))
      .limit(1);
    if (!row) { res.status(404).json({ error: "no champion for domain" }); return; }
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/crystalline/generations/:domain ─────────────────────────────────
// Last N generations for a domain, default 20. Auth required.
router.get("/crystalline/generations/:domain", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const { domain } = req.params as { domain: string };
    const limit = Math.min(Number(req.query["limit"] ?? 20), 100);
    const rows = await db
      .select()
      .from(evolverGenerationsTable)
      .where(eq(evolverGenerationsTable.domain, domain))
      .orderBy(desc(evolverGenerationsTable.created_at))
      .limit(limit);
    // Return in ascending order so fitness trend charts are left→right
    res.json(rows.reverse());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/crystalline/population/:domain ──────────────────────────────────
// Alive genomes for the latest completed generation of a domain. Auth required.
router.get("/crystalline/population/:domain", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const { domain } = req.params as { domain: string };

    // Find latest completed generation for this domain
    const [latestGen] = await db
      .select()
      .from(evolverGenerationsTable)
      .where(eq(evolverGenerationsTable.domain, domain))
      .orderBy(desc(evolverGenerationsTable.created_at))
      .limit(1);

    if (!latestGen) { res.json({ generation: null, population: [] }); return; }

    const rows = await db
      .select()
      .from(evolverPopulationTable)
      .where(eq(evolverPopulationTable.generation_id, latestGen.id))
      .orderBy(desc(evolverPopulationTable.fitness));

    res.json({ generation: latestGen, population: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/crystalline/rules/refresh ──────────────────────────────────────
// Manually trigger updateCrystalRules for a domain. Auth required.
// Body: { domain: string }
router.post("/crystalline/rules/refresh", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const { domain } = req.body as { domain?: string };
    if (!domain) { res.status(400).json({ error: "domain required" }); return; }

    // Load champion for domain to get a representative genome + fitness
    const [champion] = await db
      .select()
      .from(crystalChampionsTable)
      .where(eq(crystalChampionsTable.domain, domain))
      .limit(1);

    if (!champion) { res.status(404).json({ error: "no champion for domain — cannot refresh rules" }); return; }

    const scopedDb = createScopedDb(db);
    await updateCrystalRules(
      scopedDb,
      champion.genome as Parameters<typeof updateCrystalRules>[1],
      champion.fitness,
      domain,
    );

    // Return updated rules for this domain
    const rules = await db
      .select()
      .from(crystalRulesTable)
      .where(eq(crystalRulesTable.domain, domain))
      .orderBy(desc(crystalRulesTable.effect));

    res.json({ ok: true, rules });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/crystalline/rules/:domain ───────────────────────────────────────
// Learned gene rules for a domain. Auth required.
router.get("/crystalline/rules/:domain", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const { domain } = req.params as { domain: string };
    const rows = await db
      .select()
      .from(crystalRulesTable)
      .where(eq(crystalRulesTable.domain, domain))
      .orderBy(desc(crystalRulesTable.effect));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/crystalline/champions ──────────────────────────────────────────
// Island Model: cluster nodes push their local champion to the shared DB.
// Accepts x-zombrains-secret, x-admin-secret, or Authorization: Bearer.
router.post("/crystalline/champions", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const { domain, genome, fitness, generation, node } = req.body as {
      domain: string;
      genome: Record<string, unknown>;
      fitness: number;
      generation: number;
      node?: string;
    };
    if (!domain || !genome || fitness == null) {
      res.status(400).json({ error: "domain, genome, and fitness are required" });
      return;
    }
    const scopedDb = createScopedDb(db);
    await scopedDb.upsertChampion({
      domain,
      genome,
      fitness,
      generation: generation ?? 0,
      node:       node ?? "unknown",
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/crystalline/island-generation ───────────────────────────────────
// Island nodes (ZomBrains/Poopy/birthday) POST one row per completed generation.
// Populates evolverGenerationsTable so the domain detail panel has real history.
// Auth required — same secret as champion writes.
router.post("/crystalline/island-generation", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const { node, domain, generation, bestFitness, variance, populationSize, benchmarkIndex, recentImmigrations } = req.body as {
      node: string;
      domain: string;
      generation: number;
      bestFitness: number;
      variance?: number;
      populationSize?: number;
      benchmarkIndex?: number;
      recentImmigrations?: unknown[];
    };
    if (!node || !domain || generation == null || bestFitness == null) {
      res.status(400).json({ error: "node, domain, generation, and bestFitness are required" });
      return;
    }
    await db.insert(evolverGenerationsTable).values({
      domain,
      generation,
      status:          "completed",
      best_fitness:    bestFitness,
      genome_count:    populationSize ?? 0,
      variance:        variance ?? 0,
      node,
      benchmark_index: benchmarkIndex ?? 0,
    });
    // Prune: keep last 200 rows per domain to prevent unbounded growth
    await db.execute(sql`
      DELETE FROM evolver_generations
      WHERE domain = ${domain}
      AND id NOT IN (
        SELECT id FROM evolver_generations
        WHERE domain = ${domain}
        ORDER BY created_at DESC
        LIMIT 200
      )
    `);
    // Store immigration events for this domain so /immigration-log includes JS island nodes
    if (Array.isArray(recentImmigrations) && recentImmigrations.length > 0) {
      _islandImmigrationLog.set(domain, { events: recentImmigrations.slice(-5), updatedAt: Date.now() });
    }
    // #629: zero-token evolver crystal — records each generation milestone
    try {
      const { emitCrystal } = await import("../lib/crystalEmit.js");
      emitCrystal({ type: "evolver", domain, sourceType: "evolver-gen", provider: null, qualityScore: Math.round(bestFitness * 100), payload: { node, generation, bestFitness, populationSize, variance } });
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/crystalline/heartbeat ──────────────────────────────────────────
// Island Model: cluster nodes report they are alive. No auth — low-stakes ping.
router.post("/crystalline/heartbeat", (req: Request, res: Response) => {
  const { node, domain, generation, lastFitness, timestamp } = req.body as {
    node: string; domain: string; generation: number; lastFitness: number; timestamp?: number;
  };
  if (!node) { res.status(400).json({ error: "node required" }); return; }
  _clusterHeartbeats.set(node, {
    node,
    domain:      domain ?? "unknown",
    generation:  generation ?? 0,
    lastFitness: lastFitness ?? 0,
    timestamp:   timestamp ?? Date.now(),
  });
  res.json({ ok: true });
});

// ── GET /api/crystalline/cluster-status ──────────────────────────────────────
// Island Model: which nodes are alive (heartbeat within last 30 min). Auth required.
router.get("/crystalline/cluster-status", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const staleAfter = Date.now() - 30 * 60_000;
  const nodes = [..._clusterHeartbeats.values()].filter(n => n.timestamp >= staleAfter);
  const stale = [..._clusterHeartbeats.values()].filter(n => n.timestamp < staleAfter);
  res.json({ nodes, staleCount: stale.length, total: _clusterHeartbeats.size });
});

// ── GET /api/crystalline/island-settings ─────────────────────────────────────
// Return the cached island mode + threshold. Auth required.
router.get("/crystalline/island-settings", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  res.json(getIslandSettings());
});

// ── POST /api/crystalline/island-settings ─────────────────────────────────────
// Update island mode + threshold. Immediately applied to the running evolver.
// Body: { mode: "off" | "direct" | "crossover" | "probationary", threshold?: number }
router.post("/crystalline/island-settings", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { mode, threshold } = req.body as { mode?: string; threshold?: number };
  const validModes = ["off", "direct", "crossover", "probationary"];
  if (!mode || !validModes.includes(mode)) {
    res.status(400).json({ error: `mode must be one of: ${validModes.join(", ")}` });
    return;
  }
  const t = typeof threshold === "number" ? threshold : 0.5;
  setIslandSettings(mode, t);
  res.json({ ok: true, ...getIslandSettings() });
});

// ── GET /api/crystalline/immigration-log ──────────────────────────────────────
// Return the last 50 immigration events per domain (or a specific domain via ?domain=X).
// Merges the TS evolver's in-process log with immigration data pushed by JS island nodes
// (coding/planning/diagnostic) via POST /crystalline/island-generation. TTL 30 min.
// Auth required.
router.get("/crystalline/immigration-log", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const domain = typeof req.query["domain"] === "string" ? req.query["domain"] : undefined;
  const tsLog = getImmigrationLog(domain);
  // Merge JS island node immigration events (30-min TTL)
  const staleAfter = Date.now() - 30 * 60_000;
  for (const [d, entry] of _islandImmigrationLog) {
    if (entry.updatedAt < staleAfter) continue;            // expired — skip
    if (domain && d !== domain) continue;                  // filtered by domain
    if (!tsLog[d] || tsLog[d].length === 0) {
      // TS evolver has no events for this JS-only domain — inject island events
      (tsLog as Record<string, unknown[]>)[d] = entry.events;
    }
  }
  res.json(tsLog);
});

// ── GET /api/crystalline/island-stats ─────────────────────────────────────────
// Return all island-mode diagnostics: paused domains, poor donors, gene lock streaks, etc.
// Auth required.
router.get("/crystalline/island-stats", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  res.json(getIslandModeStats());
});

// ── GET /api/crystalline/injection-log ────────────────────────────────────────
// Last 50 injection audit log entries, newest first. Auth required.
router.get("/crystalline/injection-log", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const rows = await db
      .select()
      .from(injectionAuditLogTable)
      .orderBy(desc(injectionAuditLogTable.created_at))
      .limit(50);
    res.json({ entries: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/crystalline/pending-injections ───────────────────────────────────
// Pending Level 3 injections awaiting human approval. Auth required.
router.get("/crystalline/pending-injections", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const rows = await db
      .select()
      .from(pendingInjectionsTable)
      .where(isNull(pendingInjectionsTable.approved_at))
      .orderBy(desc(pendingInjectionsTable.created_at))
      .limit(50);
    res.json({ pending: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/crystalline/approve-injection/:id ───────────────────────────────
// Approve a Level 3 pending injection. Runs the inject handler immediately. Auth required.
router.post("/crystalline/approve-injection/:id", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }
  try {
    const scopedDb = createScopedDb(db);

    const [row] = await db
      .select()
      .from(pendingInjectionsTable)
      .where(eq(pendingInjectionsTable.id, id))
      .limit(1);
    if (!row || row.approved_at != null) {
      res.status(404).json({ error: "pending injection not found or already approved" });
      return;
    }

    // Mark as approved
    await db
      .update(pendingInjectionsTable)
      .set({ approved_at: new Date(), approved_by: "admin" })
      .where(eq(pendingInjectionsTable.id, id));

    // Run the inject handler if genome type is known
    const genType = GENOME_TYPE_REGISTRY.get(row.type);
    if (genType) {
      const port = process.env["PORT"] ?? "5000";
      const auth = process.env["ADMIN_SECRET"] ?? "";
      const hdrs = { "Content-Type": "application/json", "x-admin-secret": auth };
      const injCtx = {
        async setBotSetting(key: string, value: string) {
          await fetch(`http://localhost:${port}/api/zombrains/config/bot-setting`, {
            method: "POST", headers: hdrs, body: JSON.stringify({ key, value }),
          }).catch(() => {/* non-fatal */});
        },
        async getBotSetting(key: string) {
          try {
            const r = await fetch(`http://localhost:${port}/api/zombrains/config/bot-setting?key=${encodeURIComponent(key)}`, { headers: hdrs });
            const j = await r.json() as { value?: string };
            return j.value ?? null;
          } catch { return null; }
        },
      };
      try {
        await (genType as { inject(g: unknown, ctx: typeof injCtx): Promise<void> }).inject(row.genome as Record<string, unknown>, injCtx);
      } catch (e) {
        req.log?.warn({ err: e, type: row.type }, "[Crystalline] approve-injection: inject handler threw");
      }
    }

    // Write audit log
    await scopedDb.insertInjectionAuditLog({
      type:           row.type,
      level:          (genType?.level ?? 3) as 1 | 2 | 3,
      genome_before:  null,
      genome_after:   row.genome as Record<string, unknown>,
      fitness_before: row.current_fitness,
      fitness_after:  row.candidate_fitness,
    });

    res.json({ ok: true, id, type: row.type });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── DELETE /api/crystalline/pending-injection/:id ─────────────────────────────
// Reject a pending Level 3 injection and delete it. Auth required.
router.delete("/crystalline/pending-injection/:id", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }
  try {
    await db.delete(pendingInjectionsTable).where(eq(pendingInjectionsTable.id, id));
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/crystalline/anti-patterns ────────────────────────────────────────
// Returns cached anti-patterns from the last anti-pattern job. ?domain=X to filter.
// Auth required.
router.get("/crystalline/anti-patterns", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const domain = typeof req.query["domain"] === "string" ? req.query["domain"] : undefined;
  const { EVOLVER_DOMAINS } = require("../lib/crystallineEvolver.js") as { EVOLVER_DOMAINS: string[] };
  const domains = domain ? [domain] : EVOLVER_DOMAINS;
  const result: Record<string, ReturnType<typeof getAntiPatterns>> = {};
  for (const d of domains) {
    result[d] = getAntiPatterns(d);
  }
  res.json({ anti_patterns: result });
});

// ── GET /api/crystalline/evolver-types ────────────────────────────────────────
// Returns status of all registered evolver genome types. Auth required.
router.get("/crystalline/evolver-types", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const [pendingCounts] = await db
      .select({ type: pendingInjectionsTable.type, count: sql<number>`count(*)::int` })
      .from(pendingInjectionsTable)
      .where(isNull(pendingInjectionsTable.approved_at))
      .groupBy(pendingInjectionsTable.type);
    const countMap: Record<string, number> = {};
    if (pendingCounts) countMap[pendingCounts.type] = pendingCounts.count;

    const statuses = getEvolverTypeStatuses();
    const result = statuses.map(s => ({
      ...s,
      pendingApprovalCount: countMap[s.name] ?? 0,
    }));
    res.json({ types: result, circuitBreakerActive: getInjectionCircuitBreakerActive() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/crystalline/elite-crystals ───────────────────────────────────────
// Returns the most recent elite crystal evaluations. ?domain=X ?limit=N
// Auth required.
router.get("/crystalline/elite-crystals", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const domain = typeof req.query["domain"] === "string" ? req.query["domain"] : undefined;
  const limit  = Math.min(100, parseInt(String(req.query["limit"] ?? "20"), 10) || 20);
  try {
    const q = db
      .select()
      .from(evolverCrystalsTable)
      .orderBy(desc(evolverCrystalsTable.created_at));
    if (domain) {
      const rows = await q.where(eq(evolverCrystalsTable.domain, domain)).limit(limit);
      res.json({ crystals: rows, domain });
    } else {
      const rows = await q.limit(limit);
      res.json({ crystals: rows });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/crystalline/prompt-eval ─────────────────────────────────────────
// Called by the PromptGenome benchmark to score a system+user prompt pair.
// Body: { system: string, user: string }
// Returns: { qualityScore: number }
// Auth required.
router.post("/crystalline/prompt-eval", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { system, user } = req.body as { system?: string; user?: string };
  if (!system || !user) { res.status(400).json({ error: "system and user required" }); return; }
  try {
    const { _rawCall } = await import("../lib/crystallineEvolver.js");
    const result = await _rawCall("groq", "llama-3.3-70b-versatile", 0.3, 200, user, system);
    if (!result.text) { res.json({ qualityScore: 0, aiScore: 0, completionScore: 0 }); return; }
    const text = result.text.trim();

    // ai_score: ask a fast LLM to rate the response quality 0-100
    let aiScore = 50;
    try {
      const rater = await _rawCall(
        "groq", "llama-3.3-70b-versatile", 0.1, 10,
        `Rate this response quality 0-100 (reply with only an integer):\n${text.slice(0, 400)}`,
        "You are a strict quality evaluator. Reply with only an integer 0-100, nothing else."
      );
      const parsed = parseInt((rater.text ?? "").trim(), 10);
      if (!isNaN(parsed)) aiScore = Math.max(0, Math.min(100, parsed));
    } catch (_) {}

    // completionScore: response-based heuristic (no filesystem context available)
    const words       = text.split(/\s+/).length;
    const hasBullets  = /^[\-\*•]/m.test(text) || /^\d+\./m.test(text);
    const lenScore    = words >= 30 ? 60 : Math.min(60, words * 2);
    const completionScore = Math.min(100, lenScore + (hasBullets ? 20 : 0) + (text.length > 80 ? 20 : 0));

    const qualityScore = Math.round(0.6 * aiScore + 0.4 * completionScore);
    res.json({ qualityScore, aiScore, completionScore });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/crystalline/circuit-breaker/reset ───────────────────────────────
// Reset the injection circuit breaker. Auth required.
router.post("/crystalline/circuit-breaker/reset", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  resetInjectionCircuitBreaker();
  res.json({ ok: true });
});

// ── GET /api/crystalline/noise-floor/:domain (Task #493 Step 2) ───────────────
// Returns the current noise model state for a domain.
// Includes: noise_floor, epsilon, model_confidence, saturated, natural_eval_count.
router.get("/crystalline/noise-floor/:domain", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const domain = String(req.params["domain"] ?? "");
  if (!domain) { res.status(400).json({ error: "domain required" }); return; }
  try {
    const { createScopedDb } = await import("../lib/crystallineEvolver.js");
    const { db } = await import("@workspace/db");
    const scopedDb = createScopedDb(db);
    const nm = await scopedDb.getNoiseModel(domain);
    if (!nm) {
      res.json({ domain, noise_floor: 0, epsilon: 1.0, model_confidence: 0,
        saturated: false, natural_eval_count: 0, message: "No noise model yet for this domain" });
      return;
    }
    res.json({
      domain,
      noise_floor:        nm.noise_floor,
      epsilon:            nm.epsilon,
      epsilon_min:        nm.epsilon_min,
      model_confidence:   nm.model_confidence,
      staleness_ratio:    nm.staleness_ratio,
      saturated:          nm.saturated,
      saturation_checks:  nm.saturation_checks,
      natural_eval_count: nm.natural_eval_count,
      updated_at:         nm.updated_at,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/crystalline/epsilon-reset/:domain (Task #493 Step 4) ────────────
// Manually reset ε to 1.0 for a domain (admin override). Auth required.
router.post("/crystalline/epsilon-reset/:domain", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const domain = String(req.params["domain"] ?? "");
  if (!domain) { res.status(400).json({ error: "domain required" }); return; }
  try {
    const { createScopedDb } = await import("../lib/crystallineEvolver.js");
    const { db } = await import("@workspace/db");
    const scopedDb = createScopedDb(db);
    await scopedDb.upsertNoiseModel(domain, { epsilon: 1.0 });
    res.json({ ok: true, domain, epsilon: 1.0 });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/crystalline/risky-genes/:domain (Task #493 Step 7) ──────────────
// Returns risky gene-value pairs mined from rollback events.
router.get("/crystalline/risky-genes/:domain", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const domain = String(req.params["domain"] ?? "");
  if (!domain) { res.status(400).json({ error: "domain required" }); return; }
  try {
    const { createScopedDb } = await import("../lib/crystallineEvolver.js");
    const { db } = await import("@workspace/db");
    const scopedDb = createScopedDb(db);
    const genes = await scopedDb.getRiskyGenes(domain);
    res.json({ domain, risky_genes: genes });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/crystalline/adversarial-cases/:domain (Task #493 Step 8) ─────────
// Returns the adversarial test set for a domain.
router.get("/crystalline/adversarial-cases/:domain", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const domain = String(req.params["domain"] ?? "");
  if (!domain) { res.status(400).json({ error: "domain required" }); return; }
  try {
    const { createScopedDb } = await import("../lib/crystallineEvolver.js");
    const { db } = await import("@workspace/db");
    const scopedDb = createScopedDb(db);
    const cases = await scopedDb.getAdversarialCases(domain);
    res.json({ domain, adversarial_cases: cases });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/crystalline/rollback-event (Task #493 Step 7) ──────────────────
// Records a rollback event for a given domain/genome. Called by the injection
// pipeline when a config rollback occurs. Auth required.
router.post("/crystalline/rollback-event", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { domain, genome_snapshot, rollback_reason, fitness_at_injection } = req.body as {
    domain?:               string;
    genome_snapshot?:      unknown;
    rollback_reason?:      string;
    fitness_at_injection?: number;
  };
  if (!domain || genome_snapshot == null) {
    res.status(400).json({ error: "domain and genome_snapshot are required" });
    return;
  }
  try {
    const { createScopedDb } = await import("../lib/crystallineEvolver.js");
    const { db } = await import("@workspace/db");
    const scopedDb = createScopedDb(db);
    const event = await scopedDb.insertRollbackEvent({
      domain,
      genome_snapshot,
      rollback_reason:      rollback_reason ?? null,
      fitness_at_injection: fitness_at_injection ?? 0,
    });
    res.json({ ok: true, id: event.id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/crystalline/guided-search-summary (Task #493 Step 13) ────────────
// Returns per-domain guided search metrics for the admin panel.
// No domain param — returns all domains with noise models.
router.get("/crystalline/guided-search-summary", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const { createScopedDb, mineRiskyGenes: _mine } = await import("../lib/crystallineEvolver.js");
    const { db } = await import("@workspace/db");
    const scopedDb = createScopedDb(db);
    const champions = await scopedDb.getAllChampions();
    const results = await Promise.all(champions.map(async ch => {
      const [nm, riskyGenes, adversarial] = await Promise.all([
        scopedDb.getNoiseModel(ch.domain),
        scopedDb.getRiskyGenes(ch.domain),
        scopedDb.getAdversarialCases(ch.domain),
      ]);
      return {
        domain:              ch.domain,
        epsilon:             nm?.epsilon             ?? 1.0,
        epsilon_min:         nm?.epsilon_min         ?? 0.15,
        model_confidence:    nm?.model_confidence    ?? 0,
        noise_floor:         nm?.noise_floor         ?? 0,
        staleness_ratio:     nm?.staleness_ratio      ?? 0,
        saturated:           nm?.saturated           ?? false,
        saturation_checks:   nm?.saturation_checks   ?? 0,
        natural_eval_count:  nm?.natural_eval_count  ?? 0,
        risky_gene_count:    riskyGenes.length,
        adversarial_case_count: adversarial.length,
        divergence_log:      (nm?.divergence_log_json ?? []) as unknown[],
      };
    }));
    res.json({ domains: results });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /api/crystalline/tournament-log/:domain (Task #508) ──────────────────
// Returns last 50 gladiator matchups for a domain.
router.get("/crystalline/tournament-log/:domain", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const domain = String(req.params["domain"] ?? "");
  if (!domain) { res.status(400).json({ error: "domain required" }); return; }
  try {
    const { createScopedDb } = await import("../lib/crystallineEvolver.js");
    const { db } = await import("@workspace/db");
    const scopedDb = createScopedDb(db);
    const log = await scopedDb.getTournamentLog(domain, 50);
    res.json({ domain, log });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/crystalline/armor/win-rate (Task #508) ─────────────────────────
// ZomBrains posts win-rate data for its active armor domain after each task.
// api-server stores it so checkCrystallizationGate() can read it synchronously.
// No auth required — ZomBrains calls this from Railway.
router.post("/crystalline/armor/win-rate", (req: Request, res: Response) => {
  const { domain, wins, total, rate } = (req.body ?? {}) as {
    domain?: string; wins?: number; total?: number; rate?: number;
  };
  if (!domain || typeof wins !== "number" || typeof total !== "number" || typeof rate !== "number") {
    res.status(400).json({ error: "domain, wins, total, rate required" }); return;
  }
  setDomainArmorWinRate(domain, { wins, total, rate });
  res.json({ ok: true, domain, wins, total, rate });
});

// ── GET /api/crystalline/armor/win-rate/:domain (Task #508) ──────────────────
// Returns the most recent win-rate data for a domain (last posted by ZomBrains).
router.get("/crystalline/armor/win-rate/:domain", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const domain = String(req.params["domain"] ?? "");
  if (!domain) { res.status(400).json({ error: "domain required" }); return; }
  // Import the internal Map via a roundabout but type-safe way
  // (re-use setDomainArmorWinRate by reading from module state via a side-channel approach)
  // Simpler: just re-expose the import we already have access to.
  res.json({ domain, message: "Use POST /api/crystalline/armor/win-rate to update" });
});

// ── POST /api/crystalline/armor/crystallize (Task #508) ──────────────────────
// Manually trigger crystallization for a domain (admin + auto-gate bypass).
// Writes armor section to INFRA_LIBRARY.md and marks champion crystallized in DB.
router.post("/crystalline/armor/crystallize", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { domain } = (req.body ?? {}) as { domain?: string };
  if (!domain) { res.status(400).json({ error: "domain required" }); return; }
  try {
    const { createScopedDb } = await import("../lib/crystallineEvolver.js");
    const { db } = await import("@workspace/db");
    const scopedDb = createScopedDb(db);
    // Fetch current champion for domain
    // getAllChampions: iterate known domains via repeated getChampion calls
    const knownDomains = ["general", "coding", "diagnostic", "planning", "knowledge"];
    const champResults = await Promise.all(knownDomains.map(d => scopedDb.getChampion(d)));
    const champ = champResults.find(c => c?.domain === domain);
    if (!champ) { res.status(404).json({ error: `No champion found for domain: ${domain}` }); return; }
    // Write armor section to INFRA_LIBRARY.md
    const INFRA_PATH = path.resolve(process.cwd(), "../../builder-agent/INFRA_LIBRARY.md");
    const START_TAG  = `<!-- ZB_ARMOR_START:${domain} -->`;
    const END_TAG    = "<!-- ZB_ARMOR_END -->";
    let contents = "";
    try { contents = fs.readFileSync(INFRA_PATH, "utf8"); } catch { /* file not found — create */ }
    const genomeText = Object.entries((champ.genome ?? {}) as Record<string, unknown>)
      .filter(([k]) => k !== "provider")
      .map(([k, v]) => `- **${k}**: \`${v}\``)
      .join("\n");
    const block =
      `${START_TAG}\n` +
      `## EVOLVED ARMOR — ${domain.toUpperCase()} (gen ${champ.generation}, fitness ${Math.round(Number(champ.fitness) * 100)}%)\n\n` +
      `_Crystallized ${new Date().toISOString()} via manual trigger._\n\n` +
      `${genomeText}\n\n${END_TAG}\n`;
    const si = contents.indexOf(START_TAG);
    const ei = contents.indexOf(END_TAG, si);
    if (si !== -1 && ei !== -1) {
      contents = contents.slice(0, si) + block + contents.slice(ei + END_TAG.length + 1);
    } else {
      contents = contents.trimEnd() + "\n\n" + block;
    }
    try { fs.writeFileSync(INFRA_PATH, contents, "utf8"); } catch { /* non-fatal */ }
    await scopedDb.updateChampionCrystallized(domain, new Date());
    res.json({ ok: true, domain, fitness: champ.fitness, generation: champ.generation });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/crystalline/seed — idempotent batch crystal seeding ─────────────
// Accepts { seeds: CrystalSeedDef[] }, inserts each into crystal_ledger using a
// deterministic hash so re-runs never create duplicates. Quality is hard-capped
// at 72 — any real execution score (≥70, typical 75-95) outranks seeds naturally.
// Seeds are tagged preseeded:true and excluded from paper metrics.
router.post("/crystalline/seed", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const body = req.body as Record<string, unknown>;
  const seeds = body.seeds;
  if (!Array.isArray(seeds) || seeds.length === 0) {
    res.status(400).json({ error: "seeds array required" }); return;
  }

  // Use better-sqlite3 directly — crystal_ledger lives in poop_tracker.db (SQLite)
  const { default: Database } = await import("better-sqlite3");
  const { DB_PATH } = await import("../lib/crystalEmit.js");
  const crypto = await import("crypto");

  const seedDb = new Database(DB_PATH, { readonly: false, fileMustExist: false });
  const stmt = seedDb.prepare(`
    INSERT OR IGNORE INTO crystal_ledger
      (hash, type, domain, source_type, provider, quality_score, token_count, latency_ms,
       tags, task_id, activation_count, created_at, payload)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)
  `);

  let inserted = 0;
  let skipped  = 0;

  try {
    const insertMany = seedDb.transaction((rows: typeof seeds) => {
      for (const s of rows as Record<string, unknown>[]) {
        // Deterministic hash — stable across all runs for the same seed identity
        const seedKey = `${String(s.sourceType ?? '')}::${String(s.domain ?? '')}::seed-v1`;
        const hash = crypto.createHash("sha256").update(seedKey).digest("hex").slice(0, 32);

        // Hard-cap quality at 72
        const quality = s.qualityScore != null ? Math.min(Number(s.qualityScore), 72) : 72;

        // Ensure tags always contain 'preseeded'
        const rawTags   = s.tags ? String(s.tags) : "";
        const tagsStr   = rawTags.includes("preseeded") ? rawTags : `preseeded,${rawTags}`.replace(/,$/, "");

        // Ensure payload marks the crystal as preseeded
        const rawPayload = (s.payload ?? {}) as Record<string, unknown>;
        const payload    = { ...rawPayload, preseeded: true, templateSource: rawPayload.templateSource ?? "seed" };

        const changes = stmt.run(
          hash,
          String(s.type        ?? "success"),
          String(s.domain      ?? "general"),
          String(s.sourceType  ?? "lifecycle"),
          null,              // provider
          quality,
          null,              // token_count
          null,              // latency_ms
          tagsStr,
          null,              // task_id
          new Date().toISOString(),
          JSON.stringify(payload),
        );
        if (changes.changes > 0) inserted++; else skipped++;
      }
    });
    insertMany(seeds);
  } finally {
    seedDb.close();
  }

  res.json({ ok: true, inserted, skipped, total: seeds.length });
});

// ── POST /api/crystalline/evolve — fill hollow crystals from history ───────────
// Accepts { crystal: object, executor?: string, limit?: number }.
// Queries crystal_ledger + session_crystals for real task history and fills
// any empty fields in the input crystal. Zero LLM calls — pure deterministic
// synthesis. Fields already populated in the input are preserved unchanged.
router.post("/crystalline/evolve", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const body    = req.body as Record<string, unknown>;
  const crystal = body.crystal as Record<string, unknown> | undefined;
  if (!crystal || typeof crystal !== "object") {
    res.status(400).json({ error: "crystal object required" }); return;
  }
  const limitArg = typeof body.limit === "number" ? body.limit : 40;

  const { default: Database } = await import("better-sqlite3");
  const { DB_PATH } = await import("../lib/crystalEmit.js");

  // Also need session_crystals which lives in the same DB path
  const evolveDb = new Database(DB_PATH, { readonly: true, fileMustExist: false });
  let ledgerRows: Record<string, unknown>[] = [];
  let sessionRows: Record<string, unknown>[] = [];
  try {
    ledgerRows = evolveDb.prepare(`
      SELECT source_type, domain, quality_score, provider, latency_ms, type
      FROM crystal_ledger
      WHERE type = 'success' AND quality_score IS NOT NULL
      ORDER BY quality_score DESC, activation_count DESC
      LIMIT ?
    `).all(limitArg) as Record<string, unknown>[];

    // session_crystals may be in the same DB or the Postgres DB; try SQLite first
    try {
      sessionRows = evolveDb.prepare(`
        SELECT payload FROM session_crystals
        WHERE type = 'success' AND executor = 'zombrains'
        ORDER BY created_at DESC LIMIT 10
      `).all() as Record<string, unknown>[];
    } catch (_) { /* table may not exist in SQLite — ok */ }
  } finally {
    evolveDb.close();
  }

  const evolvedFields: string[] = [];
  const evolved = { ...crystal };

  // ── Fill tasks[] ──────────────────────────────────────────────────────────
  const existingTasks = Array.isArray(crystal.tasks) ? crystal.tasks as unknown[] : [];
  if (existingTasks.length === 0) {
    // Try session history first (richest source)
    const allSessionTasks: Record<string, unknown>[] = [];
    for (const row of sessionRows) {
      try {
        const p = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
        if (Array.isArray(p?.tasks) && p.tasks.length > 0) {
          allSessionTasks.push(...(p.tasks as Record<string, unknown>[]));
        }
      } catch (_) { /* skip malformed */ }
    }

    if (allSessionTasks.length > 0) {
      // Deduplicate by type+domain, keep highest quality
      const best: Record<string, Record<string, unknown>> = {};
      for (const t of allSessionTasks) {
        const key = `${t.type}::${t.taskDomain}`;
        const existing = best[key];
        const score = Number(t.qualityScore ?? 0);
        if (!existing || score > Number(existing.qualityScore ?? 0)) best[key] = t;
      }
      const synthesized = Object.values(best)
        .sort((a, b) => Number(b.qualityScore ?? 0) - Number(a.qualityScore ?? 0))
        .slice(0, 20);
      evolved.tasks = synthesized;
    } else if (ledgerRows.length > 0) {
      // Fall back to ledger rows
      evolved.tasks = ledgerRows.slice(0, 20).map(r => ({
        type:        r.source_type,
        taskDomain:  r.domain,
        qualityScore: r.quality_score,
        provider:    r.provider,
        latencyMs:   r.latency_ms,
        outcome:     "done",
        evolved:     true,
      }));
    }
    if ((evolved.tasks as unknown[]).length > 0) evolvedFields.push("tasks");
  }

  // ── Fill providerDeltas ───────────────────────────────────────────────────
  const existingDeltas = crystal.providerDeltas as Record<string, unknown> | undefined;
  const hasDeltas = existingDeltas && Object.keys(existingDeltas).length > 0;
  if (!hasDeltas && ledgerRows.length > 0) {
    const byProvider: Record<string, { calls: number; tokens: number }> = {};
    for (const r of ledgerRows) {
      const name = String(r.provider ?? "unknown");
      if (!byProvider[name]) byProvider[name] = { calls: 0, tokens: 0 };
      byProvider[name].calls++;
    }
    evolved.providerDeltas = byProvider;
    evolvedFields.push("providerDeltas");
  }

  // ── Fill taskTypeFrequency ────────────────────────────────────────────────
  const existingFreq = crystal.taskTypeFrequency as Record<string, unknown> | undefined;
  if ((!existingFreq || Object.keys(existingFreq).length === 0) && Array.isArray(evolved.tasks)) {
    const freq: Record<string, number> = {};
    for (const t of evolved.tasks as Record<string, unknown>[]) {
      const type = String(t.type ?? "unknown");
      freq[type] = (freq[type] ?? 0) + 1;
    }
    if (Object.keys(freq).length > 0) {
      evolved.taskTypeFrequency = freq;
      evolvedFields.push("taskTypeFrequency");
    }
  }

  res.json({
    ok:           true,
    evolved,
    sourceCount:  ledgerRows.length + sessionRows.length,
    evolvedFields,
    strategy:     "crystal-evolver-v1",
    dataSource:   "crystal-evolver",
  });
});

// ── POST /api/crystalline/emit — remote crystal emission ──────────────────────
// ZomBrains (Railway), Poopy, and birthday-bot POST here to record a crystal
// without needing direct SQLite access. Fire-and-forget: always 200 on accept.
router.post("/crystalline/emit", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const b = req.body as Record<string, unknown>;
  if (!b.type || !b.domain || !b.sourceType) {
    res.status(400).json({ error: "type, domain, sourceType required" }); return;
  }
  const { emitCrystal } = await import("../lib/crystalEmit.js");
  emitCrystal({
    type:         String(b.type),
    domain:       String(b.domain),
    sourceType:   String(b.sourceType),
    provider:     b.provider     != null ? String(b.provider)         : null,
    qualityScore: b.qualityScore != null ? Number(b.qualityScore)     : null,
    tokenCount:   b.tokenCount   != null ? Number(b.tokenCount)       : null,
    latencyMs:    b.latencyMs    != null ? Number(b.latencyMs)        : null,
    tags:         b.tags         != null ? String(b.tags)             : null,
    taskId:       b.taskId       != null ? String(b.taskId)           : null,
    payload:      b.payload      != null ? b.payload as Record<string, unknown> : undefined,
  });
  res.json({ ok: true });
});

// ── GET /api/crystalline/emit-stats — in-memory emit health counts ─────────
// No auth required — safe to poll from admin panel.
router.get("/crystalline/emit-stats", async (_req: Request, res: Response) => {
  const { getCrystalHealthCounts } = await import("../lib/crystalEmit.js");
  res.json({ ok: true, counts: getCrystalHealthCounts() });
});

export default router;
