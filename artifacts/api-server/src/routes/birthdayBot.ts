import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

const BIRTHDAY_BOT_URL = `http://localhost:${process.env.BIRTHDAY_HTTP_PORT || 3457}`;

async function proxyToBirthdayBot(path: string, req: Request, res: Response) {
  try {
    const opts: RequestInit = { method: req.method, signal: AbortSignal.timeout(15_000) };
    if (req.method === "POST") {
      opts.headers = { "Content-Type": "application/json", "x-admin-secret": req.headers["x-zombrains-secret"] as string || "" };
      opts.body = JSON.stringify(req.body);
    }
    const r = await fetch(`${BIRTHDAY_BOT_URL}${path}`, opts);
    const text = await r.text();
    res.status(r.status).set("Content-Type", r.headers.get("content-type") || "application/json").send(text);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(503).json({ error: "birthday-bot unreachable", detail: msg });
  }
}

router.get("/birthday-bot/health", (req, res) => proxyToBirthdayBot("/health", req, res));
router.post("/birthday-bot/ai",    (req, res) => proxyToBirthdayBot("/ai",     req, res));

export default router;
