import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";
import { errorCaptureMiddleware } from "./middlewares/errorCapture.js";

// Resolve workspace root from compiled output location:
// dist/app.mjs → ../../.. → workspace root → tracks/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tracksDir = path.resolve(__dirname, "..", "..", "..", "tracks");
const suiteOutputsDir = path.resolve(__dirname, "..", "..", "..", "zombeef-suite", "outputs");

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({
  limit: "10mb",
  // Capture raw body for HMAC verification on webhook routes (e.g. POST /api/billing/webhook).
  // express.json() parses the body, so JSON.stringify(req.body) may not match the original bytes.
  // The raw Buffer is stored in req.rawBody and used by billing.ts webhook handler.
  verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use("/api", router);
app.use("/api/tracks", express.static(tracksDir));
app.use("/api/suite-outputs", express.static(suiteOutputsDir));

// ── Global error capture middleware — MUST be registered after all routes ─────
// Express identifies 4-arg middleware as error handlers by arity.
// Any unhandled error thrown/next(err)'d in any route ends up here,
// gets persisted to Postgres error_log, and returns a clean JSON 500.
app.use(errorCaptureMiddleware);

export default app;
