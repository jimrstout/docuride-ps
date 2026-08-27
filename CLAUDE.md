# DocuRide — Claude Code project guide

DocuRide is a contract-generation / deal-management platform for powersports & RV dealers.
Migrating from Zoho CRM (Deluge) to Supabase + Vercel per docs/MIGRATION_PATH.md.

## Stack
- Vercel: static HTML (marketing + admin) and serverless TS functions under `api/`. Node runtime.
- Supabase project `fovccigwlcmmzfubpfny`: Postgres (canonical data), Auth. **No Edge Functions** — Vercel is the API layer.
- Zoho CRM v8 API: module `DocuRide` (289 fields), `Lienholders`, `Credit_Applications`, `Leads`. Mirrored into `public.deals`.
- Secrets: Vercel env vars only. `.env` is gitignored. Use `vercel env pull`.

## Rules
- One change type per commit. Never bundle unrelated edits.
- Post full files, not diffs, when showing code to Jim.
- Zoho field API names are case-sensitive. Verify before use (`Days_to_First_Payment`, `IDAHO`, etc.).
- COQL: max two conditions per parenthesis level — nest pairwise.
- User-facing text says "your DMS", never "DX1".
- Field ownership: each Zoho field has exactly one writer (`field_ownership` table). Default owner is Zoho. Web writes only `owner='web'` fields, via `/api/deals/:id`.
- Service-role key is server-side only. Browser gets anon key + user JWT.
- Money: if it's off a penny, it's a bug. Never round to "close enough".

## Sync design (Phase 1)
Zoho workflow webhook -> `POST /api/sync/zoho` (enqueue only) -> cron `/api/sync/process` drains `sync_queue` -> `getRecord` -> `mapDeal` -> upsert `deals` on `zoho_id`.
Web edits -> `PATCH /api/deals/:id` -> Supabase first, then Zoho `updateRecord`, logged in `sync_outbound`.

## Commands
- `npm i` ; `npx tsc --noEmit` to type-check
- `vercel dev` for local functions
- `supabase db push` for migrations in `supabase/migrations/`
