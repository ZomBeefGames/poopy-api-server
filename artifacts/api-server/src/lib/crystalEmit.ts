import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
export const DB_PATH = path.resolve(__dirname, "..", "..", "..", "poop_tracker.db");

// In-memory counters per source (survives only for the current process uptime).
const _emitCounts: Record<string, { count: number; errors: number; lastEmit: number }> = {};

export interface CrystalEmitOptions {
  type:           string;
  domain:         string;
  sourceType:     string;
  provider?:      string | null;
  qualityScore?:  number | null;
  tokenCount?:    number | null;
  latencyMs?:     number | null;
  tags?:          string | null;
  taskId?:        string | null;
  payload?:       Record<string, unknown>;
}

export function emitCrystal(opts: CrystalEmitOptions): void {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ t: opts.type, d: opts.domain, s: opts.sourceType, p: opts.provider ?? "", ts: Math.floor(Date.now() / 60_000) }))
    .digest("hex")
    .slice(0, 32);

  const key = opts.sourceType;
  _emitCounts[key] = _emitCounts[key] ?? { count: 0, errors: 0, lastEmit: 0 };

  try {
    const db = new Database(DB_PATH, { readonly: false, fileMustExist: false });
    db.prepare(`
      INSERT OR IGNORE INTO crystal_ledger
        (hash, type, domain, source_type, provider, quality_score, token_count, latency_ms,
         tags, task_id, activation_count, created_at, payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)
    `).run(
      hash,
      opts.type,
      opts.domain,
      opts.sourceType,
      opts.provider   ?? null,
      opts.qualityScore ?? null,
      opts.tokenCount ?? null,
      opts.latencyMs  ?? null,
      opts.tags       ?? null,
      opts.taskId     ?? null,
      new Date().toISOString(),
      opts.payload ? JSON.stringify(opts.payload) : null,
    );
    db.close();
    _emitCounts[key].count++;
    _emitCounts[key].lastEmit = Date.now();
    logger.info({ source: opts.sourceType, domain: opts.domain, type: opts.type }, "[Crystal] emitted");
  } catch (e) {
    _emitCounts[key].errors++;
    logger.warn({ source: opts.sourceType, err: String(e) }, "[Crystal] emit failed (non-fatal)");
  }
}

export function getCrystalHealthCounts(): Record<string, { count: number; errors: number; lastEmitAgoSec: number }> {
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(_emitCounts).map(([k, v]) => [
      k,
      { count: v.count, errors: v.errors, lastEmitAgoSec: v.lastEmit > 0 ? Math.floor((now - v.lastEmit) / 1000) : -1 },
    ])
  );
}
