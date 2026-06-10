import { Router, type Request, type Response } from "express";
import { authCheck } from "./zombrains-shared.js";

const router = Router();

// ── Music generation — FAL Stable Audio (primary) + HuggingFace MusicGen (fallback) ──
router.post("/zombrains/media/generate-music", async (req: Request, res: Response) => {
  if (!authCheck(req, res)) return;

  const { prompt, duration = 10, style } = req.body as {
    prompt?: string;
    duration?: number;
    style?: string;
  };

  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ ok: false, error: "prompt is required" });
    return;
  }

  const fullPrompt = style ? `${prompt}, ${style}` : prompt;
  const clampedDuration = Math.min(Math.max(Number(duration) || 10, 5), 30);

  // ── Try FAL first ─────────────────────────────────────────────────────────
  const falKey = process.env.FAL_API_KEY;
  if (falKey) {
    try {
      const falRes = await fetch("https://fal.run/fal-ai/stable-audio", {
        method: "POST",
        headers: {
          "Authorization": `Key ${falKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: fullPrompt, seconds_total: clampedDuration, steps: 100 }),
        signal: AbortSignal.timeout(60_000),
      });

      if (falRes.ok) {
        const data = await falRes.json() as { audio_file?: { url?: string }; audio?: { url?: string } };
        const url = data.audio_file?.url ?? data.audio?.url;
        if (url) {
          res.json({ ok: true, url, format: "mp3", provider: "fal", prompt: fullPrompt, duration: clampedDuration });
          return;
        }
      }
    } catch (_) {
      // fall through to HuggingFace
    }
  }

  // ── HuggingFace MusicGen fallback ─────────────────────────────────────────
  const hfKey = process.env.HUGGINGFACE_API_KEY;
  if (!hfKey) {
    res.status(503).json({ ok: false, error: "No music generation API keys configured (FAL_API_KEY or HUGGINGFACE_API_KEY required)" });
    return;
  }

  try {
    const hfRes = await fetch("https://api-inference.huggingface.co/models/facebook/musicgen-small", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${hfKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: fullPrompt }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!hfRes.ok) {
      const errText = await hfRes.text();
      res.status(502).json({ ok: false, error: `HuggingFace error ${hfRes.status}: ${errText.slice(0, 200)}`, provider: "huggingface" });
      return;
    }

    const audioBuf = Buffer.from(await hfRes.arrayBuffer());
    const base64Audio = audioBuf.toString("base64");
    const dataUri = `data:audio/wav;base64,${base64Audio}`;

    res.json({ ok: true, dataUri, format: "wav", provider: "huggingface", prompt: fullPrompt, duration: clampedDuration, sizeBytes: audioBuf.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message, provider: "huggingface" });
  }
});

export default router;
