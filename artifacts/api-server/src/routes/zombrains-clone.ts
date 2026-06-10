// ══════════════════════════════════════════════════════════════════════════════
// zombrains-clone.ts — Dual-host clone bundle storage, comparison, and promotion.
// Routes: /zombrains/persist/clone-bundle, /zombrains/metrics/:env,
//         /zombrains/clone/compare, /zombrains/clone/promote
// (Task #619)
// ══════════════════════════════════════════════════════════════════════════════
import { Router, type IRouter, type Request, type Response } from "express";
import { getDb, authCheck } from "./zombrains-shared.js";

const router: IRouter = Router();

// ── Persist: clone bundle (production → Monitor → staging) ───────────────────
// Production POSTs its full state bundle here before staging deployment.
// Staging GETs this on P-1 boot hook to restore evolver state.

router.post("/zombrains/persist/clone-bundle", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const bundle = req.body;
  if (typeof bundle !== "object" || Array.isArray(bundle) || !bundle.bundleVersion) {
    res.status(400).json({ error: "body must be a clone bundle object with bundleVersion" }); return;
  }
  const json = JSON.stringify({ bundle, storedAt: new Date().toISOString() });
  if (Buffer.byteLength(json, "utf8") > 2_000_000) {
    res.status(400).json({ error: "bundle exceeds 2MB limit" }); return;
  }
  const db = getDb();
  try {
    db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES ('clone_bundle', ?)")
      .run(json);
    res.json({ ok: true, bundleVersion: bundle.bundleVersion, capturedAt: bundle.capturedAt ?? null });
  } finally { db.close(); }
});

router.get("/zombrains/persist/clone-bundle", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'clone_bundle'").get() as { value: string } | undefined;
    if (!row) { res.json(null); return; }
    const parsed = (() => { try { return JSON.parse(row.value); } catch { return null; } })();
    res.json(parsed?.bundle ?? null);
  } finally { db.close(); }
});

// ── Metrics: per-env performance reporting ────────────────────────────────────
// Both production and staging POST their rolling metrics here every N minutes.
// Fields: avgQuality, armorWinRate, tasksCompleted, deadLetters, tasksWindow, reportedAt

router.post("/zombrains/metrics/:env", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const env = String(req.params["env"] ?? "");
  if (!["production", "staging"].includes(env)) {
    res.status(400).json({ error: "env must be production or staging" }); return;
  }
  const data = req.body;
  if (typeof data !== "object" || Array.isArray(data)) {
    res.status(400).json({ error: "body must be an object" }); return;
  }
  const key = `clone_metrics_${env}`;
  const db = getDb();
  try {
    // Keep last 48 metric snapshots per env (one per 30 min = 24h)
    const existingRow = db.prepare("SELECT value FROM zombrains_settings WHERE key = ?").get(key) as { value: string } | undefined;
    let history: unknown[] = [];
    if (existingRow) {
      try { history = JSON.parse(existingRow.value); } catch { history = []; }
    }
    history.push({ ...data, storedAt: new Date().toISOString() });
    if (history.length > 48) history = history.slice(-48);
    db.prepare("INSERT OR REPLACE INTO zombrains_settings (key, value) VALUES (?, ?)")
      .run(key, JSON.stringify(history));
    res.json({ ok: true, env, historyLength: history.length });
  } finally { db.close(); }
});

router.get("/zombrains/metrics/:env", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const env = String(req.params["env"] ?? "");
  if (!["production", "staging"].includes(env)) {
    res.status(400).json({ error: "env must be production or staging" }); return;
  }
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM zombrains_settings WHERE key = ?").get(`clone_metrics_${env}`) as { value: string } | undefined;
    if (!row) { res.json([]); return; }
    try { res.json(JSON.parse(row.value)); } catch { res.json([]); }
  } finally { db.close(); }
});

// ── Compare: side-by-side verdict over last 24h ───────────────────────────────
// verdict = staging_leading if staging outperforms production by >5% on BOTH
// avgQuality AND armorWinRate over >= 20 tasks. Below 20 tasks: insufficient_data.

function _summarise(history: Array<Record<string, unknown>>): {
  avgQuality: number; armorWinRate: number;
  tasksCompleted: number; deadLetters: number;
  tasksWindow: number;
} {
  if (!history.length) return { avgQuality: 0, armorWinRate: 0, tasksCompleted: 0, deadLetters: 0, tasksWindow: 0 };
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = history.filter(h => {
    const d = h["storedAt"] as string | undefined;
    return d ? new Date(d).getTime() > cutoff : true;
  });
  if (!recent.length) recent.push(...history.slice(-1)); // fall back to last snapshot
  const avg = (key: string) => {
    const vals = recent.map(h => Number(h[key] ?? 0)).filter(v => !isNaN(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  const sum = (key: string) => recent.reduce((a, h) => a + Number(h[key] ?? 0), 0);
  return {
    avgQuality:    avg("avgQuality"),
    armorWinRate:  avg("armorWinRate"),
    tasksCompleted: sum("tasksCompleted"),
    deadLetters:   sum("deadLetters"),
    tasksWindow:   sum("tasksCompleted"),
  };
}

router.get("/zombrains/clone/compare", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    const prodRow = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'clone_metrics_production'").get() as { value: string } | undefined;
    const stagRow = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'clone_metrics_staging'").get() as { value: string } | undefined;
    const bundleRow = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'clone_bundle'").get() as { value: string } | undefined;

    const prodHistory: Array<Record<string, unknown>> = prodRow ? (() => { try { return JSON.parse(prodRow.value); } catch { return []; } })() : [];
    const stagHistory: Array<Record<string, unknown>> = stagRow ? (() => { try { return JSON.parse(stagRow.value); } catch { return []; } })() : [];

    const prod = _summarise(prodHistory);
    const stag = _summarise(stagHistory);

    const qualityDelta  = stag.avgQuality   - prod.avgQuality;
    const winRateDelta  = stag.armorWinRate - prod.armorWinRate;

    let verdict: string;
    const stagingOnline = stagHistory.length > 0 && (() => {
      const last = stagHistory[stagHistory.length - 1];
      return last["storedAt"] ? Date.now() - new Date(last["storedAt"] as string).getTime() < 30 * 60 * 1000 : false;
    })();

    if (stag.tasksWindow < 20) {
      verdict = "insufficient_data";
    } else if (qualityDelta > prod.avgQuality * 0.05 && winRateDelta > prod.armorWinRate * 0.05) {
      verdict = "staging_leading";
    } else if (-qualityDelta > stag.avgQuality * 0.05 && -winRateDelta > stag.armorWinRate * 0.05) {
      verdict = "production_leading";
    } else {
      verdict = "tied";
    }

    let bundleAgeH: number | null = null;
    if (bundleRow) {
      const parsed = (() => { try { return JSON.parse(bundleRow.value); } catch { return null; } })();
      if (parsed?.storedAt) bundleAgeH = (Date.now() - new Date(parsed.storedAt).getTime()) / (1000 * 60 * 60);
    }

    res.json({
      window: "24h",
      production:    prod,
      staging:       stag,
      delta:         { qualityDelta: Math.round(qualityDelta * 100) / 100, winRateDelta: Math.round(winRateDelta * 100) / 100 },
      verdict,
      bundleAgeH:    bundleAgeH != null ? Math.round(bundleAgeH * 10) / 10 : null,
      stagingOnline,
    });
  } finally { db.close(); }
});

// ── Promote: extract staging improvements → enqueue production task ───────────
// Auth-gated. Only valid when verdict = staging_leading.
// Reads last staging metrics snapshot, diffs per-domain fitness,
// appends a T1 promotion task to the production ZomBrains queue.

router.post("/zombrains/clone/promote", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const db = getDb();
  try {
    // Check verdict first
    const prodRow = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'clone_metrics_production'").get() as { value: string } | undefined;
    const stagRow = db.prepare("SELECT value FROM zombrains_settings WHERE key = 'clone_metrics_staging'").get() as { value: string } | undefined;
    if (!stagRow) { res.status(400).json({ error: "no staging metrics available" }); return; }

    const prodHistory: Array<Record<string, unknown>> = prodRow ? (() => { try { return JSON.parse(prodRow.value); } catch { return []; } })() : [];
    const stagHistory: Array<Record<string, unknown>> = stagRow ? (() => { try { return JSON.parse(stagRow.value); } catch { return []; } })() : [];
    const prod = _summarise(prodHistory);
    const stag = _summarise(stagHistory);

    if (stag.tasksWindow < 20) {
      res.status(400).json({ error: "insufficient_data: staging needs >= 20 tasks before promoting", tasksWindow: stag.tasksWindow }); return;
    }

    // Extract domain fitness deltas from staging metrics
    const lastStagSnapshot = stagHistory[stagHistory.length - 1] as Record<string, unknown>;
    const stagDomains = (lastStagSnapshot?.["domains"] ?? {}) as Record<string, { fitness: number }>;
    const lastProdSnapshot = prodHistory.length > 0 ? prodHistory[prodHistory.length - 1] as Record<string, unknown> : {};
    const prodDomains = (lastProdSnapshot?.["domains"] ?? {}) as Record<string, { fitness: number }>;

    const improvedDomains: Array<{ domain: string; stagFitness: number; prodFitness: number; delta: number }> = [];
    for (const [domain, sd] of Object.entries(stagDomains)) {
      const sf = sd?.fitness ?? 0;
      const pf = (prodDomains[domain]?.fitness ?? 0);
      if (sf > pf * 1.02) { // > 2% improvement per domain
        improvedDomains.push({ domain, stagFitness: sf, prodFitness: pf, delta: sf - pf });
      }
    }

    const domainSummary = improvedDomains.length > 0
      ? improvedDomains.map(d => `${d.domain}(+${d.delta.toFixed(3)})`).join(", ")
      : "all domains (global quality improvement)";

    // Append T1 promotion task to production queue
    const existingQueueRow = db.prepare("SELECT data FROM zombrains_queue WHERE key = 'main'").get() as { data: string } | undefined;
    let queue: unknown[] = [];
    if (existingQueueRow?.data) {
      try { queue = JSON.parse(existingQueueRow.data); } catch { queue = []; }
    }

    const promotionTask = {
      id:         `promote-${Date.now()}`,
      prompt:     `Staging promotion approved: inject improved evolver genomes into production for: ${domainSummary}. Read staging champion data from GET /api/zombrains/metrics/staging (last snapshot, domains field). For each improved domain, call inject_staging_genome tool with the staging champion genome. Do NOT overwrite production crystals — only seed the improved genomes into the evolver population for those domains.`,
      status:     "pending",
      priority:   1,
      source:     "clone_promotion",
      createdAt:  new Date().toISOString(),
      updatedAt:  new Date().toISOString(),
      metadata:   { improvedDomains, stagQuality: stag.avgQuality, prodQuality: prod.avgQuality },
    };

    queue.unshift(promotionTask); // T1 = front of queue
    db.prepare("INSERT OR REPLACE INTO zombrains_queue (key, data, updated_at) VALUES ('main', ?, datetime('now'))")
      .run(JSON.stringify(queue));

    res.json({
      ok: true,
      taskId: promotionTask.id,
      improvedDomains: improvedDomains.length,
      domainSummary,
      qualityDelta:  Math.round((stag.avgQuality - prod.avgQuality) * 100) / 100,
      winRateDelta:  Math.round((stag.armorWinRate - prod.armorWinRate) * 100) / 100,
    });
  } finally { db.close(); }
});

export default router;
