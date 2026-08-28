# DocuRide Architecture — Ruling (2026-08-27)

**This section overrides anything in MIGRATION_PATH.md §1–2 or CLAUDE.md that says
"Vercel is the API layer" or "No Edge Functions." Decision made explicitly by Jim.**

## The rule

**Supabase is the brain. Vercel is the face.**

- **Supabase Postgres** — canonical data, RLS, Auth.
- **Supabase Edge Functions** — ALL integration and business logic: Zoho sync,
  DX1, R&R report assembly, TILA (when ported), F&I dispatch, document generation.
- **Vercel** — static UI (marketing, admin, future app screens) and exactly ONE
  class of serverless function: protocol relays that Deno cannot perform.
  Today that is a single FTPS relay for Reynolds & Reynolds. Nothing else.

## The one standing exception

Deno cannot do explicit FTPS (AUTH TLS, port 21). The R&R edge function
therefore calls a Vercel relay endpoint to transmit the finished CSV. The relay
is dumb: it receives bytes + destination, it sends them, it returns the FTP
response. It holds FTPS credentials only. It contains no business logic.

If Deno gains FTPS support, or R&R offers an HTTPS submission path, the relay
is deleted and Vercel becomes UI-only.

## Secrets placement (consequence of the rule)

| Secret | Lives in |
|---|---|
| Zoho client id / secret / refresh token | Supabase Edge Function secrets |
| Supabase service role key | Edge Functions have it natively; NOT needed in Vercel |
| R&R FTPS credentials | Vercel env vars (the relay) |
| RELAY_SECRET (edge fn -> Vercel relay auth) | Both: Supabase secret + Vercel env var |
| ZOHO_WEBHOOK_SECRET | Supabase Edge Function secret (webhook lands on the edge fn) |
| CRON_SECRET | Retired for sync; pg_cron is internal. Kept only if a Vercel relay endpoint needs protecting. |

## Scheduling (consequence of the rule)

No Vercel crons for business logic. Scheduling is `pg_cron` inside Postgres
invoking Edge Functions via `pg_net`, or Supabase's native cron. The sync
sweeper and the monthly R&R trigger both live there.

## What this kills

- api/sync/*.ts and api/deals/[id].ts in Vercel — logic moves to Edge Functions.
- api/reports/reyrey.ts in Vercel — the edge `rr-report` function is the real one;
  the Vercel copy is deleted after its FTPS section is extracted into the relay.
- Vercel cron entries for sync and R&R.

## What this keeps

- admin.html and all UI on Vercel, calling `${SUPABASE_URL}/functions/v1/*`.
- ftps relay on Vercel (rename to api/relay/ftps.ts, secret-gated).
