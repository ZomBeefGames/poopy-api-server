import { Router, type Request, type Response } from "express";
import { getDb, authCheck } from "./zombrains-shared.js";
import { getEvolverStatus, resetEvolverDomain, EVOLVER_DOMAINS } from "../lib/crystallineEvolver.js";

const router = Router();

// ── Tier derivation ───────────────────────────────────────────────────────────
function deriveTier(score: number): { tier: number; tier_label: string } {
  if (score >= 0.95) return { tier: 5, tier_label: "T5:FUSED" };
  if (score >= 0.80) return { tier: 4, tier_label: "T4:BOUND" };
  if (score >= 0.60) return { tier: 3, tier_label: "T3:ESTABLISHED" };
  if (score >= 0.30) return { tier: 2, tier_label: "T2:FORMING" };
  return               { tier: 1, tier_label: "T1:OBSERVED" };
}

function sigScore(count: number, k = 10): number {
  return count / (count + k);
}

// ── Pattern refresh ───────────────────────────────────────────────────────────
let _patternRefreshTimer: ReturnType<typeof setInterval> | null = null;
const PATTERN_TTL_MS = 6 * 60 * 60 * 1000;

function refreshCrystalPatterns(): void {
  const db = getDb();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PATTERN_TTL_MS).toISOString();
  const patterns: { id: string; pattern_type: string; domain: string | null; confidence: number; sample_size: number; pattern_data: string }[] = [];

  try {
    // 1. Provider performance per domain
    const perfRows = db.prepare(`
      SELECT provider, domain, AVG(quality_score) as avg_quality, COUNT(*) as cnt, AVG(latency_ms) as avg_latency
      FROM crystal_ledger WHERE type='success' AND provider IS NOT NULL AND quality_score IS NOT NULL
      GROUP BY provider, domain ORDER BY avg_quality DESC
    `).all() as { provider: string; domain: string; avg_quality: number; cnt: number; avg_latency: number }[];

    const byDomain = new Map<string, typeof perfRows>();
    for (const r of perfRows) {
      const d = r.domain || "general";
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d)!.push(r);
    }
    for (const [domain, rows] of byDomain) {
      const n = rows.reduce((s, r) => s + r.cnt, 0);
      patterns.push({ id: `provider_performance:${domain}`, pattern_type: "provider_performance", domain, confidence: Math.min(1, n / 50), sample_size: n, pattern_data: JSON.stringify(rows) });
    }

    // 2. Tool co-occurrence success
    const toolRows = db.prepare(`
      SELECT tools_used, AVG(quality_score) as avg_quality, COUNT(*) as cnt
      FROM crystal_ledger WHERE type='success' AND quality_score >= 70 AND tools_used IS NOT NULL
      GROUP BY tools_used ORDER BY avg_quality DESC LIMIT 20
    `).all() as { tools_used: string; avg_quality: number; cnt: number }[];
    if (toolRows.length > 0) {
      const n = toolRows.reduce((s, r) => s + r.cnt, 0);
      patterns.push({ id: "tool_cooccurrence:global", pattern_type: "tool_cooccurrence", domain: null, confidence: Math.min(1, n / 100), sample_size: n,
        pattern_data: JSON.stringify(toolRows.map(r => ({ ...r, tools: (() => { try { return JSON.parse(r.tools_used); } catch { return [r.tools_used]; } })() }))) });
    }

    // 3. Failure cluster detection
    const clusterRows = db.prepare(`
      SELECT hash_a, hash_b, co_activation_count, tier FROM crystal_combinations
      WHERE process='error-clustering' AND tier >= 2 ORDER BY co_activation_count DESC LIMIT 20
    `).all() as { hash_a: string; hash_b: string; co_activation_count: number; tier: number }[];
    if (clusterRows.length > 0) {
      patterns.push({ id: "failure_clusters:global", pattern_type: "failure_clusters", domain: null, confidence: Math.min(1, clusterRows.length / 10), sample_size: clusterRows.length, pattern_data: JSON.stringify(clusterRows) });
    }

    // 4. Domain bridge patterns
    const bridgeRows = db.prepare(`
      SELECT domain_a, domain_b, AVG(score) as avg_score, COUNT(*) as cnt
      FROM crystal_combinations WHERE cross_domain=1 AND process='immigration'
      GROUP BY domain_a, domain_b ORDER BY avg_score DESC LIMIT 10
    `).all() as { domain_a: string; domain_b: string; avg_score: number; cnt: number }[];
    if (bridgeRows.length > 0) {
      const n = bridgeRows.reduce((s, r) => s + r.cnt, 0);
      patterns.push({ id: "domain_bridges:global", pattern_type: "domain_bridges", domain: null, confidence: Math.min(1, n / 20), sample_size: n, pattern_data: JSON.stringify(bridgeRows) });
    }

    // 5. Quality trend (7-day rolling)
    const trendRows = db.prepare(`
      SELECT DATE(created_at) as day, domain, AVG(quality_score) as avg_quality, COUNT(*) as cnt
      FROM crystal_ledger WHERE type='success' AND quality_score IS NOT NULL AND created_at >= datetime('now','-7 days')
      GROUP BY DATE(created_at), domain ORDER BY day, domain
    `).all() as { day: string; domain: string; avg_quality: number; cnt: number }[];
    if (trendRows.length > 0) {
      const n = trendRows.reduce((s, r) => s + r.cnt, 0);
      patterns.push({ id: "quality_trend:7d", pattern_type: "quality_trend", domain: null, confidence: Math.min(1, n / 50), sample_size: n, pattern_data: JSON.stringify(trendRows) });
    }

    // 6. Entanglement health
    const entRows = db.prepare(`
      SELECT tier, tier_label, COUNT(*) as cnt, AVG(co_activation_count) as avg_count
      FROM crystal_combinations GROUP BY tier ORDER BY tier DESC
    `).all() as { tier: number; tier_label: string; cnt: number; avg_count: number }[];
    if (entRows.length > 0) {
      const n = entRows.reduce((s, r) => s + r.cnt, 0);
      patterns.push({ id: "entanglement_health:global", pattern_type: "entanglement_health", domain: null, confidence: 1, sample_size: n, pattern_data: JSON.stringify(entRows) });
    }

    const upsert = db.prepare(`INSERT OR REPLACE INTO crystal_patterns (id, pattern_type, domain, confidence, sample_size, pattern_data, computed_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`);
    const runAll = db.transaction(() => { for (const p of patterns) upsert.run(p.id, p.pattern_type, p.domain, p.confidence, p.sample_size, p.pattern_data, now, expiresAt); });
    runAll();
    console.log(`[crystals] Pattern refresh: ${patterns.length} patterns computed`);
  } catch (e) {
    console.warn("[crystals] Pattern refresh failed (non-fatal):", e);
  } finally {
    db.close();
  }
}

export function schedulePatternRefresh(): void {
  try {
    const db = getDb();
    const { c: stale } = db.prepare("SELECT COUNT(*) as c FROM crystal_patterns WHERE datetime(expires_at) < datetime('now')").get() as { c: number };
    const { c: total } = db.prepare("SELECT COUNT(*) as c FROM crystal_patterns").get() as { c: number };
    db.close();
    if (stale > 0 || total === 0) setTimeout(refreshCrystalPatterns, 2000);
  } catch { setTimeout(refreshCrystalPatterns, 2000); }
  if (_patternRefreshTimer) clearInterval(_patternRefreshTimer);
  _patternRefreshTimer = setInterval(refreshCrystalPatterns, PATTERN_TTL_MS);
}

// ── Relevance score refresh (Task #621) ───────────────────────────────────────
// Updates crystal_ledger.relevance_score for all rows using the composite formula.
// Runs every 4h. Uses pure SQL so it's one round-trip with no row-by-row JS.
let _relevanceTimer: ReturnType<typeof setInterval> | null = null;
const RELEVANCE_TTL_MS = 4 * 60 * 60 * 1000;

export function refreshRelevanceScores(): void {
  const db = getDb();
  try {
    // Standard crystal formula:
    //   0.35 × quality/100
    //   0.30 × sig(activation, 20)
    //   0.20 × entanglementTierMax/5
    //   0.15 × exp(-daysSinceLastActivation / 30)
    // Nightmare override: quality×0 → activation weight→0.65
    // Codex override: entanglement weight→0.40
    db.exec(`
      UPDATE crystal_ledger SET relevance_score =
        CASE
          WHEN type = 'nightmare' THEN
            (CAST(COALESCE(activation_count,0) AS REAL) / (COALESCE(activation_count,0) + 20.0)) * 0.65
            + (COALESCE(entanglement_tier_max,0) / 5.0) * 0.20
            + EXP(-(JULIANDAY('now') - JULIANDAY(COALESCE(last_activated, created_at))) / 30.0) * 0.15
          WHEN type LIKE 'codex%' THEN
            (COALESCE(quality_score,0) / 100.0) * 0.35
            + (CAST(COALESCE(activation_count,0) AS REAL) / (COALESCE(activation_count,0) + 20.0)) * 0.25
            + (COALESCE(entanglement_tier_max,0) / 5.0) * 0.40
          ELSE
            (COALESCE(quality_score,0) / 100.0) * 0.35
            + (CAST(COALESCE(activation_count,0) AS REAL) / (COALESCE(activation_count,0) + 20.0)) * 0.30
            + (COALESCE(entanglement_tier_max,0) / 5.0) * 0.20
            + EXP(-(JULIANDAY('now') - JULIANDAY(COALESCE(last_activated, created_at))) / 30.0) * 0.15
        END
    `);
    console.log("[crystals] Relevance scores refreshed");
  } catch (e) {
    console.warn("[crystals] Relevance refresh failed (non-fatal):", e);
  } finally {
    db.close();
  }
}

export function scheduleRelevanceRefresh(): void {
  setTimeout(refreshRelevanceScores, 5000); // 5s after boot
  if (_relevanceTimer) clearInterval(_relevanceTimer);
  _relevanceTimer = setInterval(refreshRelevanceScores, RELEVANCE_TTL_MS);
}

// ── Crystal decay (Task #621) ─────────────────────────────────────────────────
// Daily: T1–T4 combination pairs not activated in 30+ days → count × 0.90.
// T5 (tier=5) is immune. Pairs that decay to count=0 are pruned.
// Writes tier_decayed events for pairs that drop a tier.
let _decayTimer: ReturnType<typeof setInterval> | null = null;
const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function runCrystalDecay(): void {
  const db = getDb();
  try {
    const now = new Date().toISOString();
    type DecayRow = { hash_a: string; hash_b: string; co_activation_count: number; tier: number };
    const stale = db.prepare(`
      SELECT hash_a, hash_b, co_activation_count, tier FROM crystal_combinations
      WHERE datetime(last_seen) < datetime('now', '-30 days') AND tier < 5
    `).all() as DecayRow[];

    if (stale.length === 0) { db.close(); return; }

    const update = db.prepare("UPDATE crystal_combinations SET co_activation_count=?, score=?, tier=?, tier_label=?, last_seen=? WHERE hash_a=? AND hash_b=?");
    const del    = db.prepare("DELETE FROM crystal_combinations WHERE hash_a=? AND hash_b=?");
    const event  = db.prepare("INSERT INTO crystal_events (event_type, crystal_hash, related_hash, tier_before, tier_after, event_data, timestamp) VALUES (?,?,?,?,?,?,?)");

    let decayed = 0, pruned = 0;
    const runDecay = db.transaction(() => {
      for (const row of stale) {
        const newCount = Math.floor(row.co_activation_count * 0.90);
        if (newCount <= 0) {
          del.run(row.hash_a, row.hash_b);
          pruned++;
        } else {
          const score = sigScore(newCount);
          const { tier, tier_label } = deriveTier(score);
          update.run(newCount, score, tier, tier_label, now, row.hash_a, row.hash_b);
          if (tier < row.tier) {
            event.run("tier_decayed", row.hash_a, row.hash_b, row.tier, tier, JSON.stringify({ reason: "decay", newCount }), now);
          }
          decayed++;
        }
      }
    });
    runDecay();
    console.log(`[crystals] Decay: ${decayed} pairs decayed, ${pruned} pruned`);
    db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('crystal_decay_last_run',?)").run(now);
  } catch (e) {
    console.warn("[crystals] Decay failed (non-fatal):", e);
  } finally {
    db.close();
  }
}

export function scheduleCrystalDecay(): void {
  // Run on boot only if it hasn't run today
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM zombrains_settings WHERE key='crystal_decay_last_run'").get() as { value: string } | undefined;
    db.close();
    if (!row?.value || new Date(row.value).toDateString() !== new Date().toDateString()) {
      setTimeout(runCrystalDecay, 10000); // 10s after boot
    }
  } catch { setTimeout(runCrystalDecay, 10000); }
  if (_decayTimer) clearInterval(_decayTimer);
  _decayTimer = setInterval(runCrystalDecay, DECAY_INTERVAL_MS);
}

// ── Manual trigger endpoints ───────────────────────────────────────────────────
router.post("/zombrains/crystals/decay/run", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try { runCrystalDecay(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: String(e) }); }
});

router.post("/zombrains/crystals/relevance/refresh", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try { refreshRelevanceScores(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Backfill: session_crystals → crystal_ledger (one-time, guarded) ───────────
export function runCrystalLedgerBackfill(): void {
  const db = getDb();
  try {
    const done = db.prepare("SELECT value FROM zombrains_settings WHERE key='crystal_ledger_backfill_done'").get() as { value: string } | undefined;
    if (done?.value === "1") { db.close(); return; }

    type SessionRow = { id: number; executor: string; timestamp: string; content_hash: string; type: string; payload: string; created_at: string };
    const rows = db.prepare("SELECT id, executor, timestamp, content_hash, type, payload, created_at FROM session_crystals ORDER BY id ASC").all() as SessionRow[];
    if (rows.length === 0) {
      db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('crystal_ledger_backfill_done','1')").run();
      db.close(); return;
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO crystal_ledger (hash, type, domain, source_type, provider, quality_score, token_count, latency_ms, tools_used, persona, task_id, tags, activation_count, created_at, payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
    `);
    const incr = db.prepare(`UPDATE crystal_ledger SET activation_count = activation_count + 1, last_activated = ? WHERE hash = ?`);
    const event = db.prepare(`INSERT INTO crystal_events (event_type, crystal_hash, event_data, timestamp) VALUES ('created',?,?,?)`);

    let inserted = 0;
    const runBackfill = db.transaction(() => {
      for (const row of rows) {
        let p: Record<string, unknown> = {};
        try { p = typeof row.payload === "string" ? JSON.parse(row.payload) as Record<string, unknown> : row.payload; } catch { /* keep empty */ }

        const hash = row.content_hash;
        const type = (row.type || p["type"] as string || "success");
        const domain = (p["domain"] as string | null) ?? null;
        const sourceType = (p["source_type"] as string | null) ?? "legacy";
        const provider = (p["provider"] as string | null) ?? null;
        const qualityScore = typeof p["quality_score"] === "number" ? p["quality_score"] : null;
        const tokenCount = typeof p["token_count"] === "number" ? p["token_count"] : null;
        const latencyMs = typeof p["latency_ms"] === "number" ? p["latency_ms"] : null;
        const toolsUsed = p["tools_used"] ? JSON.stringify(p["tools_used"]) : null;
        const persona = (p["persona"] as string | null) ?? null;
        const taskId = (p["task_id"] as string | null) ?? null;
        const tags = JSON.stringify(["legacy"]);
        const payloadStr = typeof row.payload === "string" ? row.payload : JSON.stringify(p);
        const createdAt = row.created_at || row.timestamp;

        const info = insert.run(hash, type, domain, sourceType, provider, qualityScore, tokenCount, latencyMs, toolsUsed, persona, taskId, tags, createdAt, payloadStr);
        if ((info as { changes: number }).changes > 0) {
          event.run(hash, JSON.stringify({ source: "backfill", executor: row.executor }), createdAt);
          inserted++;
        } else {
          incr.run(createdAt, hash);
        }
      }
    });
    runBackfill();
    db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('crystal_ledger_backfill_done','1')").run();
    console.log(`[crystals] Backfill: ${inserted} crystals seeded from session_crystals (${rows.length} total rows)`);
  } catch (e) {
    console.warn("[crystals] Backfill failed (non-fatal):", e);
  } finally {
    db.close();
  }
}

// ── POST /zombrains/crystals/ledger — ingest a crystal ───────────────────────
router.post("/zombrains/crystals/ledger", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const body = req.body as Record<string, unknown>;
  const hash = body["hash"] as string | undefined;
  if (!hash || typeof hash !== "string") { res.status(400).json({ error: "hash required" }); return; }

  const db = getDb();
  try {
    const now = new Date().toISOString();
    const type = (body["type"] as string) || "success";
    const domain = (body["domain"] as string | null) ?? null;
    const sourceType = (body["source_type"] as string | null) ?? null;
    const provider = (body["provider"] as string | null) ?? null;
    const qualityScore = typeof body["quality_score"] === "number" ? body["quality_score"] : null;
    const tokenCount = typeof body["token_count"] === "number" ? body["token_count"] : null;
    const latencyMs = typeof body["latency_ms"] === "number" ? body["latency_ms"] : null;
    const toolsUsed = body["tools_used"] ? JSON.stringify(body["tools_used"]) : null;
    const persona = (body["persona"] as string | null) ?? null;
    const taskId = (body["task_id"] as string | null) ?? null;
    const tags = JSON.stringify(Array.isArray(body["tags"]) ? body["tags"] : []);
    const payloadStr = body["payload"] ? (typeof body["payload"] === "string" ? body["payload"] : JSON.stringify(body["payload"])) : JSON.stringify(body);

    const existing = db.prepare("SELECT hash, quality_score, tags, tools_used, persona, provider, domain, source_type, token_count, latency_ms, activation_count FROM crystal_ledger WHERE hash = ?").get(hash) as Record<string, unknown> | undefined;

    if (!existing) {
      db.prepare(`
        INSERT INTO crystal_ledger (hash, type, domain, source_type, provider, quality_score, token_count, latency_ms, tools_used, persona, task_id, tags, activation_count, created_at, payload)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
      `).run(hash, type, domain, sourceType, provider, qualityScore, tokenCount, latencyMs, toolsUsed, persona, taskId, tags, now, payloadStr);
      db.prepare("INSERT INTO crystal_events (event_type, crystal_hash, event_data, timestamp) VALUES ('created',?,?,?)").run(hash, JSON.stringify({ type, domain, provider, quality_score: qualityScore }), now);
      res.json({ ok: true, action: "created" });
    } else {
      const newCount = ((existing["activation_count"] as number) || 0) + 1;
      db.prepare("UPDATE crystal_ledger SET activation_count = ?, last_activated = ? WHERE hash = ?").run(newCount, now, hash);

      // Diff for reencounter_delta event
      const fields: Record<string, unknown> = { quality_score: qualityScore, tags, tools_used: toolsUsed, persona, provider, domain, source_type: sourceType, token_count: tokenCount, latency_ms: latencyMs };
      const delta: Record<string, { first: unknown; now: unknown }> = {};
      for (const [k, v] of Object.entries(fields)) {
        const first = existing[k];
        if (String(first) !== String(v)) delta[k] = { first, now: v };
      }
      if (Object.keys(delta).length > 0) {
        db.prepare("INSERT INTO crystal_events (event_type, crystal_hash, event_data, timestamp) VALUES ('reencounter_delta',?,?,?)").run(hash, JSON.stringify({ activation_count: newCount, delta }), now);
      } else {
        db.prepare("INSERT INTO crystal_events (event_type, crystal_hash, event_data, timestamp) VALUES ('activated',?,?,?)").run(hash, JSON.stringify({ activation_count: newCount }), now);
      }
      res.json({ ok: true, action: "reencountered", activation_count: newCount, has_delta: Object.keys(delta).length > 0 });
    }
  } finally { db.close(); }
});

// ── POST /zombrains/crystals/combination — record co-activation ───────────────
router.post("/zombrains/crystals/combination", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const body = req.body as Record<string, unknown>;
  const rawA = body["hash_a"] as string | undefined;
  const rawB = body["hash_b"] as string | undefined;
  if (!rawA || !rawB || rawA === rawB) { res.status(400).json({ error: "hash_a and hash_b required and must differ" }); return; }

  const [hash_a, hash_b] = rawA < rawB ? [rawA, rawB] : [rawB, rawA];
  const process = (body["process"] as string) || "session";
  const domain = (body["domain"] as string | null) ?? null;
  const domain_a = (body["domain_a"] as string | null) ?? domain;
  const domain_b = (body["domain_b"] as string | null) ?? domain;
  const cross_domain = domain_a && domain_b && domain_a !== domain_b ? 1 : 0;
  const lastContext = body["context"] ? JSON.stringify(body["context"]) : null;

  const db = getDb();
  try {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT co_activation_count, tier FROM crystal_combinations WHERE hash_a = ? AND hash_b = ?").get(hash_a, hash_b) as { co_activation_count: number; tier: number } | undefined;

    if (!existing) {
      const score = sigScore(1);
      const { tier, tier_label } = deriveTier(score);
      db.prepare(`
        INSERT INTO crystal_combinations (hash_a, hash_b, co_activation_count, score, tier, tier_label, process, domain_a, domain_b, cross_domain, first_seen, last_seen, last_context)
        VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?)
      `).run(hash_a, hash_b, score, tier, tier_label, process, domain_a, domain_b, cross_domain, now, now, lastContext);
      db.prepare("INSERT INTO crystal_events (event_type, crystal_hash, related_hash, tier_before, tier_after, event_data, timestamp) VALUES ('entangled',?,?,null,?,?,?)").run(hash_a, hash_b, tier, JSON.stringify({ process, domain_a, domain_b }), now);
      // update entanglement_count on both ledger rows
      db.prepare("UPDATE crystal_ledger SET entanglement_count = entanglement_count + 1, entanglement_tier_max = MAX(entanglement_tier_max, ?) WHERE hash = ?").run(tier, hash_a);
      db.prepare("UPDATE crystal_ledger SET entanglement_count = entanglement_count + 1, entanglement_tier_max = MAX(entanglement_tier_max, ?) WHERE hash = ?").run(tier, hash_b);
      res.json({ ok: true, action: "created", tier, tier_label, score });
    } else {
      const newCount = existing.co_activation_count + 1;
      const score = sigScore(newCount);
      const { tier, tier_label } = deriveTier(score);
      const tierChanged = tier !== existing.tier;
      db.prepare("UPDATE crystal_combinations SET co_activation_count=?, score=?, tier=?, tier_label=?, last_seen=?, last_context=? WHERE hash_a=? AND hash_b=?")
        .run(newCount, score, tier, tier_label, now, lastContext, hash_a, hash_b);
      if (tierChanged) {
        const eventType = tier > existing.tier ? "tier_upgraded" : "tier_decayed";
        db.prepare("INSERT INTO crystal_events (event_type, crystal_hash, related_hash, tier_before, tier_after, event_data, timestamp) VALUES (?,?,?,?,?,?,?)").run(eventType, hash_a, hash_b, existing.tier, tier, JSON.stringify({ process, score, count: newCount }), now);
        db.prepare("UPDATE crystal_ledger SET entanglement_tier_max = MAX(entanglement_tier_max, ?) WHERE hash = ? OR hash = ?").run(tier, hash_a, hash_b);
      }
      res.json({ ok: true, action: "updated", tier, tier_label, score, co_activation_count: newCount, tier_changed: tierChanged });
    }
  } finally { db.close(); }
});

// ── POST /zombrains/crystals/event — log a state change ───────────────────────
router.post("/zombrains/crystals/event", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const body = req.body as Record<string, unknown>;
  const event_type = body["event_type"] as string | undefined;
  const crystal_hash = body["crystal_hash"] as string | undefined;
  if (!event_type || !crystal_hash) { res.status(400).json({ error: "event_type and crystal_hash required" }); return; }

  const db = getDb();
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO crystal_events (event_type, crystal_hash, related_hash, tier_before, tier_after, event_data, timestamp) VALUES (?,?,?,?,?,?,?)").run(
      event_type, crystal_hash,
      (body["related_hash"] as string | null) ?? null,
      (body["tier_before"] as number | null) ?? null,
      (body["tier_after"] as number | null) ?? null,
      body["event_data"] ? JSON.stringify(body["event_data"]) : null,
      now,
    );
    res.json({ ok: true });
  } finally { db.close(); }
});

// ── POST /zombrains/crystals/weight-vector — upsert domain priority crystal ───
// Called fire-and-forget from Railway (idleProtocol._commitWinner + queue.markDone).
// Each domain has exactly one row keyed by sha1('weight-vector:' + domain).
// combined = (1 - coverage) × 0.5 + winRate × 0.3 + quality × 0.2
router.post("/zombrains/crystals/weight-vector", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { createHash } = require("crypto") as typeof import("crypto");
  const body = req.body as Record<string, unknown>;
  const domain    = (body["domain"]    as string | undefined) ?? "";
  const component = (body["component"] as string | undefined) ?? "";
  const value     = body["value"] as number | undefined;
  const VALID_DOMAINS    = new Set(["coding","diagnostic","knowledge_lookup","self_improvement","proposal_generation","deploy_ship","migration","general"]);
  const VALID_COMPONENTS = new Set(["winRate","quality","coverage"]);
  if (!VALID_DOMAINS.has(domain))    { res.status(400).json({ error: "invalid domain"    }); return; }
  if (!VALID_COMPONENTS.has(component)) { res.status(400).json({ error: "invalid component" }); return; }
  if (typeof value !== "number")     { res.status(400).json({ error: "value must be a number" }); return; }
  const db = getDb();
  try {
    const hash     = createHash("sha1").update("weight-vector:" + domain).digest("hex");
    const existing = db.prepare("SELECT payload FROM crystal_ledger WHERE hash = ?").get(hash) as { payload: string } | undefined;
    const payload: Record<string, unknown> = existing
      ? (() => { try { return JSON.parse(existing.payload) as Record<string, unknown>; } catch { return {}; } })()
      : { coverage: 0.5, winRate: 0.5, quality: 0.5, combined: 0.5 };
    payload[component]  = value;
    payload["updatedAt"] = new Date().toISOString();
    payload["domain"]    = domain;
    const coverage  = typeof payload["coverage"] === "number" ? (payload["coverage"] as number) : 0.5;
    const winRate   = typeof payload["winRate"]  === "number" ? (payload["winRate"]  as number) : 0.5;
    const quality   = typeof payload["quality"]  === "number" ? (payload["quality"]  as number) : 0.5;
    payload["combined"] = (1 - coverage) * 0.5 + winRate * 0.3 + quality * 0.2;
    const payloadStr = JSON.stringify(payload);
    const now = new Date().toISOString();
    if (existing) {
      db.prepare("UPDATE crystal_ledger SET payload = ?, last_activated = ? WHERE hash = ?").run(payloadStr, now, hash);
    } else {
      db.prepare(
        "INSERT INTO crystal_ledger (hash, type, domain, source_type, tags, activation_count, created_at, last_activated, payload) VALUES (?, 'meta', ?, 'weight-vector', 'weight,domain-priority', 1, ?, ?, ?)"
      ).run(hash, domain, now, now, payloadStr);
    }
    res.json({ ok: true, domain, combined: payload["combined"] });
  } finally { db.close(); }
});

// ── DELETE /zombrains/crystals/empty — prune hollow crystal shells ─────────────
// Called from P14 boot hook before codex-seed fires. Removes rows where payload
// is '{}', null, or 'null' but keeps weight-vector rows (they start at defaults).
router.delete("/zombrains/crystals/empty", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const info = db.prepare(
      "DELETE FROM crystal_ledger WHERE (payload = '{}' OR payload IS NULL OR payload = 'null') AND source_type != 'weight-vector'"
    ).run();
    res.json({ ok: true, deleted: info.changes });
  } finally { db.close(); }
});

// ── GET /zombrains/crystals/ledger — query crystals ───────────────────────────
router.get("/zombrains/crystals/ledger", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const { type, domain, source_type, provider, minQuality, minTier, tags, since, limit = "50", sortBy = "created" } = req.query as Record<string, string>;
    const parts: string[] = ["SELECT hash, type, domain, source_type, provider, quality_score, token_count, latency_ms, tools_used, persona, task_id, tags, activation_count, relevance_score, entanglement_count, entanglement_tier_max, created_at, last_activated FROM crystal_ledger WHERE 1=1"];
    const params: unknown[] = [];
    if (type)        { parts.push("AND type = ?");                  params.push(type); }
    if (domain)      { parts.push("AND domain = ?");                params.push(domain); }
    if (source_type) { parts.push("AND source_type = ?");           params.push(source_type); }
    if (provider)    { parts.push("AND provider = ?");              params.push(provider); }
    if (minQuality) { parts.push("AND quality_score >= ?");        params.push(Number(minQuality)); }
    if (minTier)    { parts.push("AND entanglement_tier_max >= ?"); params.push(Number(minTier)); }
    if (since)      { parts.push("AND created_at >= ?");           params.push(since); }
    if (tags) {
      try {
        const tagArr = JSON.parse(tags) as string[];
        for (const t of tagArr) { parts.push(`AND json_each.value = '${t.replace(/'/g, "''")}'`); }
      } catch { parts.push("AND tags LIKE ?"); params.push(`%${tags}%`); }
    }
    const orderMap: Record<string, string> = { relevance: "relevance_score DESC", quality: "quality_score DESC", activation: "activation_count DESC", created: "created_at DESC" };
    parts.push(`ORDER BY ${orderMap[sortBy] ?? "created_at DESC"} LIMIT ?`);
    params.push(Math.min(Number(limit) || 50, 200));
    const rows = db.prepare(parts.join(" ")).all(...params) as Record<string, unknown>[];
    res.json({ ok: true, crystals: rows, count: rows.length });
  } finally { db.close(); }
});

// ── GET /zombrains/crystals/combinations ─────────────────────────────────────
router.get("/zombrains/crystals/combinations", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const { hash, minTier, process, crossDomain, since, limit = "50" } = req.query as Record<string, string>;
    const parts: string[] = ["SELECT * FROM crystal_combinations WHERE 1=1"];
    const params: unknown[] = [];
    if (hash)        { parts.push("AND (hash_a = ? OR hash_b = ?)"); params.push(hash, hash); }
    if (minTier)     { parts.push("AND tier >= ?");                  params.push(Number(minTier)); }
    if (process)     { parts.push("AND process = ?");                params.push(process); }
    if (crossDomain) { parts.push("AND cross_domain = ?");           params.push(Number(crossDomain)); }
    if (since)       { parts.push("AND last_seen >= ?");             params.push(since); }
    parts.push("ORDER BY score DESC LIMIT ?");
    params.push(Math.min(Number(limit) || 50, 200));
    const rows = db.prepare(parts.join(" ")).all(...params) as Record<string, unknown>[];
    res.json({ ok: true, combinations: rows, count: rows.length });
  } finally { db.close(); }
});

// ── GET /zombrains/crystals/events ────────────────────────────────────────────
router.get("/zombrains/crystals/events", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const { hash, eventType, since, limit = "50" } = req.query as Record<string, string>;
    const parts: string[] = ["SELECT * FROM crystal_events WHERE 1=1"];
    const params: unknown[] = [];
    if (hash)      { parts.push("AND crystal_hash = ?"); params.push(hash); }
    if (eventType) { parts.push("AND event_type = ?");   params.push(eventType); }
    if (since)     { parts.push("AND timestamp >= ?");   params.push(since); }
    parts.push("ORDER BY id DESC LIMIT ?");
    params.push(Math.min(Number(limit) || 50, 500));
    const rows = db.prepare(parts.join(" ")).all(...params) as Record<string, unknown>[];
    res.json({ ok: true, events: rows, count: rows.length });
  } finally { db.close(); }
});

// ── GET /zombrains/crystals/stats ─────────────────────────────────────────────
router.get("/zombrains/crystals/stats", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    type CountRow = { type: string; cnt: number };
    type DomainRow = { domain: string; cnt: number };
    type TierRow = { entanglement_tier_max: number; cnt: number };
    type QualRow = { p25: number; p50: number; p75: number; p90: number; avg: number };
    type GrowthRow = { last24h: number; last7d: number };
    type TopCrystal = { hash: string; activation_count: number; quality_score: number; type: string; domain: string };
    type TopComb = { hash_a: string; hash_b: string; tier: number; tier_label: string; co_activation_count: number; score: number };

    const byType = db.prepare("SELECT type, COUNT(*) as cnt FROM crystal_ledger GROUP BY type").all() as CountRow[];
    const byDomain = db.prepare("SELECT domain, COUNT(*) as cnt FROM crystal_ledger GROUP BY domain").all() as DomainRow[];
    const byTier = db.prepare("SELECT entanglement_tier_max, COUNT(*) as cnt FROM crystal_ledger GROUP BY entanglement_tier_max ORDER BY entanglement_tier_max DESC").all() as TierRow[];
    const total = db.prepare("SELECT COUNT(*) as c FROM crystal_ledger").get() as { c: number };
    const qualDist = db.prepare(`
      SELECT
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY quality_score) as p25,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY quality_score) as p50,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY quality_score) as p75,
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY quality_score) as p90,
        AVG(quality_score) as avg
      FROM crystal_ledger WHERE quality_score IS NOT NULL
    `).get() as QualRow | undefined;
    // SQLite doesn't have PERCENTILE_CONT — use manual percentile
    const qualRows = db.prepare("SELECT quality_score FROM crystal_ledger WHERE quality_score IS NOT NULL ORDER BY quality_score ASC").all() as { quality_score: number }[];
    const pct = (arr: { quality_score: number }[], p: number) => { if (!arr.length) return null; const i = Math.floor(arr.length * p); return arr[Math.min(i, arr.length - 1)]?.quality_score ?? null; };
    const qualStats = qualRows.length === 0 ? null : { p25: pct(qualRows, 0.25), p50: pct(qualRows, 0.50), p75: pct(qualRows, 0.75), p90: pct(qualRows, 0.90), avg: qualRows.reduce((s, r) => s + r.quality_score, 0) / qualRows.length, n: qualRows.length };
    void qualDist; // unused (SQLite PERCENTILE_CONT unavailable)

    const growth = db.prepare(`
      SELECT
        SUM(CASE WHEN created_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) as last24h,
        SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) as last7d
      FROM crystal_ledger
    `).get() as GrowthRow;

    const topCrystals = db.prepare("SELECT hash, activation_count, quality_score, type, domain FROM crystal_ledger ORDER BY activation_count DESC LIMIT 10").all() as TopCrystal[];
    const topCombs = db.prepare("SELECT hash_a, hash_b, tier, tier_label, co_activation_count, score FROM crystal_combinations ORDER BY tier DESC, score DESC LIMIT 10").all() as TopComb[];

    res.json({ ok: true, total: total.c, byType, byDomain, byTier, qualityDistribution: qualStats, growth, topCrystals, topCombinations: topCombs });
  } finally { db.close(); }
});

// ── GET /zombrains/crystals/health — emit rate per source (#632) ───────────────
router.get("/zombrains/crystals/health", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    type SourceRow = { source_type: string; count: number; last_emit: string };
    const bySource24h = db.prepare(`
      SELECT source_type, COUNT(*) as count, MAX(created_at) as last_emit
      FROM crystal_ledger
      WHERE created_at >= datetime('now', '-24 hours')
      GROUP BY source_type
      ORDER BY count DESC
    `).all() as SourceRow[];
    const bySource7d = db.prepare(`
      SELECT source_type, COUNT(*) as count
      FROM crystal_ledger
      WHERE created_at >= datetime('now', '-7 days')
      GROUP BY source_type
      ORDER BY count DESC
    `).all() as { source_type: string; count: number }[];
    type TotalRow = { c: number };
    const total24h = (db.prepare("SELECT COUNT(*) as c FROM crystal_ledger WHERE created_at >= datetime('now','-24 hours')").get() as TotalRow).c;
    const total7d  = (db.prepare("SELECT COUNT(*) as c FROM crystal_ledger WHERE created_at >= datetime('now','-7 days')").get() as TotalRow).c;
    const totalAll = (db.prepare("SELECT COUNT(*) as c FROM crystal_ledger").get() as TotalRow).c;
    res.json({ ok: true, total: totalAll, last24h: { total: total24h, bySource: bySource24h }, last7d: { total: total7d, bySource: bySource7d } });
  } finally { db.close(); }
});

// ── GET /zombrains/crystals/patterns ──────────────────────────────────────────
router.get("/zombrains/crystals/patterns", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const rows = db.prepare("SELECT * FROM crystal_patterns ORDER BY confidence DESC").all() as Record<string, unknown>[];
    const parsed = rows.map(r => ({ ...r, pattern_data: (() => { try { return JSON.parse(r["pattern_data"] as string); } catch { return r["pattern_data"]; } })() }));
    res.json({ ok: true, patterns: parsed, count: parsed.length });
  } finally { db.close(); }
});

// ── GET /zombrains/evolver/status ─────────────────────────────────────────────
// Returns per-domain circuit breaker state. Safe to call at any time — reads
// module-level Map, no DB, zero cost.
router.get("/zombrains/evolver/status", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  try {
    const status = getEvolverStatus();
    const now    = Date.now();
    const rows = (EVOLVER_DOMAINS as readonly string[]).map((domain) => {
      const b = status.breakers[domain] ?? { consecutiveFailures: 0, pausedUntil: 0, stopped: false, stressSkipStreak: 0 };
      return {
        domain,
        stopped:             b.stopped,
        consecutiveFailures: b.consecutiveFailures,
        stressSkipStreak:    b.stressSkipStreak,
        pausedUntil:         b.pausedUntil,
        pausedUntilIso:      b.pausedUntil > now ? new Date(b.pausedUntil).toISOString() : null,
      };
    });
    res.json({
      ok:                 true,
      generalGenerations: status.generalGenerations,
      specialisedDomains: status.specialisedDomains,
      rows,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.json({ ok: false, error: msg, rows: [] });
  }
});

// ── POST /zombrains/evolver/reset/:domain ─────────────────────────────────────
// Clears circuit breaker for a domain (or "all"). No DB write — in-memory only.
router.post("/zombrains/evolver/reset/:domain", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const domain = String(req.params["domain"] ?? "");
  if (!domain) { res.status(400).json({ ok: false, error: "domain required" }); return; }
  try {
    resetEvolverDomain(domain);
    res.json({ ok: true, reset: domain });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
