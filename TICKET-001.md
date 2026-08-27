# TICKET-001 — Zoho -> Supabase mirror (Phase 1, step 1)

## Goal
Every DocuRide CRM record exists in `public.deals`, kept current by webhook, with a narrow write-back path.

## Files in this drop
- supabase/migrations/0001_tenancy_and_zoho_mirror.sql
- lib/zoho/client.ts, lib/zoho/dealmap.ts, lib/supabase/service.ts
- api/sync/zoho.ts (webhook), api/sync/process.ts (cron worker), api/sync/backfill.ts
- api/deals/[id].ts (GET + PATCH for web-owned fields)
- vercel.crons.json (merge into vercel.json)
- CLAUDE.md

## Steps
1. Apply migration. If not using psql, run the tenant insert first, copy the uuid, replace `:'id'`.
2. Add Vercel env: `ZOHO_WEBHOOK_SECRET` (random string). `CRON_SECRET` already exists.
3. Deploy. Hit `POST /api/sync/backfill` with Bearer CRON_SECRET. Watch `sync_queue` drain over a few minutes.
4. Zoho: Setup > Automation > Workflow Rules > DocuRide > on Create or Edit (any field) > Webhook:
   URL `https://www.docuride.com/api/sync/zoho?secret=<ZOHO_WEBHOOK_SECRET>`, POST, Form-Data, param `id` = DocuRide Id, param `module` = `DocuRide`.
5. Edit a record in Zoho. Confirm `deals.zoho_modified_time` advances within ~1 min.
6. Create a profile row for jim (tenant = allseasons, role = owner).
7. `PATCH /api/deals/<uuid>` with `{"Other_Stipulation":"test from web"}` and a user JWT. Confirm Zoho updates and the webhook echo lands without error.

## Acceptance
- `select count(*) from deals` == Zoho record count.
- R&R report can be rewritten to read `deals` (next ticket) with identical output for last month.
- No Supabase Edge Functions remain referenced by admin.html.

## Out of scope
Lienholders / Credit_Applications / Leads mirror (TICKET-002). UI (TICKET-003).
