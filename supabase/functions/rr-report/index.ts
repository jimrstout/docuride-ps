// rr-report — Reynolds & Reynolds monthly transaction report
// GET ?month=YYYYMM&mode=preview|csv|submit|login-test
// Auth: Supabase user JWT (admin UI) or service-role JWT (pg_cron)
//
// Two ways to reach the FTPS drop:
//   native  Deno opens the socket itself — implicit TLS :990 or explicit AUTH TLS :21
//   relay   POST to the Vercel relay (api/rr-relay), which does the FTP
//
// Measured 2026-09-02: Supabase Edge cannot reach ftps.lz.reyrey.com:990 at all,
// while Vercel gets the banner in 122ms. RR_FTPS_MODE=relay is therefore the
// working path today; native is kept because it costs nothing to keep and
// becomes correct the moment Edge egress changes.

const ENV = {
  supabaseUrl: Deno.env.get("SUPABASE_URL")!,
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  zohoClientId: Deno.env.get("ZOHO_CLIENT_ID")!,
  zohoClientSecret: Deno.env.get("ZOHO_CLIENT_SECRET")!,
  zohoRefreshToken: Deno.env.get("ZOHO_REFRESH_TOKEN")!,
  zohoAccounts: Deno.env.get("ZOHO_ACCOUNTS_DOMAIN") ?? "https://accounts.zoho.com",
  zohoApi: Deno.env.get("ZOHO_API_DOMAIN") ?? "https://www.zohoapis.com",
  companyPrefix: Deno.env.get("RR_COMPANY_PREFIX") ?? "COMPANY",
  accountNumber: Deno.env.get("RR_ACCOUNT_NUMBER") ?? "0000000",
  ftpHost: Deno.env.get("RR_FTP_HOST") ?? "ftps.lz.reyrey.com",
  implicitPort: Number(Deno.env.get("RR_FTP_PORT") ?? 990),
  explicitPort: Number(Deno.env.get("RR_FTP_EXPLICIT_PORT") ?? 21),
  ftpUser: Deno.env.get("RR_FTP_USER") ?? "",
  ftpPass: Deno.env.get("RR_FTP_PASS") ?? "",
  ftpPath: Deno.env.get("RR_FTP_PATH") ?? "",
  transport: Deno.env.get("RR_FTPS_TRANSPORT") ?? "auto", // implicit | explicit | auto
  ftpsMode: Deno.env.get("RR_FTPS_MODE") ?? "native", // native | relay
  relayUrl: Deno.env.get("FTPS_RELAY_URL") ?? "",
  relaySecret: Deno.env.get("FTPS_RELAY_SECRET") ?? "",
  ftpTimeoutMs: Number(Deno.env.get("RR_FTP_TIMEOUT_MS") ?? 15000),
};

// Deals remain reportable after posting — status advances Completed -> Posted and must not drop rows.
const REPORTABLE_STATUSES = ["Completed Sale (Accounting)", "Posted (Sales Complete)"];
const SIGNED_STATUSES = ["Documents Signed", "Documents Filed"];
const HEADERS = ["Transaction Date","Form ID","Company Customer Name","Company Customer dba","Company Customer Address","City","State","Zip Code","Deal Number (Deal ID)"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

interface DocuRideRow {
  id: string; Name: string; Sale_Date: string; Store_Location: string | null; Reynolds_Documents: string | null;
  Dealership_Name: string | null; Dealership_Street: string | null; Dealership_City: string | null;
  Dealership_State: string | null; Dealership_ZIP: string | null;
}

type Transport = "implicit" | "explicit";
type Wire = Deno.TlsConn | Deno.TcpConn;

// ---------- auth (gateway already verified the JWT signature) ----------
function actorFromJwt(auth: string): { trigger: "cron" | "admin"; email: string } | null {
  const token = auth.replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.role === "service_role") return { trigger: "cron", email: "cron" };
    if (payload.email) return { trigger: "admin", email: payload.email };
  } catch { /* fallthrough */ }
  return null;
}

// ---------- period ----------
function resolvePeriod(monthParam?: string | null) {
  let y: number, m: number;
  if (monthParam && /^\d{6}$/.test(monthParam)) { y = +monthParam.slice(0, 4); m = +monthParam.slice(4, 6); }
  else { const n = new Date(); const p = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1)); y = p.getUTCFullYear(); m = p.getUTCMonth() + 1; }
  const mm = String(m).padStart(2, "0");
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { yyyymm: `${y}${mm}`, start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

// ---------- zoho ----------
async function zohoAccessToken(): Promise<string> {
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: ENV.zohoClientId, client_secret: ENV.zohoClientSecret, refresh_token: ENV.zohoRefreshToken });
  const r = await fetch(`${ENV.zohoAccounts}/oauth/v2/token`, { method: "POST", body });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Zoho token error: ${j.error ?? "unknown"}`);
  return j.access_token;
}

async function fetchDeals(token: string, start: string, end: string): Promise<DocuRideRow[]> {
  const out: DocuRideRow[] = []; const pageSize = 200; let offset = 0;
  const statusList = REPORTABLE_STATUSES.map((v) => `'${v}'`).join(",");
  const signedList = SIGNED_STATUSES.map((v) => `'${v}'`).join(",");
  for (;;) {
    // COQL accepts only two conditions per parenthesis level — nest pairwise.
    const select_query =
      `SELECT id, Name, Sale_Date, Store_Location, Reynolds_Documents, Dealership_Name, Dealership_Street, Dealership_City, Dealership_State, Dealership_ZIP FROM DocuRide ` +
      `WHERE ((((Sale_Date between '${start}' and '${end}') and (Deal_Status in (${statusList}))) and (eSign_Status in (${signedList}))) and (Reynolds_Documents is not null)) ` +
      `ORDER BY Sale_Date asc, Name asc LIMIT ${pageSize} OFFSET ${offset}`;
    const r = await fetch(`${ENV.zohoApi}/crm/v8/coql`, { method: "POST", headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ select_query }) });
    if (r.status === 204) break;
    if (!r.ok) throw new Error(`COQL ${r.status}: ${await r.text()}`);
    const j = await r.json();
    out.push(...j.data);
    if (!j.info?.more_records) break;
    offset += pageSize;
  }
  return out;
}

// ---------- transform ----------
// Reynolds_Documents is pipe-delimited (legacy records used comma). One row per Form ID.
function parseFormIds(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  return raw.split(/[|,\n\r]+/).map((s) => s.trim()).filter((s) => s && !seen.has(s) && seen.add(s));
}
const toMMDDYYYY = (iso: string) => { const [y, m, d] = iso.split("-"); return `${m}/${d}/${y}`; };
const csvCell = (v: unknown) => `"${(v == null ? "" : String(v)).replace(/"/g, '""')}"`;

function buildRows(deals: DocuRideRow[]) {
  const rows: { store: string; cells: string[] }[] = [];
  for (const d of deals) for (const formId of parseFormIds(d.Reynolds_Documents))
    rows.push({ store: d.Store_Location ?? "", cells: [toMMDDYYYY(d.Sale_Date), formId, d.Dealership_Name ?? "", d.Dealership_Name ?? "", d.Dealership_Street ?? "", d.Dealership_City ?? "", d.Dealership_State ?? "", d.Dealership_ZIP ?? "", d.Name] });
  return rows;
}
const toCsv = (rows: { cells: string[] }[]) => [HEADERS, ...rows.map((r) => r.cells)].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

// ---------- FTPS transport ----------
const enc = new TextEncoder(), dec = new TextDecoder();

// Every network step races a deadline — a silent drop (firewalled port, black-holed
// handshake) must surface as a red error in seconds, not a hung request.
function withTimeout<T>(p: Promise<T>, label: string, ms = ENV.ftpTimeoutMs): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function readReply(c: Wire, label = "reply"): Promise<string> {
  let text = "";
  const buf = new Uint8Array(8192);
  for (;;) {
    const n = await withTimeout(c.read(buf), label); if (!n) break;
    text += dec.decode(buf.subarray(0, n));
    const lines = text.trimEnd().split("\n"); const last = lines[lines.length - 1];
    if (/^\d{3} /.test(last)) break;
  }
  return text.trim();
}

async function cmd(c: Wire, s: string, expect: number[], redact = false): Promise<string> {
  const label = s.split(" ")[0];
  await withTimeout(c.write(enc.encode(s + "\r\n")), label);
  const r = await readReply(c, label); const code = +r.slice(0, 3);
  if (!expect.includes(code)) throw new Error(`${redact ? label : s} -> ${r}`);
  return r;
}

// Control connection for either transport. Explicit: plain :21, 220 banner, AUTH TLS, upgrade.
// Implicit: TLS-from-byte-one on :990.
async function ftpsControl(transport: Transport): Promise<{ ctl: Deno.TlsConn; banner: string; port: number }> {
  if (transport === "implicit") {
    const port = ENV.implicitPort;
    const ctl = await withTimeout(Deno.connectTls({ hostname: ENV.ftpHost, port }), `implicit connect :${port}`);
    const banner = await readReply(ctl, "banner");
    if (!/^220/.test(banner)) { ctl.close(); throw new Error(`banner -> ${banner}`); }
    return { ctl, banner, port };
  }
  const port = ENV.explicitPort;
  const plain = await withTimeout(Deno.connect({ hostname: ENV.ftpHost, port }), `explicit connect :${port}`);
  const banner = await readReply(plain, "banner");
  if (!/^220/.test(banner)) { plain.close(); throw new Error(`banner -> ${banner}`); }
  await cmd(plain, "AUTH TLS", [234]);
  const ctl = await withTimeout(Deno.startTls(plain, { hostname: ENV.ftpHost }), "TLS upgrade");
  return { ctl, banner, port };
}

async function ftpsLogin(ctl: Deno.TlsConn): Promise<string> {
  await cmd(ctl, `USER ${ENV.ftpUser}`, [331, 230]);
  return await cmd(ctl, `PASS ${ENV.ftpPass}`, [230], true);
}

function transportsToTry(): Transport[] {
  if (ENV.transport === "implicit" || ENV.transport === "explicit") return [ENV.transport];
  return ["implicit", "explicit"];
}

// ---------- relay (Vercel courier) ----------

/**
 * The relay is the only path that currently reaches the drop from here. It
 * takes the credentials in the body — this function holds them, the relay does
 * not — and returns whatever the FTP server said.
 */
async function callRelay(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!ENV.relayUrl) throw new Error("FTPS_RELAY_URL not set");
  if (!ENV.ftpUser || !ENV.ftpPass) throw new Error("RR_FTP_USER / RR_FTP_PASS not set");
  const r = await fetch(ENV.relayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-relay-secret": ENV.relaySecret },
    body: JSON.stringify({ user: ENV.ftpUser, pass: ENV.ftpPass, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`relay ${r.status}: ${j.error ?? "unknown"}`);
  return j;
}

async function uploadRelay(filename: string, content: string): Promise<string> {
  const j = await callRelay({ action: "upload", filename, content });
  return String(j.ftp ?? "ok");
}

async function loginTestRelay(): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const j = await callRelay({ action: "login-test" });
  return { ok: true, via: "relay", host: ENV.ftpHost, user: ENV.ftpUser, banner: j.banner ?? "", ms: Date.now() - t0 };
}

// Connection/credential check. Logs in, quits. Touches no files.
async function loginTest(): Promise<Record<string, unknown>> {
  // Same switch the submit path uses, so a green test means the mode that will
  // actually run is the one that was proven.
  if (ENV.ftpsMode === "relay") return await loginTestRelay();

  if (!ENV.ftpUser || !ENV.ftpPass) throw new Error("RR_FTP_USER / RR_FTP_PASS not set");
  const attempts: Record<string, string> = {};
  for (const transport of transportsToTry()) {
    const t0 = Date.now();
    try {
      const { ctl, banner, port } = await ftpsControl(transport);
      try {
        const login = await ftpsLogin(ctl);
        await cmd(ctl, "QUIT", [221]).catch(() => {});
        return { ok: true, via: "native", transport, host: `${ENV.ftpHost}:${port}`, user: ENV.ftpUser, banner, login, ms: Date.now() - t0, attempts };
      } finally { try { ctl.close(); } catch { /* already closed */ } }
    } catch (err) {
      attempts[transport] = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(JSON.stringify(attempts));
}

async function uploadNative(filename: string, content: string): Promise<string> {
  let lastErr: Error | null = null;
  for (const transport of transportsToTry()) {
    try {
      return await uploadVia(transport, filename, content);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error("no transport available");
}

async function uploadVia(transport: Transport, filename: string, content: string): Promise<string> {
  const { ctl } = await ftpsControl(transport);
  try {
    await ftpsLogin(ctl);
    await cmd(ctl, "PBSZ 0", [200]);
    await cmd(ctl, "PROT P", [200]);
    await cmd(ctl, "TYPE I", [200]);
    if (ENV.ftpPath) await cmd(ctl, `CWD ${ENV.ftpPath}`, [250]);
    const pasv = await cmd(ctl, "PASV", [227]);
    // PASV replies with an unroutable internal IP by design — use the hostname, take only the port.
    const m = pasv.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/); if (!m) throw new Error("bad PASV");
    const dataPort = (+m[5]) * 256 + (+m[6]);
    // Data connection is TLS for both transports (implicit by nature; PROT P for explicit).
    const data = await withTimeout(Deno.connectTls({ hostname: ENV.ftpHost, port: dataPort }), `data connect :${dataPort}`);
    await ctl.write(enc.encode(`STOR ${filename}\r\n`));
    const storReply = await readReply(ctl, "STOR"); if (!/^1\d\d/.test(storReply)) { data.close(); throw new Error(`STOR -> ${storReply}`); }
    await withTimeout(data.write(enc.encode(content)), "data write");
    data.close();
    const done = await readReply(ctl, "transfer");
    await cmd(ctl, "QUIT", [221]).catch(() => {});
    if (!/^2\d\d/.test(done)) throw new Error(`transfer -> ${done}`);
    return `${transport}: ${done}`;
  } finally { try { ctl.close(); } catch { /* already closed */ } }
}

// ---------- run log ----------
async function logRun(row: Record<string, unknown>) {
  try {
    await fetch(`${ENV.supabaseUrl}/rest/v1/rr_report_runs`, { method: "POST", headers: { apikey: ENV.serviceKey, Authorization: `Bearer ${ENV.serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(row) });
  } catch (e) { console.error("log failed", e); }
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const actor = actorFromJwt(req.headers.get("authorization") ?? "");
  if (!actor) return json({ error: "Sign in required" }, 401);

  const url = new URL(req.url);
  const modeParam = url.searchParams.get("mode");
  const mode = actor.trigger === "cron" ? "submit" : (modeParam ?? "preview");
  if (!["preview", "csv", "submit", "login-test"].includes(mode)) return json({ error: "Bad mode" }, 400);

  // Connection test: no Zoho, no CSV, no file. Admin only.
  if (mode === "login-test") {
    try {
      const result = await loginTest();
      return json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("login-test failed", message);
      return json({ ok: false, host: ENV.ftpHost, error: message }, 500);
    }
  }

  const period = resolvePeriod(url.searchParams.get("month"));
  const filename = `${ENV.companyPrefix}_${ENV.accountNumber}_${period.yyyymm}.csv`;
  const base = { period: period.yyyymm, filename, mode: mode === "csv" ? "preview" : mode, trigger: actor.trigger, run_by: actor.email };

  try {
    const token = await zohoAccessToken();
    const deals = await fetchDeals(token, period.start, period.end);
    const rows = buildRows(deals);
    const csv = toCsv(rows);

    if (mode === "csv") return new Response(csv, { headers: { ...CORS, "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${filename}"` } });

    const byStore: Record<string, number> = {};
    for (const r of rows) byStore[r.store] = (byStore[r.store] ?? 0) + 1;

    let ftp: string | null = null;
    if (mode === "submit") ftp = ENV.ftpsMode === "relay" ? await uploadRelay(filename, csv) : await uploadNative(filename, csv);

    await logRun({ ...base, status: "ok", deal_count: deals.length, row_count: rows.length, ftp_response: ftp });
    return json({ period: period.yyyymm, range: { start: period.start, end: period.end }, filename, mode, deals: deals.length, transactions: rows.length, byStore, headers: HEADERS, rows: rows.map((r) => r.cells), stores: rows.map((r) => r.store), ftp });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("rr-report failed", message);
    await logRun({ ...base, status: "error", error: message });
    return json({ period: period.yyyymm, filename, error: message }, 500);
  }
});
