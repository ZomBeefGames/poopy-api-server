/**
 * In-process API Worker
 *
 * Runs alongside the api-server HTTP listener — no separate workflow needed.
 * Polls /api/zombrains/worker-queue for saga steps tagged executor:"api-worker",
 * executes them via /api/ai/proxy (using api-server's own quota pools), and
 * reports results back. No filesystem access — pure AI calls.
 *
 * Started once from index.ts after server.listen() succeeds.
 */

import { logger } from "./logger.js";

const EXEC    = process.env.WORKER_EXECUTOR    || "api-worker";
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 30_000);
const HB_MS   = 60_000;
const AUTH    = process.env.ADMIN_SECRET || "";

// Resolved once startWorker() is called, after the HTTP server is listening.
let BASE = "";

const HEADERS: Record<string, string> = {
  "Content-Type":       "application/json",
  "x-zombrains-secret": AUTH,
  "x-admin-secret":     AUTH,
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiGet(path: string): Promise<unknown> {
  const r = await fetch(`${BASE}${path}`, {
    headers: HEADERS,
    signal:  AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const r = await fetch(`${BASE}${path}`, {
    method:  "POST",
    headers: HEADERS,
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
  return r.json();
}

// ── StepState resolver ────────────────────────────────────────────────────────

function resolveStepState(tmpl: string, state: Record<number, unknown> | null | undefined): string {
  return (tmpl || "").replace(/\{\{stepState\.(\d+)\}\}/g, (_: string, i: string) => {
    const val = state?.[Number(i)] ?? "";
    const s   = typeof val === "string" ? val : JSON.stringify(val);
    return s.slice(0, 500);
  });
}

// ── AI call with provider cascade ────────────────────────────────────────────

interface AIResult { text: string; provider: string; tokens: number | null; }

async function callAI(prompt: string): Promise<AIResult | null> {
  const messages = [{ role: "user", content: prompt }];
  for (const hint of ["groq", "cerebras", "mistral"]) {
    try {
      const result = await apiPost("/api/ai/proxy", {
        messages,
        hint,
        source: "api-server", // uses api-server quota pools
      }) as Record<string, unknown>;
      const text = (result.content ?? result.text ?? "") as string;
      if (text) {
        const usage = result.usage as Record<string, number> | undefined;
        return {
          text,
          provider: (result.provider as string) ?? hint,
          tokens:   (usage?.total_tokens ?? result.tokens as number) ?? null,
        };
      }
      logger.warn({ hint }, "[api-worker] provider returned empty — trying next");
    } catch (e) {
      logger.warn({ hint, err: (e as Error).message }, "[api-worker] provider failed — trying next");
    }
  }
  return null;
}

// ── Registration & heartbeat ──────────────────────────────────────────────────

async function register(): Promise<void> {
  try {
    await apiPost("/api/zombrains/worker/register", {
      executor: EXEC,
      pid:      process.pid,
      version:  "1.0",
    });
    logger.info({ executor: EXEC, pid: process.pid }, "[api-worker] Registered");
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "[api-worker] Registration failed (non-fatal)");
  }
}

async function heartbeat(): Promise<void> {
  try {
    const r = await fetch(`${BASE}/api/zombrains/worker/heartbeat`, {
      method:  "POST",
      headers: HEADERS,
      body:    JSON.stringify({ executor: EXEC }),
      signal:  AbortSignal.timeout(15_000),
    });
    if (r.status === 404) {
      logger.info("[api-worker] Heartbeat 404 — re-registering");
      await register();
    } else if (!r.ok) {
      logger.warn({ status: r.status }, "[api-worker] Heartbeat non-ok");
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "[api-worker] Heartbeat failed (non-fatal)");
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

let _busy = false;

async function poll(): Promise<void> {
  if (_busy) return;
  try {
    const data = await apiGet(`/api/zombrains/worker-queue?executor=${encodeURIComponent(EXEC)}`) as Record<string, unknown>;
    if (!data?.taskId) return;

    _busy = true;
    const { taskId, stepIndex, prompt, stepState, totalSteps } = data as {
      taskId: string; stepIndex: number; prompt: string;
      stepState?: Record<number, unknown>; totalSteps?: number;
    };
    logger.info({ taskId, stepIndex, totalSteps }, "[api-worker] Claimed step");

    const resolvedPrompt = resolveStepState(prompt, stepState ?? null);
    const startTs        = Date.now();
    const aiResult       = await callAI(resolvedPrompt);
    const latencyMs      = Date.now() - startTs;

    if (aiResult) {
      const { text, provider, tokens } = aiResult;
      const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n[output truncated]" : text;
      await apiPost(`/api/zombrains/worker-queue/${taskId}/step-complete`, {
        stepIndex,
        output:      truncated,
        executor:    EXEC,
        provider,
        tokens,
        latencyMs,
        promptChars: resolvedPrompt.length,
        outputChars: truncated.length,
      });
      logger.info({ taskId, stepIndex, provider, latencyMs, tokens }, "[api-worker] Step complete");
    } else {
      await apiPost(`/api/zombrains/worker-queue/${taskId}/step-failed`, {
        stepIndex,
        error:       "All providers returned empty output",
        executor:    EXEC,
        provider:    null,
        latencyMs,
        promptChars: resolvedPrompt.length,
      });
      logger.warn({ taskId, stepIndex }, "[api-worker] Step failed — no AI output");
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "[api-worker] Poll error");
  } finally {
    _busy = false;
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Call once after server.listen() succeeds. Registers this worker, then
 * starts the heartbeat and poll intervals.
 *
 * @param port - The port the HTTP server is listening on (used to build BASE URL).
 */
export function startWorker(port: number): void {
  BASE = `http://localhost:${port}`;
  logger.info({ executor: EXEC, pollMs: POLL_MS, base: BASE }, "[api-worker] Starting in-process worker");

  register().then(() => {
    // Heartbeat every 60s
    setInterval(() => { void heartbeat(); }, HB_MS);
    // Poll on a configurable interval
    setInterval(() => { void poll(); }, POLL_MS);
    // Initial poll after 5s to let server fully initialize
    setTimeout(() => { void poll(); }, 5_000);
    logger.info("[api-worker] Running");
  }).catch((e: Error) => {
    logger.warn({ err: e.message }, "[api-worker] Initial registration failed — worker still starting");
    setInterval(() => { void heartbeat(); }, HB_MS);
    setInterval(() => { void poll(); }, POLL_MS);
    setTimeout(() => { void poll(); }, 5_000);
  });
}
