import { Router, type IRouter } from "express";

const router: IRouter = Router();

interface Snippet {
  id: number;
  name: string;
  code: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

let nextId = 1;
const snippets = new Map<number, Snippet>();

function now() {
  return new Date().toISOString();
}

router.get("/snippets", async (_req, res): Promise<void> => {
  const all = [...snippets.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  res.json(all);
});

router.post("/snippets", async (req, res): Promise<void> => {
  const { name, code, description } = req.body ?? {};
  if (!name || typeof code !== "string") {
    res.status(400).json({ error: "name and code are required" });
    return;
  }

  const snippet: Snippet = {
    id: nextId++,
    name,
    code,
    description: description ?? null,
    createdAt: now(),
    updatedAt: now(),
  };
  snippets.set(snippet.id, snippet);
  res.status(201).json(snippet);
});

router.get("/snippets/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const snippet = snippets.get(id);
  if (!snippet) { res.status(404).json({ error: "Snippet not found" }); return; }
  res.json(snippet);
});

router.patch("/snippets/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const snippet = snippets.get(id);
  if (!snippet) { res.status(404).json({ error: "Snippet not found" }); return; }

  const { name, code, description } = req.body ?? {};
  if (name !== undefined) snippet.name = name;
  if (code !== undefined) snippet.code = code;
  if (description !== undefined) snippet.description = description ?? null;
  snippet.updatedAt = now();

  res.json(snippet);
});

router.delete("/snippets/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  if (!snippets.has(id)) { res.status(404).json({ error: "Snippet not found" }); return; }

  snippets.delete(id);
  res.json({ message: "Snippet deleted" });
});

export default router;
