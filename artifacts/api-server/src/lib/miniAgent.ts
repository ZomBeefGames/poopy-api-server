import { callProvider, type Msg } from "./providers.js";
import { logger } from "./logger.js";

const ZOMBRAINS_URL = "https://builder-agent-production.up.railway.app";

function getReportUrl(): string {
  return (
    process.env["ZOMBRAINS_REPORT_URL"] ??
    "https://e6d6a14d-ebd1-45a4-a523-88e2cd4b9603-00-1o69os6xk8nc0.kirk.replit.dev/api/zombrains/report"
  );
}

function getAdminSecret(): string | null {
  return process.env["ADMIN_SECRET"] ?? null;
}

export type TaskResult = {
  id: string;
  prompt: string;
  action: "handled" | "delegated" | "error";
  result?: string;
  provider?: string;
  ts: string;
};

const taskLog: TaskResult[] = [];

async function postReport(type: string, message: string, data?: unknown): Promise<void> {
  const secret = getAdminSecret();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["x-admin-secret"] = secret;
  try {
    await fetch(getReportUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({ type, task: "mini-agent", message, data }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    logger.warn({ err: e }, "mini-agent postReport failed (non-critical)");
  }
}

const CLASSIFY_SYSTEM =
  "You are a task classifier for a Discord bot admin system. " +
  "Decide if the task is simple enough to answer in a single short response, " +
  "or if it needs multi-step work, code editing, or file changes. " +
  "Reply with ONLY the word SIMPLE or DELEGATE.";

const AGENT_SYSTEM =
  "You are a helpful assistant for the Poopy Discord bot admin panel. " +
  "You help with questions about bot data, user management, game stats, " +
  "and general bot operations. Be concise and direct.";

export async function runAgentTask(
  prompt: string,
  context?: string,
): Promise<{ action: string; result?: string; provider?: string; queued?: boolean }> {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  // ── Step 1: classify ────────────────────────────────────────────────────────
  const classifyMsgs: Msg[] = [
    { role: "system", content: CLASSIFY_SYSTEM },
    { role: "user",   content: `Task: ${prompt}` },
  ];

  let classification: "SIMPLE" | "DELEGATE" = "SIMPLE";
  try {
    const { result } = await callProvider(classifyMsgs);
    if (result.trim().toUpperCase().startsWith("DELEGATE")) classification = "DELEGATE";
  } catch {
    // default to SIMPLE if classification itself fails
  }

  // ── Step 2a: delegate to ZomBrains ──────────────────────────────────────────
  if (classification === "DELEGATE") {
    try {
      const fullPrompt = context ? `${prompt}\n\nContext:\n${context}` : prompt;
      const r = await fetch(`${ZOMBRAINS_URL}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: fullPrompt }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`ZomBrains queue returned ${r.status}`);

      const entry: TaskResult = { id, prompt, action: "delegated", ts: new Date().toISOString() };
      pushLog(entry);
      void postReport("delegated", `Delegated to ZomBrains: ${prompt.slice(0, 80)}`, { id });
      logger.info({ id }, "mini-agent delegated task to ZomBrains");
      return { action: "delegated", queued: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ err: msg }, "mini-agent delegate failed — falling back to SIMPLE");
      // fall through to handle directly
    }
  }

  // ── Step 2b: handle directly ────────────────────────────────────────────────
  const messages: Msg[] = [{ role: "system", content: AGENT_SYSTEM }];
  if (context) messages.push({ role: "user", content: `Context:\n${context}` });
  messages.push({ role: "user", content: prompt });

  try {
    const { result, provider } = await callProvider(messages);
    const entry: TaskResult = { id, prompt, action: "handled", result, provider, ts: new Date().toISOString() };
    pushLog(entry);
    void postReport("progress", `Handled: ${prompt.slice(0, 80)}`, { id, provider, snippet: result.slice(0, 200) });
    logger.info({ id, provider }, "mini-agent handled task directly");
    return { action: "handled", result, provider };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const entry: TaskResult = { id, prompt, action: "error", result: msg, ts: new Date().toISOString() };
    pushLog(entry);
    void postReport("error", `Agent error: ${msg}`, { id });
    throw e;
  }
}

function pushLog(entry: TaskResult): void {
  taskLog.unshift(entry);
  if (taskLog.length > 20) taskLog.length = 20;
}

export function getTaskLog(): TaskResult[] {
  return [...taskLog];
}
