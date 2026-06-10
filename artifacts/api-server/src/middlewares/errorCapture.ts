/**
 * errorCapture.ts — Global error persistence middleware for the api-server.
 *
 * Why this exists: unhandled errors were silently lost. Now every caught error
 * goes to Postgres error_log (500-row ring buffer) so ZomBrains and the owner
 * can see what's breaking without digging through Railway logs.
 *
 * Exports:
 *  - errorCaptureMiddleware — Express 4-arg error handler (wire AFTER all routes)
 *  - writeErrorLog          — For process-level uncaught/unhandledRejection handlers
 *  - captureMiddleware      — Per-request timing middleware (wired before routes)
 */

import type { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { db, errorLogTable, sql } from "@workspace/db";
import { logger } from "../lib/logger.js";

// ── Ring buffer trim constant ─────────────────────────────────────────────────
// Keep the newest 500 rows; delete beyond that in a single DELETE on each insert.
const RING_BUFFER_SIZE = 500;

// ── Normalise route — strip path IDs so /foo/123/bar → /foo/:id/bar ──────────
// Without this, every unique ID produces a unique "route" string and the ring
// buffer fills with low-signal noise instead of actionable patterns.
function normaliseRoute(url: string | undefined): string {
  if (!url) return "unknown";
  const path = url.split("?")[0];
  return path.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}/g, "/:uuid")
             .replace(/\/\d+/g, "/:id")
             .slice(0, 200);
}

// ── Core write function — used by middleware AND process-level handlers ────────
export async function writeErrorLog(entry: {
  route:       string;
  method:      string;
  message:     string;
  stack?:      string | null;
  status_code?: number | null;
  source?:     string;
}): Promise<void> {
  try {
    await db.insert(errorLogTable).values({
      route:       (entry.route  || "unknown").slice(0, 500),
      method:      (entry.method || "unknown").slice(0, 20),
      message:     (entry.message || "unknown error").slice(0, 2000),
      stack:       entry.stack ? entry.stack.slice(0, 4000) : null,
      status_code: entry.status_code ?? null,
      source:      entry.source ?? "api-server",
    });

    // Trim ring buffer: delete all but the newest RING_BUFFER_SIZE rows.
    // One raw SQL delete is far cheaper than a count+delete round-trip.
    await db.execute(sql`
      DELETE FROM error_log
      WHERE id NOT IN (
        SELECT id FROM error_log
        ORDER BY timestamp DESC
        LIMIT ${RING_BUFFER_SIZE}
      )
    `);
  } catch (dbErr) {
    // Non-fatal — logging the logger's failure would recurse. Pino is still up.
    logger.warn({ err: dbErr }, "[errorCapture] Failed to persist error to DB");
  }
}

// ── Express 4-arg error handler ───────────────────────────────────────────────
// Must be registered AFTER all routes in app.ts. Express detects 4-arg handlers
// by arity — never rename/remove parameters.
export const errorCaptureMiddleware: ErrorRequestHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const statusCode = (err as { status?: number; statusCode?: number }).status
                  ?? (err as { statusCode?: number }).statusCode
                  ?? 500;

  // Fire-and-forget persist — never block the response on a DB write.
  void writeErrorLog({
    route:       normaliseRoute(req.url),
    method:      req.method ?? "unknown",
    message:     err.message ?? String(err),
    stack:       err.stack ?? null,
    status_code: statusCode,
    source:      "api-server",
  });

  logger.error({ err, url: req.url, method: req.method }, "Unhandled Express error");

  // Only send a response if headers haven't been sent yet.
  if (res.headersSent) { next(err); return; }

  res.status(statusCode).json({ error: err.message ?? "Internal server error" });
};
