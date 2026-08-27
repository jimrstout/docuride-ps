import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Client } from "basic-ftp";
import { Readable } from "node:stream";

/*
 * FTPS courier. Receives { filename, content } from the Supabase rr-report function
 * and uploads it to Reynolds & Reynolds. Does nothing else.
 * Auth: x-relay-secret header must equal FTPS_RELAY_SECRET.
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if ((req.headers["x-relay-secret"] ?? "") !== process.env.FTPS_RELAY_SECRET) return res.status(401).json({ error: "unauthorized" });

  const { filename, content } = (req.body ?? {}) as { filename?: string; content?: string };
  if (!filename || typeof content !== "string") return res.status(400).json({ error: "filename and content required" });
  if (!/^[A-Za-z0-9_.-]+$/.test(filename)) return res.status(400).json({ error: "bad filename" });

  const client = new Client(30_000);
  try {
    await client.access({
      host: process.env.RR_FTP_HOST ?? "ftps.lz.reyrey.com",
      port: Number(process.env.RR_FTP_PORT ?? 21),
      user: process.env.RR_FTP_USER!,
      password: process.env.RR_FTP_PASS!,
      secure: true,
    });
    const path = process.env.RR_FTP_PATH ?? "";
    if (path) await client.ensureDir(path);
    const r = await client.uploadFrom(Readable.from([Buffer.from(content, "utf8")]), filename);
    return res.status(200).json({ ok: true, ftp: r.message });
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    client.close();
  }
}
