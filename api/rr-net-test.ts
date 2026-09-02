import type { VercelRequest, VercelResponse } from "@vercel/node";
import net from "node:net";
import tls from "node:tls";

/*
 * TEMPORARY DIAGNOSTIC — added 2026-09-02, delete once the relay decision is made.
 *
 * Answers one question: can a Vercel lambda reach Reynolds & Reynolds on each
 * FTPS transport? It opens a socket, reads the greeting, and hangs up.
 *
 *   GET /api/rr-net-test        header  x-relay-secret: <FTPS_RELAY_SECRET>
 *
 *   implicit  TLS on :990  — handshake, then read the 220 banner
 *   explicit  TCP on :21   — read the 220 banner (no AUTH TLS is sent)
 *
 * Deliberately inert. It sends no bytes beyond the TLS handshake: no AUTH TLS,
 * no USER, no PASS, no file. There are no credentials in this file and none
 * are read from the environment beyond the secret that gates the endpoint.
 *
 * The host and both ports are hardcoded and no parameter of any kind is read
 * from the request. The Supabase function this replaces (temp-ftps-diag) took
 * host and port from the query string, which made it an open port scanner
 * anyone could point anywhere. Do not reintroduce that.
 */

const HOST = "ftps.lz.reyrey.com";
const IMPLICIT_PORT = 990;
const EXPLICIT_PORT = 21;
const TIMEOUT_MS = 10_000;

interface Probe {
  ok: boolean;
  banner?: string;
  error?: string;
  ms: number;
}

/** Length-independent compare, so the secret is not revealed by response timing. */
function secretsMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Open a socket, resolve on the first bytes received, and always destroy it.
 *
 * Every path — banner, error, timeout, or a clean close with nothing sent —
 * settles exactly once and tears the socket down, so a hung server cannot keep
 * the lambda alive past its own timeout.
 */
function probe(open: () => net.Socket): Promise<Probe> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let socket: net.Socket;
    let done = false;

    const settle = (result: Omit<Probe, "ms">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve({ ...result, ms: Date.now() - t0 });
    };

    const timer = setTimeout(
      () => settle({ ok: false, error: `timeout after ${TIMEOUT_MS}ms` }),
      TIMEOUT_MS,
    );

    try {
      socket = open();
    } catch (e) {
      settle({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    socket.setTimeout(TIMEOUT_MS);
    socket.once("data", (buf: Buffer) => settle({ ok: true, banner: buf.toString("utf8").trim() }));
    socket.once("error", (e: Error) => settle({ ok: false, error: e.message }));
    socket.once("timeout", () => settle({ ok: false, error: `socket idle ${TIMEOUT_MS}ms` }));
    socket.once("close", () => settle({ ok: false, error: "closed before any data" }));
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const presented = req.headers["x-relay-secret"];
  const secret = Array.isArray(presented) ? presented[0] : presented;
  if (!secretsMatch(secret, process.env.FTPS_RELAY_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const [implicit, explicit] = await Promise.all([
    // Certificate validation is off on purpose: this reads a greeting and
    // sends nothing, so the question is reachability, not trust. A cert
    // complaint here would hide whether the TCP path works at all.
    probe(() => tls.connect({ host: HOST, port: IMPLICIT_PORT, servername: HOST, rejectUnauthorized: false })),
    probe(() => net.connect({ host: HOST, port: EXPLICIT_PORT })),
  ]);

  return res.status(200).json({ implicit, explicit });
}
