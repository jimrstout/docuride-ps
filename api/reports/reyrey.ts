import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Client } from "basic-ftp";
import { Readable } from "node:stream";

/*
 * Reynolds & Reynolds monthly transaction report.
 *
 * Cron (2nd of month): submits prior month. Auth: Authorization: Bearer CRON_SECRET
 * Admin UI:            GET ?month=YYYYMM&mode=preview|submit|csv
 *                      Auth: Authorization: Bearer <Supabase user access token>
 *
 * Every run is logged to Supabase public.rr_report_runs.
 */

const ENV = {
  zohoClientId: process.env.ZOHO_CLIENT_ID!,
  zohoClientSecret: process.env.ZOHO_CLIENT_SECRET!,
  zohoRefreshToken: process.env.ZOHO_REFRESH_TOKEN!,
  zohoAccounts: process.env.ZOHO_ACCOUNTS_DOMAIN ?? "https://accounts.zoho.com",
  zohoApi: process.env.ZOHO_API_DOMAIN ?? "https://www.zohoapis.com",
  ftpHost: process.env.RR_FTP_HOST ?? "ftps.lz.reyrey.com",
  ftpPort: Number(process.env.RR_FTP_PORT ?? 21),
  ftpUser: process.env.RR_FTP_USER!,
  ftpPass: process.env.RR_FTP_PASS!,
  ftpPath: process.env.RR_FTP_PATH ?? "",
  companyPrefix: process.env.RR_COMPANY_PREFIX!,
  accountNumber: process.env.RR_ACCOUNT_NUMBER!,
  cronSecret: process.env.CRON_SECRET!,
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
};

const FINALIZED_STATUS = "Completed Sale (Accounting)";
const SIGNED_STATUS = "Documents Filed";

const HEADERS = [
  "Transaction Date",
  "Form ID",
  "Company Customer Name",
  "Company Customer dba",
  "Company Customer Address",
  "City",
  "State",
  "Zip Code",
  "Deal Number (Deal ID)",
];

type Mode = "preview" | "submit" | "csv";

interface DocuRideRow {
  id: string;
  Name: string;
  Sale_Date: string;
  Store_Location: string | null;
  Reynolds_Documents: string | null;
  Dealership_Name: string | null;
  Dealership_Street: string | null;
  Dealership_City: string | null;
  Dealership_State: string | null;
  Dealership_ZIP: string | null;
}

interface Actor { trigger: "cron" | "admin"; email: string }

// ---------- auth ----------

async function authenticate(req: VercelRequest): Promise<Actor | null> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  if (token === ENV.cronSecret) return { trigger: "cron", email: "cron" };

  const r = await fetch(`${ENV.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: ENV.supabaseAnonKey, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = (await r.json()) as { email?: string };
  return u.email ? { trigger: "admin", email: u.email } : null;
}

// ---------- period ----------

function resolvePeriod(monthParam?: string) {
  let y: number, m: number;
  if (monthParam && /^\d{6}$/.test(monthParam)) {
    y = Number(monthParam.slice(0, 4));
    m = Number(monthParam.slice(4, 6));
  } else {
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    y = prev.getUTCFullYear();
    m = prev.getUTCMonth() + 1;
  }
  const mm = String(m).padStart(2, "0");
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    yyyymm: `${y}${mm}`,
    start: `${y}-${mm}-01`,
    end: `${y}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

// ---------- zoho ----------

async function zohoAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ENV.zohoClientId,
    client_secret: ENV.zohoClientSecret,
    refresh_token: ENV.zohoRefreshToken,
  });
  const r = await fetch(`${ENV.zohoAccounts}/oauth/v2/token`, { method: "POST", body });
  const j = (await r.json()) as { access_token?: string; error?: string };
  if (!j.access_token) throw new Error(`Zoho token error: ${j.error ?? "unknown"}`);
  return j.access_token;
}

async function fetchDeals(token: string, start: string, end: string): Promise<DocuRideRow[]> {
  const out: DocuRideRow[] = [];
  const pageSize = 200;
  let offset = 0;
  for (;;) {
    const select_query =
      `SELECT id, Name, Sale_Date, Store_Location, Reynolds_Documents, Dealership_Name, ` +
      `Dealership_Street, Dealership_City, Dealership_State, Dealership_ZIP FROM DocuRide ` +
      `WHERE Sale_Date between '${start}' and '${end}' ` +
      `and Deal_Status = '${FINALIZED_STATUS}' ` +
      `and eSign_Status = '${SIGNED_STATUS}' ` +
      `and Reynolds_Documents is not null ` +
      `ORDER BY Sale_Date asc, Name asc LIMIT ${pageSize} OFFSET ${offset}`;

    const r = await fetch(`${ENV.zohoApi}/crm/v8/coql`, {
      method: "POST",
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ select_query }),
    });
    if (r.status === 204) break;
    if (!r.ok) throw new Error(`COQL ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as { data: DocuRideRow[]; info: { more_records: boolean } };
    out.push(...j.data);
    if (!j.info.more_records) break;
    offset += pageSize;
  }
  return out;
}

// ---------- transform ----------

function parseFormIds(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  return raw
    .split(/[|\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !seen.has(s) && seen.add(s));
}

function toMMDDYYYY(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

interface ReportRow { cells: string[]; store: string }

function buildRows(deals: DocuRideRow[]): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const d of deals) {
    for (const formId of parseFormIds(d.Reynolds_Documents)) {
      rows.push({
        store: d.Store_Location ?? "",
        cells: [
          toMMDDYYYY(d.Sale_Date),
          formId,
          d.Dealership_Name ?? "",
          d.Dealership_Name ?? "", // dba
          d.Dealership_Street ?? "",
          d.Dealership_City ?? "",
          d.Dealership_State ?? "",
          d.Dealership_ZIP ?? "",
          d.Name,
        ],
      });
    }
  }
  return rows;
}

function toCsv(rows: ReportRow[]): string {
  return [HEADERS, ...rows.map((r) => r.cells)].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---------- ftps ----------

async function uploadFtps(filename: string, content: string): Promise<string> {
  const client = new Client(30_000);
  try {
    await client.access({
      host: ENV.ftpHost,
      port: ENV.ftpPort,
      user: ENV.ftpUser,
      password: ENV.ftpPass,
      secure: true,
    });
    if (ENV.ftpPath) await client.ensureDir(ENV.ftpPath);
    const res = await client.uploadFrom(Readable.from([Buffer.from(content, "utf8")]), filename);
    return res.message;
  } finally {
    client.close();
  }
}

// ---------- run log ----------

async function logRun(row: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${ENV.supabaseUrl}/rest/v1/rr_report_runs`, {
      method: "POST",
      headers: {
        apikey: ENV.supabaseServiceKey,
        Authorization: `Bearer ${ENV.supabaseServiceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
  } catch (e) {
    console.error("run log failed", e);
  }
}

// ---------- handler ----------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const actor = await authenticate(req);
  if (!actor) return res.status(401).json({ error: "Sign in required" });

  const monthParam = typeof req.query.month === "string" ? req.query.month : undefined;
  const modeParam = typeof req.query.mode === "string" ? req.query.mode : undefined;
  const mode: Mode = actor.trigger === "cron" ? "submit" : (modeParam as Mode) ?? "preview";
  if (!["preview", "submit", "csv"].includes(mode)) return res.status(400).json({ error: "Bad mode" });

  const period = resolvePeriod(monthParam);
  const filename = `${ENV.companyPrefix}_${ENV.accountNumber}_${period.yyyymm}.csv`;

  const base = {
    period: period.yyyymm,
    filename,
    mode: mode === "csv" ? "preview" : mode,
    trigger: actor.trigger,
    run_by: actor.email,
  };

  try {
    const token = await zohoAccessToken();
    const deals = await fetchDeals(token, period.start, period.end);
    const rows = buildRows(deals);
    const csv = toCsv(rows);

    if (mode === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.status(200).send(csv);
    }

    const byStore: Record<string, number> = {};
    for (const r of rows) byStore[r.store] = (byStore[r.store] ?? 0) + 1;

    let ftp: string | null = null;
    if (mode === "submit") ftp = await uploadFtps(filename, csv);

    await logRun({ ...base, status: "ok", deal_count: deals.length, row_count: rows.length, ftp_response: ftp });

    return res.status(200).json({
      period: period.yyyymm,
      range: { start: period.start, end: period.end },
      filename,
      mode,
      deals: deals.length,
      transactions: rows.length,
      byStore,
      headers: HEADERS,
      rows: rows.map((r) => r.cells),
      ftp,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("reyrey report failed", message);
    await logRun({ ...base, status: "error", error: message });
    return res.status(500).json({ period: period.yyyymm, filename, error: message });
  }
}
