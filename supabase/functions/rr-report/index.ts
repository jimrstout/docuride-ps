// rr-report — Reynolds & Reynolds monthly transaction report
// GET ?month=YYYYMM&mode=preview|csv|submit|login-test|review-request|submit-if-approved|submit-if-unsent
// Auth: Supabase user JWT (admin UI) or service-role JWT (pg_cron).
// Delivery: RR_FTPS_MODE=relay hands the file to the Vercel courier (api/rr-relay), the only
// component that speaks FTPS to R&R — Supabase's network cannot reach ftps.lz.reyrey.com (proven 2026-09-02).
// Review workflow: cron on the 5th emails a review request (recipients from rr_report_settings),
// the 7th submits if approved (rr_report_approvals), the 9th submits regardless if still unsent.

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
  transport: Deno.env.get("RR_FTPS_TRANSPORT") ?? "auto", // implicit | explicit | auto (native mode only)
  ftpsMode: Deno.env.get("RR_FTPS_MODE") ?? "native", // native | relay
  relayUrl: Deno.env.get("FTPS_RELAY_URL") ?? "",
  relaySecret: Deno.env.get("FTPS_RELAY_SECRET") ?? "",
  ftpTimeoutMs: Number(Deno.env.get("RR_FTP_TIMEOUT_MS") ?? 15000),
  mailToken: Deno.env.get("ZEPTOMAIL_SEND_TOKEN") ?? "",
  mailFrom: Deno.env.get("RR_MAIL_FROM") ?? "noreply-reports@docuride.com",
  adminUrl: Deno.env.get("ADMIN_URL") ?? "https://docuride.com/admin",
};

// Deals remain reportable after posting — status advances Completed -> Posted and must not drop rows.
const REPORTABLE_STATUSES = ["Completed Sale (Accounting)", "Posted (Sales Complete)"];
const SIGNED_STATUSES = ["Documents Signed", "Documents Filed"];
const HEADERS = ["Transaction Date","Form ID","Company Customer Name","Company Customer dba","Company Customer Address","City","State","Zip Code","Deal Number (Deal ID)"];
const CRON_MODES = ["review-request", "submit-if-approved", "submit-if-unsent"];

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

// ---------- FTPS transport (native path — retained; unusable from Supabase's network) ----------
const enc = new TextEncoder(), dec = new TextDecoder();

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

async function loginTest(): Promise<Record<string, unknown>> {
  if (!ENV.ftpUser || !ENV.ftpPass) throw new Error("RR_FTP_USER / RR_FTP_PASS not set");
  if (ENV.ftpsMode === "relay") {
    const t0 = Date.now();
    const r = await relayRequest({ action: "login-test", user: ENV.ftpUser, pass: ENV.ftpPass });
    return { ok: true, transport: "relay", host: `${ENV.ftpHost}:${ENV.implicitPort}`, user: ENV.ftpUser, banner: r.banner ?? "", login: r.login ?? "ok", ms: Date.now() - t0 };
  }
  const attempts: Record<string, string> = {};
  for (const transport of transportsToTry()) {
    const t0 = Date.now();
    try {
      const { ctl, banner, port } = await ftpsControl(transport);
      try {
        const login = await ftpsLogin(ctl);
        await cmd(ctl, "QUIT", [221]).catch(() => {});
        return { ok: true, transport, host: `${ENV.ftpHost}:${port}`, user: ENV.ftpUser, banner, login, ms: Date.now() - t0, attempts };
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

// ---------- relay via Vercel courier ----------
async function relayRequest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!ENV.relayUrl) throw new Error("FTPS_RELAY_URL not set");
  const r = await fetch(ENV.relayUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-relay-secret": ENV.relaySecret }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`relay ${r.status}: ${j.error ?? "unknown"}`);
  return j;
}

async function uploadRelay(filename: string, content: string): Promise<string> {
  const j = await relayRequest({ action: "upload", user: ENV.ftpUser, pass: ENV.ftpPass, filename, content });
  return String(j.ftp ?? "ok");
}

// ---------- supabase REST (service role) ----------
async function rest(path: string): Promise<unknown[]> {
  const r = await fetch(`${ENV.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: ENV.serviceKey, Authorization: `Bearer ${ENV.serviceKey}` } });
  if (!r.ok) throw new Error(`rest ${path} -> ${r.status}`);
  return await r.json();
}
async function reviewEmails(): Promise<string[]> {
  const rows = await rest("rr_report_settings?id=eq.1&select=review_emails") as { review_emails: string[] }[];
  return rows[0]?.review_emails ?? [];
}
async function alreadySubmitted(period: string): Promise<boolean> {
  const rows = await rest(`rr_report_runs?period=eq.${period}&mode=eq.submit&status=eq.ok&select=id&limit=1`);
  return rows.length > 0;
}
async function isApproved(period: string): Promise<boolean> {
  const rows = await rest(`rr_report_approvals?period=eq.${period}&select=id&limit=1`);
  return rows.length > 0;
}

// ---------- email via ZeptoMail HTTP API ----------
async function sendMail(to: string[], subject: string, html: string): Promise<string> {
  if (!ENV.mailToken) return "skipped: ZEPTOMAIL_SEND_TOKEN not set";
  if (!to.length) return "skipped: no recipients configured";
  const auth = ENV.mailToken.startsWith("Zoho-enczapikey") ? ENV.mailToken : `Zoho-enczapikey ${ENV.mailToken}`;
  const r = await fetch("https://api.zeptomail.com/v1.1/email", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: { address: ENV.mailFrom, name: "DocuRide Reports" },
      to: to.map((address) => ({ email_address: { address } })),
      subject,
      htmlbody: html,
    }),
  });
  if (!r.ok) throw new Error(`zeptomail ${r.status}: ${await r.text()}`);
  return `sent to ${to.length} recipient(s)`;
}

function prettyPeriod(yyyymm: string): string {
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${months[+yyyymm.slice(4, 6) - 1]} ${yyyymm.slice(0, 4)}`;
}

function reviewEmailHtml(periodLabel: string, filename: string, deals: number, forms: number, byStore: Record<string, number>): string {
  const storeRows = Object.entries(byStore).sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `<tr><td style="padding:4px 12px 4px 0">${s || "(no store)"}</td><td style="padding:4px 0;text-align:right">${n}</td></tr>`).join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;max-width:560px">
    <h2 style="margin:0 0 4px">R&amp;R report ready for review — ${periodLabel}</h2>
    <p style="color:#6b7280;margin:0 0 16px">${filename}</p>
    <p><strong>${forms}</strong> form rows across <strong>${deals}</strong> deals:</p>
    <table style="border-collapse:collapse;margin:0 0 16px">${storeRows}</table>
    <p><a href="${ENV.adminUrl}" style="background:#c2410c;color:#fff;padding:10px 18px;text-decoration:none;border-radius:4px;display:inline-block">Review &amp; approve in the admin panel</a></p>
    <p style="color:#6b7280;font-size:12px;margin-top:16px">Approve by the 7th for on-time submission. If not reviewed, this report submits automatically on the 9th. This mailbox is not monitored.</p>
  </div>`;
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
  const mode = actor.trigger === "cron" ? (modeParam && CRON_MODES.includes(modeParam) ? modeParam : "submit") : (modeParam ?? "preview");
  if (!["preview", "csv", "submit", "login-test", ...CRON_MODES].includes(mode)) return json({ error: "Bad mode" }, 400);

  // Connection test: no Zoho, no CSV, no file.
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
  const base = { period: period.yyyymm, filename, mode, trigger: actor.trigger, run_by: actor.email };

  try {
    // Dead-man's-switch pre-checks: cheap, no Zoho query, and never double-send.
    if (mode === "submit-if-approved" || mode === "submit-if-unsent") {
      if (await alreadySubmitted(period.yyyymm)) {
        await logRun({ ...base, status: "ok", ftp_response: "skipped: already submitted this period" });
        return json({ period: period.yyyymm, mode, skipped: "already submitted" });
      }
      if (mode === "submit-if-approved" && !(await isApproved(period.yyyymm))) {
        await logRun({ ...base, status: "ok", ftp_response: "skipped: not approved yet; unattended send on the 9th" });
        return json({ period: period.yyyymm, mode, skipped: "awaiting approval" });
      }
    }

    const token = await zohoAccessToken();
    const deals = await fetchDeals(token, period.start, period.end);
    const rows = buildRows(deals);
    const csv = toCsv(rows);
    const byStore: Record<string, number> = {};
    for (const r of rows) byStore[r.store] = (byStore[r.store] ?? 0) + 1;

    if (mode === "csv") return new Response(csv, { headers: { ...CORS, "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${filename}"` } });

    if (mode === "review-request") {
      const to = await reviewEmails();
      const mail = await sendMail(to, `Review R&R report — ${prettyPeriod(period.yyyymm)} (${rows.length} forms, ${deals.length} deals)`, reviewEmailHtml(prettyPeriod(period.yyyymm), filename, deals.length, rows.length, byStore));
      await logRun({ ...base, status: "ok", deal_count: deals.length, row_count: rows.length, ftp_response: `review email: ${mail}` });
      return json({ period: period.yyyymm, mode, deals: deals.length, transactions: rows.length, byStore, mail });
    }

    // preview | submit | submit-if-approved | submit-if-unsent
    let ftp: string | null = null;
    if (mode !== "preview") {
      ftp = ENV.ftpsMode === "relay" ? await uploadRelay(filename, csv) : await uploadNative(filename, csv);
    }

    await logRun({ ...base, mode: mode === "preview" ? "preview" : "submit", status: "ok", deal_count: deals.length, row_count: rows.length, ftp_response: ftp ? `${ftp}${mode !== "submit" ? ` (${mode})` : ""}` : null });
    return json({ period: period.yyyymm, range: { start: period.start, end: period.end }, filename, mode, deals: deals.length, transactions: rows.length, byStore, headers: HEADERS, rows: rows.map((r) => r.cells), stores: rows.map((r) => r.store), ftp });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("rr-report failed", message);
    await logRun({ ...base, status: "error", error: message });
    if (actor.trigger === "cron") {
      try {
        const to = await reviewEmails();
        await sendMail(to, `R&R report automation FAILED — ${prettyPeriod(period.yyyymm)}`, `<div style="font-family:Arial,sans-serif;font-size:14px"><p>The scheduled <strong>${mode}</strong> run for ${prettyPeriod(period.yyyymm)} failed:</p><pre style="background:#f3f4f6;padding:12px;border-radius:4px">${message.replace(/</g, "&lt;")}</pre><p>The report was <strong>not</strong> submitted. Manual submission is available in the admin panel; the deadline is the 14th.</p><p><a href="${ENV.adminUrl}">${ENV.adminUrl}</a></p></div>`);
      } catch (mailErr) { console.error("failure alert email failed", mailErr); }
    }
    return json({ period: period.yyyymm, filename, error: message }, 500);
  }
});
