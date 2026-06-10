import { Router, type IRouter } from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputsDir = path.resolve(__dirname, "..", "..", "..", "zombeef-suite", "outputs");

const router: IRouter = Router();

router.get("/suite-download/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(outputsDir, filename);

  if (!fs.existsSync(filePath)) {
    res.status(404).send("File not found");
    return;
  }

  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.sendFile(filePath);
});

export default router;
