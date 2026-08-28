# DocuRide — Claude Code project guide

DocuRide is a contract-generation / deal-management platform for powersports & RV dealers.
Migrating from Zoho CRM (Deluge) to Supabase + Vercel per docs/MIGRATION_PATH.md.

## Stack

**Supabase is the brain. Vercel is the face.** See ARCHITECTURE.md — it is the
ruling and it overrides MIGRATION_PATH.md §1–2 wherever they disagree.

- Supabase project `fovccigwlcmmzfubpfny`: Postgres (canonical data), RLS, Auth.
- **Supabase Edge Functions (Deno): ALL integration and business logic** — Zoho
  sync, DX1, R&R assembly, TILA, F&I dispatch, document generation.
- Vercel: static HTML (marketing + admin) and exactly ONE class of serverless
  function — protocol relays Deno cannot perform. Today that is the R&R FTPS
  relay, and nothing else.
- Zoho CRM v8 API: module `DocuRide` (289 fields), `Lienholders`, `Credit_Applications`, `Leads`. Mirrored into `public.deals`.
- Secrets: Zoho credentials and webhook secrets are **Supabase Edge Function
  secrets**. Vercel env vars hold only the FTPS relay credentials and the shared
  RELAY_SECRET. `.env` is gitignored.

## Rules
- One change type per commit. Never bundle unrelated edits.
- Post full files, not diffs, when showing code to Jim.
- Zoho field API names are case-sensitive. Verify before use (`Days_to_First_Payment`, `IDAHO`, etc.).
- COQL: max two conditions per parenthesis level — nest pairwise.
- User-facing text says "your DMS", never "DX1".
- Field ownership: each Zoho field has exactly one writer (`field_ownership` table). Default owner is Zoho. Web writes only `owner='web'` fields, via `/api/deals/:id`.
- Service-role key is server-side only. Browser gets anon key + user JWT.
  Edge Functions get it natively as `SUPABASE_SERVICE_ROLE_KEY`; it is not needed in Vercel.
- Scheduling is `pg_cron` + `pg_net` inside Postgres. No Vercel crons for
  business logic.
- Money: if it's off a penny, it's a bug. Never round to "close enough".

## Sync design (Phase 1)
Zoho workflow webhook -> `POST functions/v1/zoho-sync?secret=...` — enqueues into
`sync_queue`, then drains inline: `getRecord` -> `mapDeal` -> upsert `deals` on
`zoho_id`. A `pg_cron` sweeper POSTs the same function every 5 minutes with
`?mode=drain` to catch anything the webhook missed or that failed mid-flight.
`functions/v1/zoho-backfill` enqueues every DocuRide id via paged COQL.

Write-back (`sync_outbound`) has no endpoint at present — `field_ownership` is
empty, so no field is web-owned. Adding a row there is what re-opens it.

## Commands
- `npm i` ; `npx tsc --noEmit` to type-check the Vercel side (`api/`)
- `deno check supabase/functions/**/*.ts` to type-check Edge Functions
- `supabase db push` for migrations in `supabase/migrations/`
- `supabase functions deploy <name>` (or the Supabase MCP) to ship an Edge Function
