# DocuRide — Architectural Path to a Web-Based Platform

*Working draft, August 2026*

---

## 1. Where things stand (from the repo + current build)

The `docuride` repo is honest about itself: it's a marketing site with two serverless functions bolted on. But it already contains the seeds of the real platform, and one piece of drift worth cleaning up first.

**What's there**

| Piece | State |
|---|---|
| `index.html`, `styles.css`, legal pages | Static marketing site. Fine as-is. |
| `admin.html` | Supabase Auth login + R&R console. First real "app" screen. |
| `api/reports/reyrey.ts` | Full R&R pipeline: Zoho COQL → CSV → FTPS → log to `rr_report_runs`. |
| `api/users.ts` | Admin invite/list via Supabase Auth admin API. |
| `ftps-upload.ts` | FTPS relay — designed to be called *by* a Supabase Edge Function. |
| `supabase.rr_report_runs` | First canonical table. |

**The drift to resolve before anything else**

`admin.html` calls `${SUPABASE_URL}/functions/v1/rr-report` and `/admin-users` (Supabase Edge Functions), while the repo ships `api/reports/reyrey.ts` and `api/users.ts` (Vercel functions) that do the same jobs. Plus `ftps-upload.ts` exists because Deno couldn't do explicit FTPS — so the edge-function path needs Vercel anyway.

Two implementations of the same feature = two places for bugs. Pick one:

> **Recommendation: Vercel functions are the API layer. Supabase Edge Functions are not used.**
> Node runtime (FTPS works), same repo as the UI, same deploy. Delete the edge functions, point `admin.html` at `/api/...`, delete `ftps-upload.ts` and the root-level `reyrey.ts`/`users.ts` duplicates (GitHub-upload flattening artifacts).

This costs an afternoon and removes the fork in the road.

---

## 2. Target architecture

```
┌──────────────────────────────────────────────────────────────┐
│  UI  (Vercel — Next.js or plain TS SPA)                       │
│  Deal desk · Doc center · Admin · Dealer onboarding           │
└──────────────┬───────────────────────────────────────────────┘
               │ Supabase Auth JWT
┌──────────────▼───────────────────────────────────────────────┐
│  API  (Vercel serverless, /api/*)                             │
│  Deal logic · TILA · Lienholder/ELT · R&R · F&I dispatch      │
└───┬──────────────┬──────────────┬──────────────┬─────────────┘
    │              │              │              │
┌───▼────┐   ┌─────▼─────┐  ┌────▼─────┐  ┌─────▼──────┐
│Supabase│   │ DMS Adapter│  │ Renderer │  │ eSign      │
│Postgres│   │ DX1 today  │  │ Zoho     │  │ Zoho Sign  │
│(canon) │   │ CDK/Ideal  │  │ Writer   │  │ (swappable)│
└────────┘   └────────────┘  └──────────┘  └────────────┘
```

**Roles, stated plainly**

- **Supabase Postgres** — system of record for tenants, stores, users, deals, documents, lienholders, fees, report runs. Row-Level Security keyed on `tenant_id`.
- **Vercel API** — all business logic lives here in TypeScript. Nothing that matters lives in Deluge long-term.
- **DMS adapter** — one interface (`getDeal`, `getParts`, `getFI`, `getTax`), one implementation per DMS. DX1 first.
- **Renderer** — Zoho Writer merge via direct API with arbitrary JSON. No CRM record required.
- **eSign** — Zoho Sign on API credits. Interface-wrapped so DocuSign/Dropbox Sign can replace it later.
- **Zoho CRM** — a *client* of DocuRide during transition, then optional, then gone (for external tenants it never exists).

---

## 3. Core data model (v1)

Keep it small. Every table carries `tenant_id`.

```
tenants          id, name, plan, created_at
stores           id, tenant_id, name, dms_type, dms_config (jsonb, encrypted), address, dealer_license, ...
users            (Supabase auth.users) + profiles: user_id, tenant_id, store_ids[], role
deals            id, tenant_id, store_id, dms_deal_ref (MUI #), stock_no, status, sale_date,
                 buyer (jsonb), cobuyer (jsonb), unit (jsonb), trades (jsonb[]), 
                 financials (jsonb), tila (jsonb), fi_selections (jsonb), raw_dms_snapshot (jsonb)
lienholders      id, tenant_id, name, match_key, elt_code, tila_config (jsonb), addresses (jsonb)
fee_defaults     id, tenant_id, store_id, key, amount, taxable, description
documents        id, deal_id, kind (DR/LN/MG/RR/...), seq, template_ref, storage_path,
                 status (generated/sent/signed/filed), signed_at, esign_ref
fi_vendors       id, tenant_id, prefix, name, dispatch_config (jsonb)
fi_contract_seq  tenant_id, store_id, vendor_id, next_number      -- allocate early, as you noted
rr_report_runs   (exists)
rr_document_log  deal_id, form_id, price_at_write, executed_at     -- per-document billing, price frozen
audit_log        who, what, when, before/after (jsonb)
```

**Why jsonb for buyer/unit/financials:** you hit the numeric-field ceiling in Zoho because every attribute needed a column. Postgres doesn't care. Promote fields to real columns only when you need to index or constrain them.

**Why `raw_dms_snapshot`:** every DX1 refresh gets stored verbatim. "Off a penny" debugging becomes a diff, not a mystery.

---

## 4. The strangler-fig path

Each phase ships something usable and can stop without leaving a mess. All Seasons is tenant #1 throughout.

### Phase 0 — Consolidate (1–2 weeks)
- Resolve the Vercel/Edge split (§1).
- Introduce a real frontend scaffold (Next.js on Vercel, or keep vanilla TS — either is fine; Next.js buys you routing/auth helpers for free).
- Create `tenants`, `stores`, `profiles` tables. Seed All Seasons + 4 stores + Bell + Country Roads.
- Move DX1 API keys from Zoho org variables into `stores.dms_config` (encrypted via Supabase Vault).
- **Exit criteria:** admin console works against `/api/*` only; users have tenant/store scope.

### Phase 1 — Mirror (3–4 weeks)
Zoho stays master. Supabase becomes a read replica.
- Zoho workflow → webhook on DocuRide DC create/update → `/api/sync/zoho` upserts into `deals`.
- Port the R&R query to read from Supabase instead of COQL. Compare output against the Zoho-sourced run for two months. When they match, cut over.
- Build the **read-only deal list + deal detail** screen in the web UI. Nobody uses it yet; it's a window.
- **Exit criteria:** Supabase has every deal Zoho has; R&R runs off Supabase.

### Phase 2 — Port the logic (4–6 weeks)

Per ARCHITECTURE.md, the Deluge functions become **Supabase Edge Functions and
Deno modules under `supabase/functions/_shared/`** — not Vercel functions. Do
them in dependency order, mirroring `DX1_Full_Data_Sync`:

1. `_shared/dms/dx1.ts` — `Get_DX1_MUI_Info` + Parts/Labor + F&I + Tax mapping. Add the MISC line-item workaround here. Per-store DX1 credentials come from `stores.dms_config`, decrypted inside the function; they never reach the browser.
2. `_shared/lienholders/match.ts` — first-two-words `starts_with` matcher.
3. `_shared/tila/calc.ts` — Appendix J APR, US Rule amortization, all three day-count bases. **Port the four validated lenders as unit tests first** (`deno test`), then write the code to pass them. This is the one place a bug costs real money.
4. `_shared/credit/link.ts`, `_shared/leads/link.ts`.

Pure calculation belongs in `_shared/`, not in a function entrypoint: it is the
part that must be unit-testable without HTTP, and the part a nightly diff job
calls directly.

Run both in parallel: Deluge writes to Zoho, the Deno port writes to Supabase,
and a `pg_cron` job invokes a `deal-diff` Edge Function nightly to compare
them. Any penny off is a ticket.

- **Exit criteria:** 30 days of parallel run with zero unexplained diffs, and TILA passing the four lender fixtures under `deno test`.

### Phase 3 — Flip the source of truth (2–3 weeks)

- "Refresh from DMS" in the web UI calls Edge Function `deal-refresh`, which runs the Phase 2 pipeline, writes Supabase, then pushes to Zoho (reverse of Phase 1). Deluge functions retired. The UI holds a Supabase user JWT; the function resolves tenant and store from `profiles`, so the browser never carries a service-role key.
- Document generation is Edge Function `documents-generate` → Zoho Writer merge API with a JSON payload → PDF into Supabase Storage → `documents` row. No Vercel involvement: this is HTTPS and object storage, both of which Deno does natively.
- Zoho Sign is called from Edge Function `documents-send`. The completion webhook lands on Edge Function `esign-callback` with `verify_jwt = false` and a shared-secret query parameter, matching the `zoho-sync` pattern — an external service cannot present a Supabase JWT. It updates `documents.status`, and the self-routing filename scheme becomes a column instead of a naming convention.
- The finalize action writes `rr_document_log`, inside the same Edge Function that performs the finalize, so the billing record and the state change share a transaction boundary.
- R&R submission stays split exactly once: Edge Function `rr-report` assembles and logs the CSV, then hands the bytes to the Vercel FTPS relay, which transmits and returns the FTP response. The relay holds FTPS credentials and no business logic (ARCHITECTURE.md, "The one standing exception").
- **Exit criteria:** a deal can go DMS → docs → signed → filed → reported without a human opening Zoho CRM, and the only Vercel function invoked anywhere in that path is the FTPS relay.

### Phase 4 — Zoho becomes optional (ongoing)

- Zoho push from Phase 3 becomes a toggle per tenant (`tenants.crm_sync = 'zoho' | 'none' | 'hubspot'...`), read by the Edge Functions rather than branched in the UI.
- Second tenant onboarded with `crm_sync = 'none'`. This is the real test of "CRM-agnostic," and also of the tenant resolution in `zoho-sync`, which currently asserts exactly one tenant with `crm_sync = 'zoho'` and must become an explicit mapping before a second Zoho tenant exists.
- Credit app intake: `credit_applications` table under tighter RLS than `deals`, plus a hosted form posting to an Edge Function (paid add-on, as scoped). GLBA retention policy applies here, not to `deals`.
- F&I menu: slot-based `fi_selections`, a per-vendor dispatch Edge Function, and the sequence allocator in Postgres so numbers are allocated transactionally rather than by read-then-write.

---

## 5. What stays in Zoho, what leaves, when

| Component | Now | After Phase 3 | Eventually |
|---|---|---|---|
| Deal record | Zoho CRM master | Supabase master, Zoho mirror | Supabase only (Zoho optional per tenant) |
| Deluge functions | All logic | Retired | — |
| Zoho Flow | Doc dispatch | Retired (API does it) | — |
| Writer templates | Rendering | Rendering (direct API) | Rendering, or swap for Docmosis/PDF lib |
| Zoho Sign | eSign | eSign (API credits) | Behind an interface; swappable |
| WorkDrive | File store | Transition | Supabase Storage / S3 |
| Zoho Forms (credit app) | Intake | Intake via webhook | DocuRide hosted form |

---

## 6. Multi-tenancy and security (do this in Phase 0, not later)

- RLS on every table: `tenant_id = (select tenant_id from profiles where user_id = auth.uid())`.
- Service-role key used only in Vercel functions, never in the browser (`admin.html` currently does this correctly — keep it that way).
- Per-store DMS credentials in Vault, decrypted only inside the API.
- GLBA: credit app data in its own table with tighter RLS and a retention policy. The README already notes the privacy page needs a lawyer — the same lawyer should look at data retention.
- `audit_log` on deals and documents from day one. Dealers will ask "who changed the trade payoff" and you want the answer to be a query.

---

## 7. Decisions to make now

1. **Vercel functions vs. Supabase Edge Functions** — recommend Vercel (§1). Decide and delete the loser.
2. **Frontend stack** — Next.js gives auth middleware, routing, and server components for free; vanilla TS keeps the "no build step" purity but you'll rebuild half of Next.js by hand. Recommend Next.js.
3. **Storage** — Supabase Storage from Phase 3, or keep WorkDrive through Phase 4? Storage is simpler for external tenants; WorkDrive keeps your current folder routing. Recommend Storage, migrate All Seasons' history lazily.
4. **Auto-archive** — becomes a Postgres cron (`pg_cron`) on `deals.status = 'filed' and filed_at < now() - interval '90 days'`. Resolves the workflow-rule-vs-function question by making it neither.

---

## 8. Risks

- **TILA port** — the highest-stakes code. Mitigation: lender test cases as fixtures before a line of implementation.
- **Parallel-run fatigue** — diffs that are "explained" but never fixed accumulate. Mitigation: a diff is either fixed or documented with a reason in the ticket; no third state.
- **Zoho API rate limits during Phase 1 backfill** — batch the initial sync via Bulk Read, not per-record fetches.
- **Scope creep from tenant #2** — every new dealer will want something. Mitigation: `tenants.config` jsonb for tweaks; schema changes only for things two or more tenants need.

---

## 9. First three tickets

1. Delete Supabase Edge Functions; point `admin.html` at `/api/reports/reyrey` and `/api/users`; remove duplicate root-level `.ts` files.
2. Create `tenants`, `stores`, `profiles` with RLS; seed All Seasons; add `tenant_id` to `rr_report_runs`.
3. Write `tila/calc.test.ts` with the four validated lenders (One Community, Peoples, Star USA, Williamstown) as fixtures. Don't write `calc.ts` yet.
