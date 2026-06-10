import { Router, type IRouter } from "express";
import { db, gameSavesTable, eq } from "@workspace/db";
import {
  SaveGameBody,
  SaveGameResponse,
  ListSavesResponse,
  LoadSaveParams,
  LoadSaveResponse,
  DeleteSaveParams,
  DeleteSaveResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/game/save", async (req, res): Promise<void> => {
  const parsed = SaveGameBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const existing = await db
    .select()
    .from(gameSavesTable)
    .where(eq(gameSavesTable.saveName, parsed.data.saveName))
    .limit(1);

  let row;
  if (existing.length > 0) {
    [row] = await db
      .update(gameSavesTable)
      .set({ stateJson: parsed.data.stateJson })
      .where(eq(gameSavesTable.saveName, parsed.data.saveName))
      .returning();
  } else {
    [row] = await db
      .insert(gameSavesTable)
      .values(parsed.data)
      .returning();
  }

  res.json(SaveGameResponse.parse(row));
});

router.get("/game/saves", async (_req, res): Promise<void> => {
  const saves = await db
    .select()
    .from(gameSavesTable)
    .orderBy(gameSavesTable.updatedAt);

  res.json(ListSavesResponse.parse(saves));
});

router.get("/game/saves/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = LoadSaveParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [save] = await db
    .select()
    .from(gameSavesTable)
    .where(eq(gameSavesTable.id, params.data.id));

  if (!save) {
    res.status(404).json({ error: "Save not found" });
    return;
  }

  res.json(LoadSaveResponse.parse(save));
});

router.delete("/game/saves/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteSaveParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(gameSavesTable)
    .where(eq(gameSavesTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Save not found" });
    return;
  }

  res.json(DeleteSaveResponse.parse({ message: "Deleted" }));
});

export default router;
