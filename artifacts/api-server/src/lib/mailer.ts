// ══════════════════════════════════════════════════════════════════════════════
// mailer.ts — Resend wrapper with optional zip attachment
//   sendRenderCompleteEmail({ to, title, resultUrl })
//   - Attempts to download resultUrl, zip it, and attach (up to 38 MB)
//   - Falls back to link-only HTML email if download/zip fails or file too large
// ══════════════════════════════════════════════════════════════════════════════
import { Resend } from "resend";
import { ZipArchive } from "archiver";
import { logger } from "./logger.js";

const MAX_ATTACH_BYTES = 38 * 1024 * 1024; // 38 MB — safe headroom under Resend's 40 MB limit

let _resend: Resend | null = null;

function getClient(): Resend | null {
  if (_resend) return _resend;
  const key = process.env["RESEND_API_KEY"];
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

export interface RenderCompleteEmailOpts {
  to:        string;
  title:     string;
  resultUrl: string;
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function zipBuffer(buf: Buffer, filename: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("data",  (chunk: Buffer) => chunks.push(chunk));
    archive.on("end",   ()              => resolve(Buffer.concat(chunks)));
    archive.on("error", (err: Error)    => reject(err));
    archive.append(buf, { name: filename });
    void archive.finalize();
  });
}

export async function sendRenderCompleteEmail(opts: RenderCompleteEmailOpts): Promise<{ ok: boolean; error?: string }> {
  const client = getClient();
  if (!client) {
    logger.warn("[mailer] RESEND_API_KEY not set — email skipped");
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const from = process.env["RESEND_FROM_EMAIL"] ?? "onboarding@resend.dev";

  type ResendAttachment = { filename: string; content: Buffer };
  let attachments: ResendAttachment[] = [];
  let attachNote = "";

  try {
    const rawBuf  = await downloadToBuffer(opts.resultUrl);
    const zipName = `${opts.title.replace(/[^a-z0-9]/gi, "_")}.mp4`;
    const zipBuf  = await zipBuffer(rawBuf, zipName);
    if (zipBuf.length > MAX_ATTACH_BYTES) {
      logger.warn({ sizeBytes: zipBuf.length }, "[mailer] Zip exceeds 38 MB — sending without attachment");
      attachNote = `<p style="color:#888;font-size:12px;">(Attachment skipped — file too large. Use the link above.)</p>`;
    } else {
      attachments = [{ filename: `${zipName}.zip`, content: zipBuf }];
    }
  } catch (err) {
    logger.warn({ err }, "[mailer] Could not download/zip video — sending without attachment");
    attachNote = `<p style="color:#888;font-size:12px;">(Attachment could not be prepared — use the link above.)</p>`;
  }

  try {
    const payload: Parameters<Resend["emails"]["send"]>[0] = {
      from,
      to:      [opts.to],
      subject: `🎬 Your render is ready: ${opts.title}`,
      html:    `
        <h2>Your ZomBeef render is complete!</h2>
        <p><strong>${opts.title}</strong> has finished rendering.</p>
        <p><a href="${opts.resultUrl}" style="background:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">View Result</a></p>
        ${attachNote}
        <p style="color:#666;font-size:12px;">Sent by ZomBeef render pipeline.</p>
      `,
    };
    if (attachments.length > 0) {
      payload.attachments = attachments;
    }
    const { error } = await client.emails.send(payload);
    if (error) {
      logger.warn({ error }, "[mailer] Resend returned error");
      return { ok: false, error: error.message };
    }
    logger.info({ to: opts.to, title: opts.title }, "[mailer] render-complete email sent");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: msg }, "[mailer] sendRenderCompleteEmail threw");
    return { ok: false, error: msg };
  }
}
