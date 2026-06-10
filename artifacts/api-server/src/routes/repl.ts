import { Router, type IRouter } from "express";
import { executeCode } from "../lib/executor";

const router: IRouter = Router();

interface HistoryEntry {
  id: number;
  code: string;
  stdout: string;
  stderr: string;
  error: string | null;
  duration: number;
  exitCode: number | null;
  createdAt: string;
}

let nextId = 1;
const history: HistoryEntry[] = [];
const MAX_HISTORY = 100;

router.post("/repl/execute", async (req, res): Promise<void> => {
  const { code, timeout } = req.body ?? {};
  if (typeof code !== "string") {
    res.status(400).json({ error: "code is required" });
    return;
  }

  const result = await executeCode({ code, timeout: typeof timeout === "number" ? timeout : undefined });

  const entry: HistoryEntry = {
    id: nextId++,
    code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error ?? null,
    duration: result.duration,
    exitCode: result.exitCode ?? null,
    createdAt: new Date().toISOString(),
  };

  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);

  res.json(result);
});

router.get("/repl/history", async (_req, res): Promise<void> => {
  res.json(history);
});

router.delete("/repl/history", async (_req, res): Promise<void> => {
  history.splice(0);
  nextId = 1;
  res.json({ message: "History cleared" });
});

export default router;
