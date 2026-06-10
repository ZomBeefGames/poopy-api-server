import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ExecuteOptions {
  code: string;
  timeout?: number;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  error: string | null;
  duration: number;
  exitCode: number | null;
}

const DEFAULT_TIMEOUT = 5000;
const MAX_TIMEOUT = 30000;
const MAX_OUTPUT = 100_000;

export async function executeCode(options: ExecuteOptions): Promise<ExecuteResult> {
  const { code, timeout: rawTimeout = DEFAULT_TIMEOUT } = options;
  const timeout = Math.min(Math.max(rawTimeout, 100), MAX_TIMEOUT);

  const fileName = join(tmpdir(), `repl-${randomUUID()}.mjs`);
  const start = Date.now();

  await writeFile(fileName, code, "utf8");

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = spawn(process.execPath, [fileName], {
      timeout,
      env: {
        ...process.env,
        NODE_ENV: "sandbox",
      },
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT) + "\n[output truncated]";
        child.kill("SIGKILL");
        killed = true;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT) + "\n[output truncated]";
      }
    });

    child.on("close", (code, signal) => {
      const duration = Date.now() - start;
      unlink(fileName).catch(() => {});

      if (killed || signal === "SIGKILL") {
        resolve({
          stdout,
          stderr,
          error: `Process terminated: output exceeded limit or was killed`,
          duration,
          exitCode: null,
        });
        return;
      }

      if (signal === "SIGTERM") {
        resolve({
          stdout,
          stderr,
          error: `Execution timed out after ${timeout}ms`,
          duration,
          exitCode: null,
        });
        return;
      }

      resolve({
        stdout,
        stderr,
        error: code !== 0 ? (stderr || "Process exited with non-zero code") : null,
        duration,
        exitCode: code,
      });
    });

    child.on("error", (err) => {
      const duration = Date.now() - start;
      unlink(fileName).catch(() => {});
      resolve({
        stdout,
        stderr,
        error: err.message,
        duration,
        exitCode: null,
      });
    });
  });
}
