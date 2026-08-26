import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Client } from "basic-ftp";
import { Readable } from "node:stream";

/*
 * Reynolds & Reynolds monthly transaction report.
 * Cron: runs on the 2nd of each month for the prior calendar month.
 * Manual: GET /api/reports/reyrey?month=YYYYMM[&dry=1]  (Authorization: Bearer CRON_SECRET)
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

interface DocuRideRow {
  id: string;
  Name: string;
  Sale_Date: string;
  Reynolds_Documents: string | null;
  Dealership_Name: string | null;
  Dealership_Street: string | null;
  Dealership_City: string | null;
  Dealership_State: string | null;
  Dealership_ZIP: string | null;
}

// ---------- period ----------

function resolvePeriod(monthParam?: string) {
  let y: number, m: number; // m = 1..12
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
      `SELECT id, Name, Sale_Date, Reynolds_Documents, Dealership_Name, Dealership_Street, ` +
      `Dealership_City, Dealership_State, Dealership_ZIP FROM DocuRide ` +
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

function buildRows(deals: DocuRideRow[]): string[][] {
  const rows: string[][] = [];
  for (const d of deals) {
    for (const formId of parseFormIds(d.Reynolds_Documents)) {
      rows.push([
        toMMDDYYYY(d.Sale_Date),
        formId,
        d.Dealership_Name ?? "",
        d.Dealership_Name ?? "", // dba — same as name unless a distinct dba field exists
        d.Dealership_Street ?? "",
        d.Dealership_City ?? "",
        d.Dealership_State ?? "",
        d.Dealership_ZIP ?? "",
        d.Name,
      ]);
    }
  }
  return rows;
}

function toCsv(rows: string[][]): string {
  return [HEADERS, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
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
      secure: true, // explicit FTPS (AUTH TLS) on port 21
    });
    if (ENV.ftpPath) await client.ensureDir(ENV.ftpPath);
    const res = await client.uploadFrom(Readable.from([Buffer.from(content, "utf8")]), filename);
    return res.message;
  } finally {
    client.close();
  }
}

// ---------- handler ----------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${ENV.cronSecret}`) return res.status(401).json({ error: "unauthorized" });

  const monthParam = typeof req.query.month === "string" ? req.query.month : undefined;
  const dry = req.query.dry === "1";
  const period = resolvePeriod(monthParam);
  const filename = `${ENV.companyPrefix}_${ENV.accountNumber}_${period.yyyymm}.csv`;

  try {
    const token = await zohoAccessToken();
    const deals = await fetchDeals(token, period.start, period.end);
    const rows = buildRows(deals);
    const csv = toCsv(rows);

    if (dry) {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      return res.status(200).send(csv);
    }

    const ftpMessage = await uploadFtps(filename, csv);
    return res.status(200).json({
      period: period.yyyymm,
      filename,
      deals: deals.length,
      transactions: rows.length,
      ftp: ftpMessage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("reyrey report failed", message);
    return res.status(500).json({ period: period.yyyymm, filename, error: message });
  }
}
