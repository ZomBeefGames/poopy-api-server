/**
 * clusterTools.ts — Dynamic tool registry for the Replit AI clusters
 *
 * Provides a set of built-in tools (web search, time, math, HTTP) plus a
 * SQLite-backed registry of custom tools that any cluster AI can create and
 * use on the fly via the `create_tool` meta-tool.
 *
 * The cluster tool loop in providers.ts calls getToolDefs() and executeTool()
 * on every iteration, so newly created tools are available immediately — no
 * restart required.
 */

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname_lib = path.dirname(__filename);
// Same relative depth as zombrains.ts (routes/ → 3 ups): lib/ → src/ → api-server/ → artifacts/
const DB_PATH = path.resolve(__dirname_lib, "..", "..", "..", "poop_tracker.db");

// ── Types ──────────────────────────────────────────────────────────────────────

export type ClusterTool = {
  name:        string;
  description: string;
  parameters:  Record<string, unknown>;
};

type StoredTool = ClusterTool & {
  code:       string;
  created_by: string;
  created_at: string;
};

// In-memory cache — cleared whenever a tool is registered or removed
let _customCache: StoredTool[] | null = null;

// ── DB helpers ─────────────────────────────────────────────────────────────────

function getDb() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS zombrains_cluster_tools (
      name        TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      parameters  TEXT NOT NULL DEFAULT '{}',
      code        TEXT NOT NULL,
      created_by  TEXT NOT NULL DEFAULT 'unknown',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

function loadCustomTools(): StoredTool[] {
  if (_customCache) return _customCache;
  try {
    const db   = getDb();
    const rows = db.prepare("SELECT * FROM zombrains_cluster_tools ORDER BY created_at ASC").all() as Array<{
      name: string; description: string; parameters: string;
      code: string; created_by: string; created_at: string;
    }>;
    db.close();
    _customCache = rows.map(r => ({
      name:       r.name,
      description: r.description,
      parameters: (() => { try { return JSON.parse(r.parameters); } catch { return {}; } })(),
      code:       r.code,
      created_by: r.created_by,
      created_at: r.created_at,
    }));
    return _customCache;
  } catch (e) {
    logger.warn({ err: e }, "clusterTools: failed to load custom tools from DB");
    return [];
  }
}

// ── Built-in tools ─────────────────────────────────────────────────────────────

const BUILTIN: ClusterTool[] = [
  {
    name:        "get_current_time",
    description: "Returns the current date and time. Optionally converts to a specific IANA timezone.",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone (e.g. 'America/New_York'). Default: UTC." },
        format:   { type: "string", enum: ["iso", "human", "unix"], description: "Output format. Default: iso." },
      },
    },
  },
  {
    name:        "calculate",
    description: "Evaluate a safe mathematical expression (arithmetic + Math.* functions). Do NOT use for general code — only math. Example: 'Math.sqrt(144)', '(100/3).toFixed(2)'.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Math expression to evaluate." },
      },
      required: ["expression"],
    },
  },
  {
    name:        "search_web",
    description: "Search the web for current information. Returns titles, URLs, and snippets. Requires SERPER_API_KEY or TAVILY_API_KEY to be configured.",
    parameters: {
      type: "object",
      properties: {
        query:       { type: "string",  description: "The search query." },
        num_results: { type: "number",  description: "How many results to return (max 10, default 5)." },
      },
      required: ["query"],
    },
  },
  {
    name:        "http_get",
    description: "Make an HTTP GET request to any public URL and return the response. Useful for reading APIs, JSON feeds, or web pages. Response body is capped at 3 000 characters.",
    parameters: {
      type: "object",
      properties: {
        url:     { type: "string", description: "The URL to fetch." },
        headers: { type: "object", description: "Optional request headers." },
      },
      required: ["url"],
    },
  },
  {
    name: "create_tool",
    description:
      "Register a brand-new tool in the cluster registry so you can use it immediately — " +
      "no restart required. Write the tool execute logic as an async JavaScript function body. " +
      "The function receives (args, fetch). It must return a JSON-serializable value. " +
      "Use this when you need a capability that no existing tool provides.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Snake_case name, e.g. 'get_weather' or 'fetch_github_issues'.",
        },
        description: {
          type: "string",
          description: "Clear description of what the tool does and when to use it.",
        },
        parameters: {
          type: "object",
          description: "JSON Schema object for the tool's inputs (same format as other tools).",
        },
        code: {
          type: "string",
          description:
            "Async JS function body. Has access to: args (the inputs object), fetch (native). " +
            "Example: \"const r = await fetch('https://wttr.in/' + args.city + '?format=j1'); return await r.json();\"",
        },
      },
      required: ["name", "description", "parameters", "code"],
    },
  },
];

const BUILTIN_NAMES = new Set(BUILTIN.map(t => t.name));

// ── Built-in executors ─────────────────────────────────────────────────────────

async function execBuiltin(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "get_current_time") {
    const now = new Date();
    const fmt  = String(args.format || "iso");
    const tz   = String(args.timezone || "UTC");
    if (fmt === "unix") return { unix: Math.floor(now.getTime() / 1000), utc: now.toISOString() };
    if (fmt === "human") {
      try {
        return { time: now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" }), timezone: tz };
      } catch {
        return { time: now.toUTCString(), timezone: "UTC (timezone invalid)" };
      }
    }
    return { iso: now.toISOString(), timezone: "UTC" };
  }

  if (name === "calculate") {
    const expr = String(args.expression || "").trim();
    if (!expr) return { error: "expression is required" };
    // Only permit math-safe characters
    if (/[^0-9+\-*/.()%\s,a-zA-Z_]/.test(expr) || /\b(require|import|process|global|eval|Function)\b/.test(expr)) {
      return { error: "Expression contains unsafe characters. Only arithmetic and Math.* allowed." };
    }
    try {
      // eslint-disable-next-line no-new-func
      const result = new Function(`"use strict"; return (${expr});`)();
      return { result, expression: expr };
    } catch (e) {
      return { error: `Evaluation error: ${e instanceof Error ? e.message : String(e)}`, expression: expr };
    }
  }

  if (name === "search_web") {
    const query  = String(args.query || "").trim();
    const n      = Math.min(Number(args.num_results || 5), 10);
    if (!query) return { error: "query is required" };

    const serperKey = process.env["SERPER_API_KEY"];
    if (serperKey) {
      try {
        const r = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
          body: JSON.stringify({ q: query, num: n }),
          signal: AbortSignal.timeout(10_000),
        });
        if (r.ok) {
          const j = await r.json() as { organic?: Array<{ title: string; link: string; snippet: string }> };
          return {
            results: (j.organic ?? []).slice(0, n).map(x => ({ title: x.title, url: x.link, snippet: x.snippet })),
            source:  "serper",
          };
        }
      } catch { /* fall through */ }
    }

    const tavilyKey = process.env["TAVILY_API_KEY"];
    if (tavilyKey) {
      try {
        const r = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: tavilyKey, query, max_results: n }),
          signal: AbortSignal.timeout(10_000),
        });
        if (r.ok) {
          const j = await r.json() as { results?: Array<{ title: string; url: string; content: string }> };
          return {
            results: (j.results ?? []).slice(0, n).map(x => ({ title: x.title, url: x.url, snippet: x.content?.slice(0, 200) })),
            source:  "tavily",
          };
        }
      } catch { /* fall through */ }
    }

    return { error: "No search API configured. Set SERPER_API_KEY or TAVILY_API_KEY to enable web search.", query };
  }

  if (name === "http_get") {
    const url     = String(args.url || "").trim();
    const headers = (args.headers as Record<string, string>) ?? {};
    if (!url) return { error: "url is required" };
    try {
      const r    = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      const text = await r.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep as text */ }
      return { status: r.status, ok: r.ok, body: typeof body === "string" ? body.slice(0, 3_000) : body };
    } catch (e) {
      return { error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}`, url };
    }
  }

  return { error: `No executor for built-in '${name}'` };
}

// ── Custom tool executor ───────────────────────────────────────────────────────

async function execCustom(tool: StoredTool, args: Record<string, unknown>): Promise<unknown> {
  try {
    // Sandbox: function only receives args + fetch, no access to Node internals
    // eslint-disable-next-line no-new-func
    const AsyncFn = Object.getPrototypeOf(async function(){}).constructor as new (...a: string[]) => (...p: unknown[]) => Promise<unknown>;
    const fn = new AsyncFn("args", "fetch", tool.code);
    return await fn(args, fetch);
  } catch (e) {
    return { error: `Tool '${tool.name}' threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Tool definitions in OpenAI tool format — built-in + registered custom tools. */
export function getToolDefs(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  const custom = loadCustomTools();
  const toOAI  = (t: ClusterTool) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } });
  return [...BUILTIN.map(toOAI), ...custom.map(toOAI)];
}

/** Execute a named tool. Never throws — errors are returned as { error } objects. */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    if (BUILTIN_NAMES.has(name)) return execBuiltin(name, args);
    const custom = loadCustomTools();
    const tool   = custom.find(t => t.name === name);
    if (!tool) {
      const all = [...BUILTIN_NAMES, ...custom.map(t => t.name)].join(", ");
      return { error: `Unknown tool '${name}'. Available: ${all}` };
    }
    return execCustom(tool, args);
  } catch (e) {
    return { error: `executeTool threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Register (or update) a custom tool in the DB. Throws if name conflicts with a built-in. */
export function registerTool(opts: {
  name:        string;
  description: string;
  parameters:  Record<string, unknown>;
  code:        string;
  created_by?: string;
}): void {
  if (!opts.name || !/^[a-z][a-z0-9_]*$/.test(opts.name)) {
    throw new Error(`Tool name must be snake_case and start with a lowercase letter. Got: '${opts.name}'`);
  }
  if (BUILTIN_NAMES.has(opts.name)) {
    throw new Error(`Cannot override built-in tool '${opts.name}'`);
  }
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO zombrains_cluster_tools (name, description, parameters, code, created_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        parameters  = excluded.parameters,
        code        = excluded.code,
        created_by  = excluded.created_by
    `).run(opts.name, opts.description, JSON.stringify(opts.parameters), opts.code, opts.created_by ?? "unknown");
  } finally {
    db.close();
  }
  _customCache = null;
  logger.info({ name: opts.name, by: opts.created_by }, "clusterTools: tool registered");
}

/** Remove a custom tool. Returns false if not found or is a built-in. */
export function removeTool(name: string): boolean {
  if (BUILTIN_NAMES.has(name)) return false;
  const db = getDb();
  try {
    const info = db.prepare("DELETE FROM zombrains_cluster_tools WHERE name = ?").run(name);
    _customCache = null;
    return info.changes > 0;
  } finally {
    db.close();
  }
}

/** List all tools with metadata (for admin/ZomBrains inspection). */
export function listTools(): Array<{
  name: string; description: string; builtin: boolean; created_by?: string; created_at?: string;
}> {
  const custom = loadCustomTools();
  return [
    ...BUILTIN.map(t => ({ name: t.name, description: t.description, builtin: true })),
    ...custom.map(t => ({ name: t.name, description: t.description, builtin: false, created_by: t.created_by, created_at: t.created_at })),
  ];
}
