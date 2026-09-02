import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Client } from "basic-ftp";
import { Readable } from "node:stream";

/*
 * FTPS relay for Reynolds & Reynolds.
 *
 * ARCHITECTURE.md's one standing exception: Supabase Edge owns the business
 * logic, Vercel owns protocol relays Deno cannot perform. Measured 2026-09-02
 * via api/rr-net-test — Supabase Edge cannot reach ftps.lz.reyrey.com:990 at
 * all; Vercel gets the banner in 122ms. That asymmetry is why this exists.
 *
 *   POST /api/rr-relay    header  x-relay-secret: <FTPS_RELAY_SECRET>
 *   body  { action: "login-test" | "upload", user, pass, filename?, content? }
 *
 *   login-test -> { ok, banner, ms }
 *   upload     -> { ok, ftp, ms }
 *
 * Dumb by design: it receives credentials and bytes, moves them, and reports
 * what the server said. No Zoho, no Supabase, no CSV assembly, no decisions.
 *
 * Credentials arrive in the body rather than living here, so this file holds
 * no secret but the one gating the endpoint. Unlike the throwaway probe this
 * replaced, certificate verification is fully ON — the probe read a public
 * greeting and sent nothing, this carries a password.
 *
 * Host and port are hardcoded. Never accept them from the request: the
 * retired temp-ftps-diag took host and port from the query string and was, in
 * effect, an open port scanner. LIST is never sent; the drop is write-only and
 * a directory listing is not ours to take.
 */

const HOST = "ftps.lz.reyrey.com";
const PORT = 990;                 // implicit TLS, per the R&R "Using the FTP Drop" doc
const TIMEOUT_MS = 30_000;

type Action = "login-test" | "upload";

interface Body {
  action?: Action;
  user?: string;
  pass?: string;
  filename?: string;
  content?: string;
}

// STOR takes this verbatim; keep it a bare filename so it cannot climb the tree.
const FILENAME_RE = /^[A-Za-z0-9_.-]+$/;

/** Length-independent compare, so the secret is not revealed by response timing. */
function secretsMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Full verification. servername is set explicitly so SNI and the certificate's
// name are both checked against the host we dialled; rejectUnauthorized stays
// at its default of true.
const TLS_OPTIONS = { servername: HOST };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const presented = req.headers["x-relay-secret"];
  const secret = Array.isArray(presented) ? presented[0] : presented;
  // Fail closed: an unset FTPS_RELAY_SECRET makes secretsMatch false, so a
  // misconfigured deploy rejects everything rather than opening the relay.
  if (!secretsMatch(secret, process.env.FTPS_RELAY_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const body = (req.body ?? {}) as Body;
  const action = body.action;
  const user = typeof body.user === "string" ? body.user : "";
  const pass = typeof body.pass === "string" ? body.pass : "";

  if (action !== "login-test" && action !== "upload") {
    return res.status(400).json({ error: "action must be login-test or upload" });
  }
  if (!user || !pass) return res.status(400).json({ error: "user and pass required" });

  let filename = "";
  let content = "";
  if (action === "upload") {
    filename = typeof body.filename === "string" ? body.filename : "";
    content = typeof body.content === "string" ? body.content : "";
    if (!FILENAME_RE.test(filename)) return res.status(400).json({ error: "bad filename" });
    if (!content) return res.status(400).json({ error: "content required" });
  }

  const t0 = Date.now();
  // allowSeparateTransferHost:false is load-bearing, not tidiness. This server
  // answers PASV with an unroutable RFC1918 address; basic-ftp's default is to
  // trust it, which dials 10.x and hangs until the timeout. False switches it
  // to forceControlHostIP: keep the PASV port, reuse the control host.
  const client = new Client(TIMEOUT_MS, { allowSeparateTransferHost: false });

  try {
    if (action === "login-test") {
      // Connect and log in by hand rather than via access(), so the 220
      // greeting is captured before it is overwritten by later responses.
      // Logging in is the whole proof: touch no files, list nothing.
      const greeting = await client.connectImplicitTLS(HOST, PORT, TLS_OPTIONS);
      await client.login(user, pass);
      client.close();                 // sends QUIT, then closes
      const ms = Date.now() - t0;
      console.log("rr-relay login-test ok", { ms });
      return res.status(200).json({ ok: true, banner: greeting.message, ms });
    }

    // access() runs connect -> login -> useDefaultSettings, which is what
    // issues PBSZ 0 and PROT P so the data channel is encrypted too.
    await client.access({ host: HOST, port: PORT, user, password: pass, secure: "implicit", secureOptions: TLS_OPTIONS });
    await client.send("TYPE I");
    const stor = await client.uploadFrom(Readable.from([Buffer.from(content, "utf8")]), filename);
    client.close();
    const ms = Date.now() - t0;
    console.log("rr-relay upload ok", { filename, bytes: content.length, ms });
    return res.status(200).json({ ok: true, ftp: stor.message, ms });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ms = Date.now() - t0;
    // Action, filename, timing and the server's own words. Never the
    // credentials, never the file body.
    console.error("rr-relay failed", { action, filename: filename || null, ms, error: message });
    return res.status(502).json({ ok: false, error: message, ms });
  } finally {
    try { client.close(); } catch { /* already closed */ }
  }
}
