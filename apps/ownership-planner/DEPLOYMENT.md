# Ownership Planner — deployment

## Vercel project

**Not created.** The Vercel token available to this session can read
`Jim Stout's projects` and list its projects, but `POST /projects` comes back
`403 forbidden: You don't have permission to create the project`. The settings
below are what the project needs; everything else is ready to point at it.

Create a **second** project against `jimrstout/docuride`. Do not deploy the
planner through the existing `docuride` project — that would put a buyer-facing
application carrying PII onto the same deployment as the main site, with shared
environment variables and a shared rollback surface.

| Setting | Value |
| --- | --- |
| Team | `team_9dw1TAb1QeCxKd2TA2mlgudX` (Jim Stout's projects) |
| Repository | `jimrstout/docuride` |
| Root directory | `apps/ownership-planner` |
| Framework preset | Next.js |
| Node version | 22.x |
| Domain | `ps.docuride.com` |
| Base path | none — the app is at the root of its own hostname, so `next.config.mjs` sets `BASE_PATH` to `""` |
| Affected-projects deployments | **On** — so a push touching only the main site does not rebuild the planner, and vice versa |
| SSO / Vercel Authentication | **Off** (decided 2026-09-19) |

### Why SSO is off

The production security model is the session UUID plus its 24-hour expiry,
whether or not SSO is on. Inheriting the `docuride` project's
`all_except_custom_domains` setting would mainly mean a buyer or an F&I manager
without a Vercel account cannot open a preview URL — so every round of testing
would have to happen on the live domain, which is a bad way to test something
that writes to live sessions.

### Environment variables

```
SUPABASE_URL          https://fovccigwlcmmzfubpfny.supabase.co
FNI_WEBHOOK_SECRET    the Supabase Edge Function secret — server-side only
FNI_FUNCTIONS_BASE    functions/v1
NEXT_PUBLIC_SITE_URL  https://<planner domain>
```

Nothing here takes a `NEXT_PUBLIC_` prefix except the site URL. If a variable
holding a secret ever needs to be read in the browser, the design is wrong.

`DX1_API_KEY` is deliberately absent — see SPEC_CORRECTIONS.md §9a. DX1
credentials belong per-store in `stores.dms_config`, not in a project-wide
variable.

### Served at ps.docuride.com

The planner has its own hostname, so it sits at the root of that origin and
carries no path prefix. `next.config.mjs` sets `BASE_PATH` to `""` and omits
`basePath` entirely; a plan is at `https://ps.docuride.com/plan/<session_id>`.

It was previously reached at `docuride.com/ps/...` through a rewrite from the
main site, which is why `basePath` existed: without it every asset request
resolved against the root site and 404d. On its own hostname there is nothing
to resolve against and nothing to rewrite, so both the rewrite and the prefix
are gone.

**Moving it back under a path is one edit, in `next.config.mjs`.** Set
`BASE_PATH` to the prefix and both halves follow: Next prefixes what it routes
itself, and `lib/paths.ts` — which reads the same value through
`NEXT_PUBLIC_BASE_PATH` — prefixes the rest. Do not set
`NEXT_PUBLIC_BASE_PATH` in the hosting environment instead; that moves only the
client half. A rewrite would then also have to cover the whole subtree, not just
the pages, or `_next/*` points at the root site and the page loads unstyled.

**Client fetches are prefixed in code, not by Next.** That is why the seam
survives the move even though it currently prefixes nothing. Next prefixes what
it routes — pages, `next/link`, the router, and the sources in `headers()`. A
plain `fetch("/api/...")` from a client component is a raw browser request Next
never sees, so it is not prefixed. `lib/paths.ts` does it explicitly and the
three client calls in `Planner.tsx` go through it. The failure mode if that is
ever bypassed is quiet: the autosave 404s and nothing the customer decided is
recorded.

### After the project exists

Point `fni-session-start` at it, so the button on the DocuRide record opens the
right URL. It builds `${FNI_MENU_BASE_URL}/${session_id}` and currently defaults
to `https://docuride.app/fni`:

```
FNI_MENU_BASE_URL = https://ps.docuride.com/plan
```

That is a Supabase Edge Function secret, not a Vercel variable. No code change
and no change to the Zoho button, which only opens whatever URL the function
returns.

## Edge Functions

Four are deployed from this repository: `fni-session-get`, `fni-session-save`,
`fni-acknowledgment` and `fni-contract-documents`. All were deployed by pasting
sources through the Supabase MCP, because the Supabase CLI is not available in
the environment this work was done in.

`fni-rate-vehicle`, `fni-contract-submit`, `fni-session-start`,
`fni-health-check` and `fni-refresh-vehicle-types` are deployed but are **not
in the repository**, so they cannot be reviewed, tested or redeployed from a
clean checkout. Worth closing before go-live.

Run this once from a machine with the CLI, so every deployed bundle is
byte-identical to the repository:

```sh
supabase functions deploy fni-session-get
supabase functions deploy fni-session-save
supabase functions deploy fni-acknowledgment
supabase functions deploy fni-contract-documents
```

## The one unverified path

Every function was confirmed to boot and to reject a bad secret with 401, which
also proves each import graph resolves — including `pdf-lib` from esm.sh under
the Deno edge runtime. No **authenticated** call was made, because
`FNI_WEBHOOK_SECRET` is an Edge Function secret that is not readable from this
environment, and outbound HTTPS to `supabase.co` is blocked by its network
policy besides.

One command closes that gap:

```sh
curl -sS "https://fovccigwlcmmzfubpfny.supabase.co/functions/v1/fni-session-get?session_id=44e41c35-c501-4ee8-84ed-8858b6b9101f" \
  -H "x-webhook-secret: $FNI_WEBHOOK_SECRET" | jq
```

Expected on the seeded demo session: four presentable products (VSC $2,225,
TW $890, GAP $695, KEY $275), `catalog` with five entries, and
`financials.term_months` of 60 with `rate_label` "Annual percentage rate".

`financials.payment_basis` should read `tila` with `has_payment: true` — the
session has a lienholder and TILA was calculated. A deal with no Lienholder Name
resolves to `cash`, where `has_payment` is false and every monthly figure is
suppressed in favour of totals.

`catalog_coverage` should read `matched: 5`, `unmatched: []`, and one entry in
`copy_pending` for PPM — the product registered in the catalog with its copy
unwritten. A non-empty `unmatched` means a rated product found no catalog row
at all, which is a join failure rather than a decision; the function also logs
it at error level as `CATALOG JOIN FAILED`.

To check the acknowledgment without writing to Zoho:

```sh
curl -sS -X POST "https://fovccigwlcmmzfubpfny.supabase.co/functions/v1/fni-acknowledgment" \
  -H "x-webhook-secret: $FNI_WEBHOOK_SECRET" -H "Content-Type: application/json" \
  -d '{"session_id":"44e41c35-c501-4ee8-84ed-8858b6b9101f","deliver":false}' \
  | jq '{filename, signature_map_line, presented_count, included_count, totals}'
```

Drop `"deliver":false` and it uploads to `External_Form_Upload_2` and appends to
`FNI_Signature_Map` on the real DocuRide record. That was left unfired here
deliberately — it writes to a live deal.

## Demo data

`supabase/seed/planner_demo_seed.sql` is applied to the live project: three
pricing bands and five catalog entries for the All Seasons store, plus a mock
`rated_offers` row on session `44e41c35` so the planner renders end to end
without TecAssured credentials.

Four of those five carry finished copy. PPM is registered with its copy
unwritten on purpose, so the seed exercises both withhold paths: a product held
back by decision, and — if you delete that row — one held back by a failed
join.

**The catalog copy in it is a draft and has not been reviewed.** Writing that
copy is a content task and it needs checking against TecAssured's approved
language before anything goes live. The pricing bands are placeholders with the
right shape and invented numbers.
