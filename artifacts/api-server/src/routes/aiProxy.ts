import { Router, type IRouter, type Request, type Response } from "express";
import { callProvider, callProviderWithTools, logCall, getCallLog, type ToolDef, type CallEvent } from "../lib/providers.js";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { writeErrorLog } from "../middlewares/errorCapture.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.resolve(__dirname, "..", "..", "..", "poop_tracker.db");

function getClusterFlag(flag: string): boolean {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db.prepare("SELECT enabled FROM feature_flags WHERE flag=?").get(flag) as { enabled: number } | undefined;
    return row ? row.enabled !== 0 : true; // default ON if not set
  } finally { db.close(); }
}

const router: IRouter = Router();

function authCheck(req: Request, res: Response): boolean {
  const secret     = process.env["ADMIN_SECRET"];
  const xHeader    = req.headers["x-zombrains-secret"] as string | undefined;
  const authBearer = (req.headers["authorization"] as string | undefined)?.replace(/^Bearer\s+/i, "");
  const provided   = xHeader ?? authBearer;
  if (!secret || provided !== secret) {
    res.status(403).json({ error: "forbidden" });
    return false;
  }
  return true;
}

// POST /api/ai/proxy
// Body: { messages, tools?, hint?, taskId? }
// Returns: { content, toolCalls, provider, usage }
router.post("/ai/proxy", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { messages, tools, hint, taskId, source: explicitSource } = req.body as {
    messages: unknown; tools?: ToolDef[]; hint?: string; taskId?: string; source?: string;
  };
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages array required" });
    return;
  }

  // Caller identity: accept explicit source field first (ZomBrains sends "zombrains").
  // Fallback keeps backward-compat but defaults to "zombrains" since only ZomBrains
  // calls this endpoint directly — Poopy bot uses /api/poopy/infer.
  const source: CallEvent["source"] =
    explicitSource === "poopy" || explicitSource === "zombrains" || explicitSource === "api-server"
      ? (explicitSource as CallEvent["source"])
      : "zombrains";

  // Enforce per-bot cluster flags so each bot's toggle is independent.
  if (source === "zombrains" && !getClusterFlag("zombrains_cluster_enabled")) {
    res.status(503).json({
      error: "ZomBrains cluster disabled",
      flag:  "zombrains_cluster_enabled",
      fix:   "PATCH /api/zombrains/cluster-flags with { flag: 'zombrains_cluster_enabled', enabled: true } using x-admin-secret header. Do NOT attempt to fix this by editing queue.js or ai.js — the flag lives in the feature_flags DB table.",
    });
    return;
  }
  if (source === "poopy" && !getClusterFlag("poopy_cluster_enabled")) {
    res.status(503).json({
      error: "Poopy cluster disabled",
      flag:  "poopy_cluster_enabled",
      fix:   "PATCH /api/zombrains/cluster-flags with { flag: 'poopy_cluster_enabled', enabled: true } using x-admin-secret header.",
    });
    return;
  }

  const meta = { source, taskId };

  try {
    if (tools && tools.length > 0) {
      const result = await callProviderWithTools(
        messages as Parameters<typeof callProviderWithTools>[0], tools, hint, meta,
      );
      res.json({
        content:   result.content,
        toolCalls: result.toolCalls,
        provider:  result.provider,
        usage: {
          prompt_tokens:     result.usage.prompt,
          completion_tokens: result.usage.completion,
          total_tokens:      result.usage.total,
        },
      });
    } else {
      const result = await callProvider(
        messages as Parameters<typeof callProvider>[0], hint, meta,
      );
      res.json({
        content:   result.result,
        toolCalls: [],
        provider:  result.provider,
        usage: {
          prompt_tokens:     result.usage.prompt,
          completion_tokens: result.usage.completion,
          total_tokens:      result.usage.total || result.tokens,
        },
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(503).json({ error: msg });
  }
});

// POST /api/ai/call-event
// ZomBrains Railway posts its own direct call events here (groq, cerebras, gemini etc.)
// so the admin panel has a unified view of every call from all sources.
// Body: single CallEvent or array of CallEvents (batched).
router.post("/ai/call-event", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const body = req.body as Partial<CallEvent> | Partial<CallEvent>[];
  const events = Array.isArray(body) ? body : [body];
  for (const ev of events) {
    if (!ev.slot || !ev.outcome) continue;
    logCall({
      source:          ev.source ?? "zombrains",
      slot:            ev.slot,
      outcome:         ev.outcome as CallEvent["outcome"],
      reason:          ev.reason,
      tokens:          ev.tokens,
      latencyMs:       ev.latencyMs,
      taskId:          ev.taskId,
      rolesRequired:   ev.rolesRequired,
      rolesPreferred:  ev.rolesPreferred,
    });
  }
  res.json({ ok: true, received: events.length });
});

// GET /api/ai/calls
// Returns the merged call event log (api-server + ZomBrains direct calls).
// Query params:
//   limit   — max events to return (default 200)
//   source  — filter by source: "api-server" | "zombrains" | "poopy"
//   slot    — filter by slot name
//   outcome — filter by outcome
//   since   — only events with ts > this unix ms timestamp
router.get("/ai/calls", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const { limit, source, slot, outcome, since } = req.query as Record<string, string | undefined>;

  let events = getCallLog();

  if (source)  events = events.filter(e => e.source  === source);
  if (slot)    events = events.filter(e => e.slot    === slot);
  if (outcome) events = events.filter(e => e.outcome === outcome);
  if (since)   events = events.filter(e => e.ts > Number(since));

  const cap = Math.min(Number(limit ?? 200), 1000);
  res.json({ ok: true, count: events.length, events: events.slice(0, cap) });
});

// GET /api/ai/calls/summary
// Aggregated view per slot: total calls, success rate, last seen, skip breakdown.
// Useful for the admin panel node health table.
router.get("/ai/calls/summary", (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;
  const all = getCallLog();

  type SlotSummary = {
    slot:            string;
    total:           number;
    success:         number;
    rate_limited:    number;
    error:           number;
    skipped_cooldown: number;
    skipped_no_key:  number;
    skipped_role:    number;
    skipped_broken:  number;
    successRate:     number;
    totalTokens:     number;
    avgLatencyMs:    number;
    lastCallTs:      number | null;
    lastOutcome:     string | null;
    // flag: slot was skipped for a reason OTHER than specialization (role exclusion)
    // i.e. it was available in terms of capability but missed due to rate limit / broken / cooldown
    unexpectedSkips: number;
  };

  const bySlot = new Map<string, SlotSummary>();

  for (const ev of all) {
    if (!bySlot.has(ev.slot)) {
      bySlot.set(ev.slot, {
        slot: ev.slot, total: 0, success: 0, rate_limited: 0, error: 0,
        skipped_cooldown: 0, skipped_no_key: 0, skipped_role: 0, skipped_broken: 0,
        successRate: 0, totalTokens: 0, avgLatencyMs: 0, lastCallTs: null, lastOutcome: null,
        unexpectedSkips: 0,
      });
    }
    const s = bySlot.get(ev.slot)!;
    s.total++;
    if (ev.outcome === "success") {
      s.success++;
      s.totalTokens  += ev.tokens    ?? 0;
      s.avgLatencyMs  = s.avgLatencyMs + ((ev.latencyMs ?? 0) - s.avgLatencyMs) / s.success;
    } else if (ev.outcome === "rate_limited")     { s.rate_limited++;     s.unexpectedSkips++; }
    else if (ev.outcome === "error")              { s.error++;            s.unexpectedSkips++; }
    else if (ev.outcome === "skipped_cooldown")   { s.skipped_cooldown++; s.unexpectedSkips++; }
    else if (ev.outcome === "skipped_no_key")     { s.skipped_no_key++; }
    else if (ev.outcome === "skipped_role")       { s.skipped_role++; }   // expected — specialization system
    else if (ev.outcome === "skipped_broken")     { s.skipped_broken++;   s.unexpectedSkips++; }

    if (!s.lastCallTs || ev.ts > s.lastCallTs) {
      s.lastCallTs  = ev.ts;
      s.lastOutcome = ev.outcome;
    }
    s.successRate = s.total > 0 ? +(s.success / s.total * 100).toFixed(1) : 0;
  }

  const summaries = [...bySlot.values()].sort((a, b) => (b.lastCallTs ?? 0) - (a.lastCallTs ?? 0));
  res.json({ ok: true, slots: summaries });
});


// ── POST /api/ai/proxy/emergency ──────────────────────────────────────────────
// Last-resort fallback for Poopy when ALL 6 POOPY_* provider slots are exhausted.
// Auth: x-zombrains-secret (Poopy sends this on all zbApiCalls).
//
// Provider order:
//   1. GROQ_API_KEY (ZomBrains' shared Groq key — fastest)
//   2. BIRTHDAY_CEREBRAS, BIRTHDAY_SAMBANOVA, BIRTHDAY_GEMINI, BIRTHDAY_MISTRAL
//      (Birthday Bot's idle keys — independent quota pools, off-limits while in use)
//   3. CEREBRAS_API_KEY, MISTRAL_API_KEY (remaining shared keys)
//
// Guard rails:
//   - Rejects model_hint === 'deepseek-r1' — preserve reasoning quota
//   - Rate limit: max 10 emergency calls/hour per source IP
//   - Every call logged to error_log with source='emergency-proxy' for owner visibility
//
// Why Birthday keys here and not BIRTHDAY_GROQ: Birthday Bot uses BIRTHDAY_GROQ as
// its primary key. Cerebras/Sambanova/Gemini/Mistral are idle between birthday tasks.
const _emergencyCallLog = new Map<string, number[]>(); // sourceIp → [timestamps]
const EMERGENCY_RATE_LIMIT = 10;
const EMERGENCY_WINDOW_MS  = 60 * 60 * 1000; // 1 hour

function checkEmergencyRateLimit(sourceIp: string): { allowed: boolean; retryAfterSeconds: number } {
  const now    = Date.now();
  const window = now - EMERGENCY_WINDOW_MS;
  const calls  = (_emergencyCallLog.get(sourceIp) ?? []).filter(ts => ts > window);
  if (calls.length >= EMERGENCY_RATE_LIMIT) {
    const oldest     = Math.min(...calls);
    const retryAfter = Math.ceil((oldest + EMERGENCY_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }
  calls.push(now);
  _emergencyCallLog.set(sourceIp, calls);
  return { allowed: true, retryAfterSeconds: 0 };
}

// Inline OpenAI-compatible call — avoids coupling to callProvider's routing logic.
// Emergency needs explicit key priority, not role-based scoring.
async function emergencyOpenAI(
  url: string, key: string | undefined, model: string, messages: unknown[],
): Promise<{ text: string; provider: string }> {
  if (!key) throw new Error("no_key");
  const r = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body:    JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 4096 }),
    signal:  AbortSignal.timeout(25_000),
  });
  if (r.status === 429) throw new Error("rate_limited");
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const j = await r.json() as { choices: Array<{ message: { content: string } }> };
  return { text: j.choices?.[0]?.message?.content ?? "", provider: model };
}

async function emergencyCerebras(key: string | undefined, messages: unknown[]): Promise<{ text: string; provider: string }> {
  if (!key) throw new Error("no_key");
  // Try primary model first; fall back to secondary on non-429 error
  return emergencyOpenAI("https://api.cerebras.ai/v1/chat/completions", key, "gpt-oss-120b", messages)
    .catch(async e => {
      if ((e as Error).message === "rate_limited") throw e;
      return emergencyOpenAI("https://api.cerebras.ai/v1/chat/completions", key, "zai-glm-4.7", messages);
    });
}

router.post("/ai/proxy/emergency", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;

  const { messages, model_hint } = req.body as { messages?: unknown[]; model_hint?: string };

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages array required" });
    return;
  }

  // Guard: never use this endpoint for DeepSeek reasoning — preserve quota
  if (typeof model_hint === "string" && /deepseek.*r1|r1.*deepseek/i.test(model_hint)) {
    res.status(403).json({
      error:  "deepseek-r1 is not available via the emergency proxy (reasoning quota protected)",
      reason: "Use a non-reasoning provider for fallback calls",
    });
    return;
  }

  // Per-IP rate limit
  const sourceIp = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
                ?? req.socket.remoteAddress
                ?? "unknown";
  const { allowed, retryAfterSeconds } = checkEmergencyRateLimit(sourceIp);
  if (!allowed) {
    res.status(429).json({ error: "Emergency proxy rate limit exceeded", retry_after_seconds: retryAfterSeconds });
    return;
  }

  // Log every emergency call to the error_log so the owner can see usage patterns.
  // Source='emergency-proxy' makes these easy to filter in /logs/recent.
  void writeErrorLog({
    route:   "/api/ai/proxy/emergency",
    method:  "POST",
    message: `Emergency proxy call from ${sourceIp} (model_hint: ${model_hint ?? "none"})`,
    source:  "emergency-proxy",
  });

  // Provider cascade — explicit order, not role-ranked
  const env = process.env;
  const cascade: Array<() => Promise<{ text: string; provider: string }>> = [
    // 1. ZomBrains' shared Groq — fastest, generous limits
    () => emergencyOpenAI(
      "https://api.groq.com/openai/v1/chat/completions",
      env["GROQ_API_KEY"], "llama-3.3-70b-versatile", messages,
    ).then(r => ({ ...r, provider: "emergency-groq-shared" })),

    // 2. Birthday Bot idle keys (excluding BIRTHDAY_GROQ — Birthday Bot's primary)
    () => emergencyCerebras(env["BIRTHDAY_CEREBRAS"], messages)
      .then(r => ({ ...r, provider: "emergency-birthday-cerebras" })),
    () => emergencyOpenAI(
      "https://api.sambanova.ai/v1/chat/completions",
      env["BIRTHDAY_SAMBANOVA"], "Meta-Llama-3.3-70B-Instruct", messages,
    ).then(r => ({ ...r, provider: "emergency-birthday-sambanova" })),
    () => (async () => {
      // Gemini has a different API shape — inline call
      const key = env["BIRTHDAY_GEMINI"];
      if (!key) throw new Error("no_key");
      const sys      = (messages as Array<{ role: string; content: string }>).find(x => x.role === "system")?.content ?? "";
      const contents = (messages as Array<{ role: string; content: string }>)
        .filter(x => x.role !== "system")
        .map(x => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.content }] }));
      const body: Record<string, unknown> = { contents, generationConfig: { temperature: 0.2, maxOutputTokens: 2048 } };
      if (sys) body.systemInstruction = { parts: [{ text: sys }] };
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000) },
      );
      if (r.status === 429) throw new Error("rate_limited");
      if (!r.ok) throw new Error(`Gemini HTTP ${r.status}`);
      const j = await r.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      return { text: j.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "", provider: "emergency-birthday-gemini" };
    })(),
    () => emergencyOpenAI(
      "https://api.mistral.ai/v1/chat/completions",
      env["BIRTHDAY_MISTRAL"], "mistral-small-latest", messages,
    ).then(r => ({ ...r, provider: "emergency-birthday-mistral" })),

    // 3. Remaining shared keys
    () => emergencyCerebras(env["CEREBRAS_API_KEY"], messages)
      .then(r => ({ ...r, provider: "emergency-cerebras-shared" })),
    () => emergencyOpenAI(
      "https://api.mistral.ai/v1/chat/completions",
      env["MISTRAL_API_KEY"], "mistral-small-latest", messages,
    ).then(r => ({ ...r, provider: "emergency-mistral-shared" })),
  ];

  let lastError = "All emergency providers exhausted";
  for (const attempt of cascade) {
    try {
      const result = await attempt();
      res.json({ ok: true, content: result.text, provider: result.provider, emergency: true });
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "no_key") continue;      // key not configured — skip silently
      if (msg === "rate_limited") continue; // provider cooling — try next
      lastError = msg;
    }
  }

  res.status(503).json({ ok: false, error: lastError, emergency: true });
});

export default router;
