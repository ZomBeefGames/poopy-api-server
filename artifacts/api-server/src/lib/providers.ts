import { logger } from "./logger.js";
import { emitCrystal } from "./crystalEmit.js";
import { getToolDefs, executeTool, registerTool } from "./clusterTools.js";

export type Msg = { role: string; content: string };

// ── Key aliasing — use dedicated API_*_API_KEY, shared, or POOPY_* as fallbacks ─
// Priority: API_GROQ_API_KEY > GROQ_API_KEY > POOPY_GROQ_API_KEY (etc.)
// The _API_KEY suffix variants are the "per-bot dedicated account" keys.
if (!process.env["API_GROQ"]       && process.env["API_GROQ_API_KEY"])       process.env["API_GROQ"]       = process.env["API_GROQ_API_KEY"];
if (!process.env["API_CEREBRAS"]   && process.env["API_CEREBRAS_API_KEY"])   process.env["API_CEREBRAS"]   = process.env["API_CEREBRAS_API_KEY"];
if (!process.env["API_GEMINI"]     && process.env["API_GEMINI_API_KEY"])     process.env["API_GEMINI"]     = process.env["API_GEMINI_API_KEY"];
// Only adopt API_OPENROUTER_API_KEY if it's a valid OR key (sk-or-v1- prefix) —
// the current secret value is a non-OR key that causes 401s; fall through to OPENROUTER_API_KEY
if (!process.env["API_OPENROUTER"] && process.env["API_OPENROUTER_API_KEY"]?.startsWith("sk-or-v1-")) process.env["API_OPENROUTER"] = process.env["API_OPENROUTER_API_KEY"];
if (!process.env["API_DEEPSEEK"]   && process.env["DEEPSEEK_API_KEY"])   process.env["API_DEEPSEEK"]   = process.env["DEEPSEEK_API_KEY"];
if (!process.env["API_MISTRAL"]    && process.env["API_MISTRAL_API_KEY"])    process.env["API_MISTRAL"]    = process.env["API_MISTRAL_API_KEY"];
if (!process.env["API_SAMBANOVA"]  && process.env["API_SAMBANOVA_API_KEY"])  process.env["API_SAMBANOVA"]  = process.env["API_SAMBANOVA_API_KEY"];
// Birthday bot dedicated keys
if (!process.env["BIRTHDAY_GROQ"]       && process.env["BIRTHDAY_GROQ_API_KEY"])       process.env["BIRTHDAY_GROQ"]       = process.env["BIRTHDAY_GROQ_API_KEY"];
if (!process.env["BIRTHDAY_CEREBRAS"]   && process.env["BIRTHDAY_CEREBRAS_API_KEY"])   process.env["BIRTHDAY_CEREBRAS"]   = process.env["BIRTHDAY_CEREBRAS_API_KEY"];
if (!process.env["BIRTHDAY_GEMINI"]     && process.env["BIRTHDAY_GEMINI_API_KEY"])     process.env["BIRTHDAY_GEMINI"]     = process.env["BIRTHDAY_GEMINI_API_KEY"];
if (!process.env["BIRTHDAY_OPENROUTER"] && process.env["BIRTHDAY_OPENROUTER_API_KEY"]) process.env["BIRTHDAY_OPENROUTER"] = process.env["BIRTHDAY_OPENROUTER_API_KEY"];
if (!process.env["BIRTHDAY_SAMBANOVA"]  && process.env["BIRTHDAY_SAMBANOVA_API_KEY"])  process.env["BIRTHDAY_SAMBANOVA"]  = process.env["BIRTHDAY_SAMBANOVA_API_KEY"];
if (!process.env["BIRTHDAY_MISTRAL"]   && process.env["BIRTHDAY_MISTRAL_API_KEY"])   process.env["BIRTHDAY_MISTRAL"]   = process.env["BIRTHDAY_MISTRAL_API_KEY"];

for (const [api, shared, poopy] of [
  ["API_GROQ",        "GROQ_API_KEY",        "POOPY_GROQ_API_KEY"],
  ["API_CEREBRAS",    "CEREBRAS_API_KEY",    "POOPY_CEREBRAS_API_KEY"],
  ["API_GEMINI",      "GEMINI_API_KEY",      "POOPY_GEMINI_API_KEY"],
  ["API_OPENROUTER",  "OPENROUTER_API_KEY",  "POOPY_OPENROUTER_API_KEY"],
  ["API_MISTRAL",     "MISTRAL_API_KEY",     "POOPY_MISTRAL_API_KEY"],
  ["API_SAMBANOVA",   "SAMBANOVA_API_KEY",   "POOPY_SAMBANOVA_API_KEY"],
  ["SAMBANOVA_API_KEY",  "", "POOPY_SAMBANOVA_API_KEY"],
  ["MISTRAL_API_KEY",    "", "POOPY_MISTRAL_API_KEY"],
  ["OPENROUTER_API_KEY", "", "POOPY_OPENROUTER_API_KEY"],
] as const) {
  if (!process.env[api]) {
    if (shared && process.env[shared]) process.env[api] = process.env[shared];
    else if (poopy && process.env[poopy]) process.env[api] = process.env[poopy];
  }
}

// ── Call event log ─────────────────────────────────────────────────────────────
// Ring buffer of the last MAX_EVENTS call attempts. Includes both api-server's own
// calls and ZomBrains-reported events (POSTed back via /api/providers/call-event).
// outcome values:
//   success         — call completed and returned a result
//   rate_limited    — provider returned 429
//   error           — call threw a non-429 error
//   skipped_cooldown  — slot was cooling down, skipped entirely
//   skipped_no_key    — env var for this slot is not set
//   skipped_role      — slot lacks a required role (hard-excluded by specialization)
//   skipped_broken    — slot has been marked broken (auth failure)

export type CallOutcome =
  | "success"
  | "rate_limited"
  | "error"
  | "skipped_cooldown"
  | "skipped_no_key"
  | "skipped_role"
  | "skipped_broken";

export type CallEvent = {
  id:         string;
  ts:         number;        // Date.now()
  source:     "api-server" | "zombrains" | "poopy";
  slot:       string;        // e.g. "groq", "poopy-gemini", "api-cerebras"
  outcome:    CallOutcome;
  reason?:    string;        // error message or skip reason
  tokens?:    number;
  latencyMs?: number;
  taskId?:    string;        // ZomBrains task ID if provided
  rolesRequired?: string[];
  rolesPreferred?: string[];
};

const MAX_EVENTS = 1000;
const _callLog: CallEvent[] = [];
let   _callLogIdx = 0;

export function logCall(ev: Omit<CallEvent, "id" | "ts">): void {
  const event: CallEvent = { id: `e${++_callLogIdx}`, ts: Date.now(), ...ev };
  if (_callLog.length < MAX_EVENTS) {
    _callLog.push(event);
  } else {
    _callLog[_callLogIdx % MAX_EVENTS] = event;
  }
}

export function getCallLog(): CallEvent[] {
  return [..._callLog].sort((a, b) => b.ts - a.ts);
}

// ── Per-slot cooldown tracking ────────────────────────────────────────────────
const _cooldowns = new Map<string, number>();
function isCooling(name: string): boolean {
  const until = _cooldowns.get(name);
  if (!until) return false;
  if (Date.now() > until) { _cooldowns.delete(name); return false; }
  return true;
}
function cool(name: string, ms: number): void {
  _cooldowns.set(name, Date.now() + ms);
}
export function getCooldownMs(name: string): number {
  const until = _cooldowns.get(name);
  return until ? Math.max(0, until - Date.now()) : 0;
}

// ── Token usage tracking ───────────────────────────────────────────────────────
type TokenBucket = { prompt: number; completion: number; total: number; calls: number };

const _stats: { byProvider: Map<string, TokenBucket>; resetAt: string } = {
  byProvider: new Map(),
  resetAt: new Date().toISOString(),
};

export function recordTokens(provider: string, u: { prompt: number; completion: number; total: number }): void {
  const b = _stats.byProvider.get(provider) ?? { prompt: 0, completion: 0, total: 0, calls: 0 };
  b.prompt     += u.prompt;
  b.completion += u.completion;
  b.total      += u.total;
  b.calls++;
  _stats.byProvider.set(provider, b);
}

export function getWorkerStats(): { byProvider: Map<string, TokenBucket>; resetAt: string } {
  return _stats;
}

// ── OpenAI-compatible single call ─────────────────────────────────────────────
type OpenAIResp = {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

export async function openAICall(
  url: string, key: string, model: string, messages: Msg[],
): Promise<{ text: string; usage: { prompt: number; completion: number; total: number } }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 4096 }),
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 429) throw new Error("rate_limited");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json() as OpenAIResp;
  return {
    text:  j.choices?.[0]?.message?.content ?? "",
    usage: {
      prompt:     j.usage?.prompt_tokens     ?? 0,
      completion: j.usage?.completion_tokens ?? 0,
      total:      j.usage?.total_tokens      ?? 0,
    },
  };
}

// ── Provider slot definitions — TEXT (non-tool) slots ─────────────────────────
// Three tiers per provider family:
//   (1) direct shared  — uses the same key Railway's ZomBrains uses directly
//   (2) api-* dedicated — uses API_<PROVIDER> dedicated key (separate rate-limit bucket)
//   (3) poopy-*        — uses POOPY_<PROVIDER>_API_KEY (ZomBrains' shared proxy pool)
// Result: up to 18 text slots covering 3 independent rate-limit pools per provider.

type TextSlot = {
  name:   string;
  base:   string;
  envKey: string;
  call:   (key: string, messages: Msg[]) => Promise<{ text: string; usage: { prompt: number; completion: number; total: number } }>;
};

function geminiTextCall(key: string, messages: Msg[]): Promise<{ text: string; usage: { prompt: number; completion: number; total: number } }> {
  const system   = messages.find(x => x.role === "system")?.content ?? "";
  const contents = messages.filter(x => x.role !== "system")
    .map(x => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.content }] }));
  const body: Record<string, unknown> = { contents, generationConfig: { temperature: 0.2, maxOutputTokens: 4096 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) },
  ).then(async r => {
    if (r.status === 429) throw new Error("rate_limited");
    if (!r.ok) throw new Error(`Gemini HTTP ${r.status}`);
    const j = await r.json() as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
    };
    return {
      text:  j.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "",
      usage: { prompt: j.usageMetadata?.promptTokenCount ?? 0, completion: j.usageMetadata?.candidatesTokenCount ?? 0, total: j.usageMetadata?.totalTokenCount ?? 0 },
    };
  });
}

function cerebrasFallback(key: string, messages: Msg[]): Promise<{ text: string; usage: { prompt: number; completion: number; total: number } }> {
  return openAICall("https://api.cerebras.ai/v1/chat/completions", key, "gpt-oss-120b", messages)
    .catch(e => {
      if ((e as Error).message === "rate_limited") throw e;
      return openAICall("https://api.cerebras.ai/v1/chat/completions", key, "zai-glm-4.7", messages);
    });
}

const TEXT_SLOTS: TextSlot[] = [
  // ── API_* dedicated keys — api-server's own accounts only ───────────────────
  // groq-paid before api-groq so the paid quota is consumed first
  { name: "groq-paid",      base: "groq",      envKey: "GROQ_API_KEY",         call: (k, m) => openAICall("https://api.groq.com/openai/v1/chat/completions", k, "llama-3.3-70b-versatile", m) },
  { name: "api-groq",       base: "groq",      envKey: "API_GROQ",             call: (k, m) => openAICall("https://api.groq.com/openai/v1/chat/completions", k, "llama-3.3-70b-versatile", m) },
  { name: "video-groq",     base: "groq",      envKey: "VIDEO_GROQ_API_KEY",   call: (k, m) => openAICall("https://api.groq.com/openai/v1/chat/completions", k, "llama-3.3-70b-versatile", m) },
  { name: "api-cerebras",   base: "cerebras",  envKey: "API_CEREBRAS",         call: cerebrasFallback },
  { name: "cerebras2",      base: "cerebras",  envKey: "CEREBRAS2_API_KEY",    call: cerebrasFallback },
  { name: "feather",        base: "feather",   envKey: "FEATHER_API_KEY",      call: (k, m) => openAICall("https://api.featherless.ai/v1/chat/completions", k, "Qwen/Qwen2.5-72B-Instruct", m) },
  { name: "api-gemini",     base: "gemini",    envKey: "API_GEMINI",           call: geminiTextCall },
  { name: "api-openrouter", base: "openrouter",envKey: "API_OPENROUTER",       call: (k, m) => openAICall("https://openrouter.ai/api/v1/chat/completions", k, "meta-llama/llama-3.3-70b-instruct:free", m) },
  { name: "openai-or",      base: "openrouter",envKey: "OPENAI_API_KEY",       call: (k, m) => openAICall("https://openrouter.ai/api/v1/chat/completions", k, "meta-llama/llama-3.3-70b-instruct:free", m) },
  { name: "api-mistral",    base: "mistral",   envKey: "API_MISTRAL",          call: (k, m) => openAICall("https://api.mistral.ai/v1/chat/completions", k, "mistral-large-latest", m) },
  { name: "api-sambanova",  base: "sambanova", envKey: "API_SAMBANOVA",        call: (k, m) => openAICall("https://api.sambanova.ai/v1/chat/completions", k, "Meta-Llama-3.3-70B-Instruct", m) },
  { name: "deepseek",       base: "deepseek",  envKey: "API_DEEPSEEK",         call: (k, m) => openAICall("https://api.deepseek.com/v1/chat/completions", k, "deepseek-chat", m) },
];

// ── Role registry ─────────────────────────────────────────────────────────────
// Grades: S=4  A=3  B=2  C=1  (absent = 0 → hard-excluded for that role)
// Roles: tool_call · code · reasoning · creative · long_context · fast
const REGISTRY: Record<string, Record<string, number>> = {
  // ── API_* dedicated slots — api-server's own accounts only ─────────────────
  "groq-paid":       { tool_call: 3, code: 3, reasoning: 3, fast: 3 },
  "api-groq":        { tool_call: 3, code: 3, reasoning: 3, fast: 3 },
  "video-groq":      { tool_call: 3, code: 3, reasoning: 3, fast: 3 },
  "api-cerebras":    { tool_call: 2, code: 2, fast: 4 },
  "cerebras2":       { tool_call: 2, code: 2, fast: 4 },
  "feather":         { tool_call: 1, code: 3, reasoning: 3 },
  "api-gemini":      { tool_call: 2, code: 2, long_context: 3, fast: 2 },
  "api-openrouter":  { tool_call: 2, code: 2, reasoning: 2 },
  "openai-or":       { tool_call: 2, code: 2, reasoning: 2 },
  "api-mistral":     { creative: 3, reasoning: 2, tool_call: 1 },
  "api-sambanova":   { fast: 2 },
  "deepseek":        { tool_call: 3, code: 4, reasoning: 4 },
};

function detectTaskRoles(messages: Msg[], tools?: ToolDef[]): { required: Set<string>; preferred: string[] } {
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content?.toLowerCase() ?? "";
  const required = new Set<string>();
  const preferred: string[] = [];
  if (tools && tools.length > 0) required.add("tool_call");
  if (/lyric|song|poem|story|creative|brainstorm/.test(lastUser))         preferred.push("creative");
  else if (/refactor|architect|multi.*file|entire.*file/.test(lastUser))  preferred.push("code", "reasoning");
  else if (tools && tools.length > 0)                                      preferred.push("code", "reasoning");
  else if (lastUser.length < 120 && required.size === 0)                  preferred.push("fast");
  else                                                                      preferred.push("reasoning", "code");
  return { required, preferred };
}

function rankSlots<T extends { name: string; base: string }>(
  slots: T[], required: Set<string>, preferred: string[], hint?: string,
): T[] {
  const eligible = slots.filter(s => {
    for (const role of required) {
      if (!(REGISTRY[s.name]?.[role] ?? 0)) return false;
    }
    return true;
  });
  const score = (name: string) => preferred.reduce((sum, r) => sum + (REGISTRY[name]?.[r] ?? 0), 0);
  eligible.sort((a, b) => score(b.name) - score(a.name));
  if (!hint) return eligible;
  const hintBase = hint.replace(/^(?:poopy|api)-/, "");
  return [
    ...eligible.filter(s => s.name === hint),
    ...eligible.filter(s => s.name !== hint && s.base === hintBase),
    ...eligible.filter(s => s.base !== hintBase),
  ];
}

export async function callProvider(
  messages: Msg[], hint?: string,
  meta?: { source?: CallEvent["source"]; taskId?: string },
): Promise<{ result: string; provider: string; tokens: number; usage: { prompt: number; completion: number; total: number } }> {
  const { required, preferred } = detectTaskRoles(messages);
  const source = meta?.source ?? "api-server";
  const taskId = meta?.taskId;
  const rolesRequired  = [...required];
  const rolesPreferred = [...preferred];

  for (const slot of TEXT_SLOTS) {
    if (!process.env[slot.envKey]) {
      logCall({ source, slot: slot.name, outcome: "skipped_no_key", taskId, rolesRequired, rolesPreferred });
      continue;
    }
    const hasRole = [...required].every(r => !!(REGISTRY[slot.name]?.[r] ?? 0));
    if (!hasRole) {
      logCall({ source, slot: slot.name, outcome: "skipped_role", reason: `missing required: ${[...required].join(",")}`, taskId, rolesRequired, rolesPreferred });
      continue;
    }
    if (isCooling(slot.name)) {
      logCall({ source, slot: slot.name, outcome: "skipped_cooldown", reason: `${getCooldownMs(slot.name)}ms remaining`, taskId, rolesRequired, rolesPreferred });
      continue;
    }
  }

  const available = TEXT_SLOTS.filter(s => !isCooling(s.name) && !!process.env[s.envKey]);
  const ordered   = rankSlots(available, required, preferred, hint);

  for (const slot of ordered) {
    const t0 = Date.now();
    try {
      const { text, usage } = await slot.call(process.env[slot.envKey]!, messages);
      const latencyMs = Date.now() - t0;
      recordTokens(slot.name, usage);
      logCall({ source, slot: slot.name, outcome: "success", tokens: usage.total || Math.ceil(text.length / 4), latencyMs, taskId, rolesRequired, rolesPreferred });
      // #629: zero-token crystal — fire-and-forget, never blocks the caller
      emitCrystal({ type: "success", domain: "coding", sourceType: "api-proxy", provider: slot.name, tokenCount: usage.total || Math.ceil(text.length / 4), latencyMs, qualityScore: null, taskId: taskId ?? null });
      return { result: text, provider: slot.name, tokens: usage.total || Math.ceil(text.length / 4), usage };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "rate_limited") {
        cool(slot.name, 60_000);
        logCall({ source, slot: slot.name, outcome: "rate_limited", latencyMs: Date.now() - t0, taskId, rolesRequired, rolesPreferred });
      } else {
        // Cool persistent failures so we don't hammer known-broken providers every call
        if (/HTTP 403|HTTP 404/.test(msg)) cool(slot.name, 3_600_000); // 1 hour — auth/not-found
        else if (/HTTP 413|HTTP 400/.test(msg)) cool(slot.name, 300_000); // 5 min — payload/bad-req
        logCall({ source, slot: slot.name, outcome: "error", reason: msg, latencyMs: Date.now() - t0, taskId, rolesRequired, rolesPreferred });
        logger.warn({ slot: slot.name, err: msg }, "provider call failed");
      }
    }
  }
  throw new Error("No providers available or all rate-limited");
}

// Returns all active slot names in the ZomBrains-compatible naming scheme.
// ZomBrains uses this to know which proxy slots are available via /api/ai/proxy.
export function getActiveSlotNames(): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const slot of TEXT_SLOTS) {
    if (!process.env[slot.envKey]) continue;
    if (!seen.has(slot.name)) { seen.add(slot.name); names.push(slot.name); }
  }
  names.push("poopy-api"); // Poopy AI cluster always available as a proxy
  return names;
}

export const PROVIDER_KEYS: Array<[string, string[]]> = [
  ["groq",       ["GROQ_API_KEY",       "API_GROQ",         "POOPY_GROQ_API_KEY",       "BIRTHDAY_GROQ"]],
  ["groq-paid",  ["GROQ_API_KEY"]],
  ["video-groq", ["VIDEO_GROQ_API_KEY"]],
  ["cerebras",   ["CEREBRAS_API_KEY",   "API_CEREBRAS",     "CEREBRAS2_API_KEY",        "BIRTHDAY_CEREBRAS"]],
  ["sambanova",  ["SAMBANOVA_API_KEY",  "API_SAMBANOVA",    "POOPY_SAMBANOVA_API_KEY",  "BIRTHDAY_SAMBANOVA"]],
  ["gemini",     ["GEMINI_API_KEY",     "API_GEMINI",       "POOPY_GEMINI_API_KEY",     "BIRTHDAY_GEMINI"]],
  ["mistral",    ["MISTRAL_API_KEY",    "API_MISTRAL",      "POOPY_MISTRAL_API_KEY",    "BIRTHDAY_MISTRAL"]],
  ["openrouter", ["OPENROUTER_API_KEY", "API_OPENROUTER",   "POOPY_OPENROUTER_API_KEY", "BIRTHDAY_OPENROUTER"]],
  ["openai-or",  ["OPENAI_API_KEY"]],
  ["feather",    ["FEATHER_API_KEY"]],
  ["deepseek",   ["DEEPSEEK_API_KEY",   "API_DEEPSEEK"]],
];

// ── Tool-call-capable proxy ────────────────────────────────────────────────────
export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
export type ToolCall = {
  id: string; type: "function"; function: { name: string; arguments: string };
};

type OpenAIToolResp = {
  choices: Array<{ message: { content: string | null; tool_calls?: ToolCall[] } }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

async function openAICallWithTools(
  url: string, key: string, model: string, messages: Msg[], tools: ToolDef[],
): Promise<{ content: string; toolCalls: ToolCall[]; usage: { prompt: number; completion: number; total: number } }> {
  const body: Record<string, unknown> = { model, messages, temperature: 0.2, max_tokens: 4096 };
  if (tools.length) { body.tools = tools; body.tool_choice = "auto"; }
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 429) throw new Error("rate_limited");
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`);
  }
  const j = await r.json() as OpenAIToolResp;
  const msg = j.choices?.[0]?.message;
  return {
    content:   msg?.content ?? "",
    toolCalls: msg?.tool_calls ?? [],
    usage: {
      prompt:     j.usage?.prompt_tokens     ?? 0,
      completion: j.usage?.completion_tokens ?? 0,
      total:      j.usage?.total_tokens      ?? 0,
    },
  };
}

type ToolSlot = {
  name:        string;
  base:        string;
  envKey:      string;
  url:         string;
  models:      string[];
  maxDescLen?: number; // Truncate tool+param descriptions before sending (fixes HTTP 413 on Groq)
  maxToolCount?: number; // Hard cap on number of tools sent (Groq rejects >128)
};

// ── Tool-capable slots — API_* dedicated keys only ───────────────────────────
// api-server uses only its own API_* accounts. No cross-bot key borrowing.
const TOOL_SLOTS: ToolSlot[] = [
  { name: "groq-paid",      base: "groq",       envKey: "GROQ_API_KEY",           url: "https://api.groq.com/openai/v1/chat/completions",                         models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"], maxDescLen: 100, maxToolCount: 128 },
  { name: "groq",           base: "groq",       envKey: "API_GROQ",               url: "https://api.groq.com/openai/v1/chat/completions",                         models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"], maxDescLen: 100, maxToolCount: 128 },
  { name: "video-groq",     base: "groq",       envKey: "VIDEO_GROQ_API_KEY",     url: "https://api.groq.com/openai/v1/chat/completions",                         models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"], maxDescLen: 100, maxToolCount: 128 },
  { name: "cerebras",       base: "cerebras",   envKey: "API_CEREBRAS",           url: "https://api.cerebras.ai/v1/chat/completions",                             models: ["gpt-oss-120b", "zai-glm-4.7"] },
  { name: "cerebras2",      base: "cerebras",   envKey: "CEREBRAS2_API_KEY",      url: "https://api.cerebras.ai/v1/chat/completions",                             models: ["gpt-oss-120b", "zai-glm-4.7"] },
  { name: "feather",        base: "feather",    envKey: "FEATHER_API_KEY",        url: "https://api.featherless.ai/v1/chat/completions",                          models: ["Qwen/Qwen2.5-72B-Instruct", "meta-llama/Llama-3.2-3B-Instruct"] },
  { name: "gemini",         base: "gemini",     envKey: "API_GEMINI",             url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", models: ["gemini-2.0-flash"] },
  { name: "openrouter",     base: "openrouter", envKey: "API_OPENROUTER",         url: "https://openrouter.ai/api/v1/chat/completions",                           models: ["meta-llama/llama-3.3-70b-instruct"] },
  { name: "openai-or",      base: "openrouter", envKey: "OPENAI_API_KEY",         url: "https://openrouter.ai/api/v1/chat/completions",                           models: ["meta-llama/llama-3.3-70b-instruct"] },
  { name: "mistral",        base: "mistral",    envKey: "API_MISTRAL",            url: "https://api.mistral.ai/v1/chat/completions",                              models: ["mistral-small-latest", "mistral-large-latest"] },
  { name: "sambanova",      base: "sambanova",  envKey: "API_SAMBANOVA",          url: "https://api.sambanova.ai/v1/chat/completions",                            models: ["Meta-Llama-3.3-70B-Instruct"] },
  { name: "deepseek",       base: "deepseek",   envKey: "API_DEEPSEEK",           url: "https://api.deepseek.com/v1/chat/completions",                            models: ["deepseek-chat", "deepseek-reasoner"] },
];

/**
 * callProviderAgentic — full agentic tool-call loop for the cluster AI.
 *
 * Gives the AI access to all cluster tools (built-in + registered custom ones).
 * If the AI calls `create_tool`, the new tool is registered immediately and
 * becomes available in the very next iteration — no restart needed.
 *
 * Returns a plain text result suitable for Discord / the /ask endpoint.
 */
export async function callProviderAgentic(
  messages: Msg[],
  hint?: string,
  meta?: { source?: CallEvent["source"]; taskId?: string },
  opts?: { maxIterations?: number },
): Promise<{ result: string; provider: string; tokens: number; toolsUsed: string[]; toolsCreated: string[] }> {
  const maxIter     = opts?.maxIterations ?? 5;
  const toolsUsed:    string[] = [];
  const toolsCreated: string[] = [];

  // Working message list — uses a wider type to hold tool-call messages
  const agentMsgs: unknown[] = [...messages];
  let totalTokens = 0;
  let lastProvider = "unknown";

  for (let iter = 0; iter < maxIter; iter++) {
    const toolDefs = getToolDefs(); // refresh each iteration — new tools available immediately

    let res: Awaited<ReturnType<typeof callProviderWithTools>>;
    try {
      res = await callProviderWithTools(agentMsgs as Msg[], toolDefs, hint, meta);
    } catch {
      // Tool-capable providers all failed — fall back to plain text
      break;
    }

    totalTokens  += res.usage.total;
    lastProvider  = res.provider;

    if (!res.toolCalls || res.toolCalls.length === 0) {
      // No tool calls → final answer
      return {
        result:       res.content || "[No response]",
        provider:     lastProvider,
        tokens:       totalTokens,
        toolsUsed,
        toolsCreated,
      };
    }

    // Append the assistant turn (with tool_calls) to history
    agentMsgs.push({ role: "assistant", content: res.content ?? null, tool_calls: res.toolCalls });

    // Execute each tool call and append results
    for (const tc of res.toolCalls) {
      const toolName = tc.function.name;
      let toolArgs: Record<string, unknown> = {};
      try { toolArgs = JSON.parse(tc.function.arguments || "{}"); } catch { /* keep empty */ }

      toolsUsed.push(toolName);

      let toolResult: unknown;

      if (toolName === "create_tool") {
        // Meta-tool: register the new tool so it's available in the next iteration
        try {
          registerTool({
            name:        String(toolArgs.name        ?? ""),
            description: String(toolArgs.description ?? ""),
            parameters:  (toolArgs.parameters as Record<string, unknown>) ?? {},
            code:        String(toolArgs.code        ?? ""),
            created_by:  "cluster",
          });
          toolsCreated.push(String(toolArgs.name ?? ""));
          toolResult = { ok: true, message: `Tool '${toolArgs.name}' registered. You can call it now.`, name: toolArgs.name };
        } catch (e) {
          toolResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      } else {
        toolResult = await executeTool(toolName, toolArgs);
      }

      agentMsgs.push({
        role:         "tool",
        tool_call_id: tc.id,
        content:      typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
      });
    }
  }

  // Max iterations hit or tool providers failed — finish with a plain-text call
  try {
    const final = await callProvider(agentMsgs as Msg[], hint, meta);
    totalTokens += final.tokens;
    return { result: final.result, provider: final.provider, tokens: totalTokens, toolsUsed, toolsCreated };
  } catch (e) {
    throw new Error(`Agentic loop exhausted and final text call also failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function callProviderWithTools(
  messages: Msg[], tools: ToolDef[], hint?: string,
  meta?: { source?: CallEvent["source"]; taskId?: string },
): Promise<{ content: string; toolCalls: ToolCall[]; provider: string; usage: { prompt: number; completion: number; total: number } }> {
  // Strip orphaned role:"tool" messages — tool results whose tool_call_id doesn't appear in
  // any preceding assistant tool_calls. Happens when ZomBrains retries with a different provider
  // after a partial execution: the message history has IDs from provider A, but provider B
  // never generated them → HTTP 400 "Unexpected tool call id". Strip before any provider sees it.
  const knownToolCallIds = new Set<string>();
  const cleanMessages = messages.filter(m => {
    if (m.role === "assistant" && Array.isArray((m as Record<string, unknown>)["tool_calls"])) {
      for (const tc of (m as Record<string, unknown>)["tool_calls"] as Array<{ id?: string }>) {
        if (tc.id) knownToolCallIds.add(tc.id);
      }
    }
    if (m.role === "tool") {
      const tcId = (m as Record<string, unknown>)["tool_call_id"] as string | undefined;
      return tcId ? knownToolCallIds.has(tcId) : false;
    }
    return true;
  });

  const { preferred } = detectTaskRoles(cleanMessages, tools);
  const required      = new Set(["tool_call"]);
  const source        = meta?.source ?? "api-server";
  const taskId        = meta?.taskId;
  const rolesRequired  = [...required];
  const rolesPreferred = [...preferred];

  // Log all slots that won't be tried and why
  for (const slot of TOOL_SLOTS) {
    if (!process.env[slot.envKey]) {
      logCall({ source, slot: slot.name, outcome: "skipped_no_key", taskId, rolesRequired, rolesPreferred });
      continue;
    }
    const hasRole = !!(REGISTRY[slot.name]?.["tool_call"] ?? 0);
    if (!hasRole) {
      logCall({ source, slot: slot.name, outcome: "skipped_role", reason: "no tool_call grade", taskId, rolesRequired, rolesPreferred });
      continue;
    }
    if (isCooling(slot.name)) {
      logCall({ source, slot: slot.name, outcome: "skipped_cooldown", reason: `${getCooldownMs(slot.name)}ms remaining`, taskId, rolesRequired, rolesPreferred });
    }
  }

  const trySlots = async () => {
    const available = TOOL_SLOTS.filter(s => !isCooling(s.name) && !!process.env[s.envKey]);
    const ordered   = rankSlots(available, required, preferred, hint);

    for (const slot of ordered) {
      // Truncate tool+param descriptions for slots with a body-size limit (e.g. Groq HTTP 413).
      // Only truncates descriptions that EXIST and are longer than the limit — never injects
      // empty strings, which can cause HTTP 400 schema-validation errors on some providers.
      let slotTools: ToolDef[] = slot.maxDescLen
        ? tools.map(t => ({
            ...t,
            function: {
              ...t.function,
              ...(typeof t.function.description === "string" && t.function.description.length > slot.maxDescLen!
                ? { description: t.function.description.slice(0, slot.maxDescLen) }
                : {}),
              parameters: (() => {
                const params = t.function.parameters as Record<string, unknown> | undefined;
                if (!params) return {} as Record<string, unknown>;
                const origProps = params.properties as Record<string, Record<string, unknown>> | undefined;
                if (!origProps) return params;
                const anyLong = Object.values(origProps).some(
                  v => typeof v.description === "string" && v.description.length > slot.maxDescLen!,
                );
                if (!anyLong) return params;
                const newProps = Object.fromEntries(
                  Object.entries(origProps).map(([k, v]) => [
                    k,
                    typeof v.description === "string" && v.description.length > slot.maxDescLen!
                      ? { ...v, description: v.description.slice(0, slot.maxDescLen) }
                      : v,
                  ]),
                );
                return { ...params, properties: newProps };
              })(),
            },
          }))
        : tools;
      if (slot.maxToolCount && slotTools.length > slot.maxToolCount) {
        slotTools = slotTools.slice(0, slot.maxToolCount);
      }

      for (const model of slot.models) {
        const t0 = Date.now();
        try {
          const res = await openAICallWithTools(slot.url, process.env[slot.envKey]!, model, cleanMessages, slotTools);
          const latencyMs = Date.now() - t0;
          recordTokens(slot.name, res.usage);
          logCall({ source, slot: slot.name, outcome: "success", tokens: res.usage.total, latencyMs, taskId, rolesRequired, rolesPreferred });
          return { ...res, provider: slot.name };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "rate_limited") {
            cool(slot.name, 10_000); // 10s cooldown on rate-limit; caller retries at the task level
            logCall({ source, slot: slot.name, outcome: "rate_limited", latencyMs: Date.now() - t0, taskId, rolesRequired, rolesPreferred });
            logger.warn({ slot: slot.name, model }, "tool proxy rate limited");
            break;
          }
          logCall({ source, slot: slot.name, outcome: "error", reason: `${model}: ${msg}`, latencyMs: Date.now() - t0, taskId, rolesRequired, rolesPreferred });
          logger.warn({ slot: slot.name, model, err: msg }, "tool proxy call failed");
          // Cool persistent failures so we don't hammer known-broken providers every call
          if (/HTTP 403|HTTP 404/.test(msg)) { cool(slot.name, 3_600_000); break; } // 1 hour
          if (/HTTP 413|HTTP 400/.test(msg)) { cool(slot.name, 300_000);   break; } // 5 min
          if (/HTTP 503/.test(msg))          { cool(slot.name, 300_000);   break; } // 5 min — service down, skip remaining models
          if (/timeout|aborted/i.test(msg))  { cool(slot.name, 300_000);   break; } // 5 min
        }
      }
    }
    return null;
  };

  const result = await trySlots();
  if (result) return result;

  // All slots failed — fail fast so Replit's reverse proxy does not time out (502).
  // ZomBrains and Poopy both handle 503 by pausing the task and retrying later;
  // a 35-second in-process wait only converts a 503 into a 502 from Replit's side.
  // Providers with 403/404/413/503 are already on hours/minutes cooldown individually,
  // so a blind retry here would hit the same walls anyway.
  const coolingSlots = TOOL_SLOTS
    .filter(s => !!process.env[s.envKey] && !!(REGISTRY[s.name]?.["tool_call"] ?? 0))
    .map(s => ({ name: s.name, remainingMs: getCooldownMs(s.name) }))
    .filter(s => s.remainingMs > 0);
  const shortCool  = coolingSlots.filter(s => s.remainingMs <=  65_000);
  const longCool   = coolingSlots.filter(s => s.remainingMs >   65_000);
  if (coolingSlots.length > 0) {
    logger.warn(
      {
        coolCount: coolingSlots.length,
        shortCool: shortCool.map(s => `${s.name}(${Math.ceil(s.remainingMs / 1000)}s)`),
        longCool:  longCool.map(s => `${s.name}(${Math.ceil(s.remainingMs / 1000)}s)`),
      },
      "tool proxy: no available slots — returning 503",
    );
  }

  throw new Error("No tool-capable providers available");
}
