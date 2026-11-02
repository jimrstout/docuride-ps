# Secrets in web addresses: inventory

Taken 2026-11-02. No secret value appears in this document, and none was
printed, logged or copied to write it. The sources were:

- the code in `supabase/functions/`;
- the list of functions deployed to Supabase project `fovccigwlcmmzfubpfny`;
- the `pg_cron` job definitions, checked only for whether each sends its
  secret in the address or in a header;
- Supabase's function request logs from 2026-10-25 to 2026-11-02, counted by
  function name and by whether the address contained `secret=`, never read
  line by line. The deploy workflow's own smoke test, which sends a
  deliberately wrong secret, is left out of the counts.

## The short version

**One real caller sends a secret in the web address: the Zoho CRM workflow
webhook that calls `zoho-sync`.** It does so every time a DocuRide record is
saved: 15 to 213 calls a day in the logs, carrying `ZOHO_WEBHOOK_SECRET` in
the address. Supabase's request logs record the full address, so that secret
is sitting in the logs today.

Everything else sends its secret in a header, or sends none:

- **The CRM launch button sends no secret in the address.** Its calls to
  `fni-session-start` arrive without one (one each on 2026-10-26 and
  2026-11-02), so the button's Deluge sends it another way: a header or the
  body.
- **The tab the button opens has no secret in its address.** It opens
  `https://ps.docuride.com/details/<session id>`, the `menu_url` that
  `fni-session-start` returns. So no secret is in browser history or on
  screen from the button.
- PS itself (the Next server on Vercel) sends `FNI_WEBHOOK_SECRET` in the
  `x-webhook-secret` header, never the address (`lib/edge.ts`).
- The cron jobs send theirs in a header: the `zoho-sync` sweeper and
  `dc-dealer-sync`. The R&R jobs send an Authorization header.

**Seventeen PS functions still *accept* the secret in the address, though
nothing uses that today.** Accepting it is the open door: any future caller,
or a copied example, could start doing it.

## Every function that accepts a secret in the address

| Function | Secret | Who calls it, and how it sends the secret today | Repo that owns it |
|---|---|---|---|
| **zoho-sync** | ZOHO_WEBHOOK_SECRET | **Zoho CRM workflow webhook: in the address** (every DocuRide record save). pg_cron sweeper every 5 minutes: header. | Code and deploys: docuride-ps. **Shared:** it fills `public.deals`, which the R&R report reads. |
| fni-session-start | FNI_WEBHOOK_SECRET | CRM launch button (Deluge): not in the address. | docuride-ps |
| fni-documents-generated | FNI_WEBHOOK_SECRET | CRM, each time documents are generated: not in the address. | docuride-ps |
| fni-dx1-check | FNI_WEBHOOK_SECRET | CRM Generate gate, and Details through PS: not in the address. | docuride-ps |
| fni-documents-to-deal-jacket | FNI_WEBHOOK_SECRET | CRM after DocuRide DC makes the deal's folders, and Details through PS. No real calls in the logs this week. | docuride-ps |
| fni-session-get | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |
| fni-session-save | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |
| fni-session-verify | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |
| fni-rate-vehicle | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |
| fni-vin-decode | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |
| fni-acknowledgment | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |
| fni-contract-submit | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |
| fni-contract-void | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |
| fni-contract-documents | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |
| fni-menu-prepare | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |
| fni-admin-auth | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |
| fni-admin-sessions | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |
| fni-admin-settings | FNI_WEBHOOK_SECRET | PS itself: header. | docuride-ps |

## Header only already

These take their secret from a header and never from the address:

- `fni-oem-contracts`, `fni-price-sheets` and `fni-price-sheet-parse`
  (FNI_WEBHOOK_SECRET, called by PS).
- `zoho-backfill` (its own BACKFILL_SECRET, run by hand).

## Not in this repository, not changed

- `rr-report` and `rr-reconcile` belong to the live Reynolds and Reynolds
  system. They verify a Supabase JWT, and their cron jobs send an
  Authorization header. No secret is in the address.
- `admin-users` has no source here.
- The `dc-*` functions belong to docuride-dc. None was called with a secret
  in the address this week. `dc-dealer-sync`'s cron job sends a header.

## Related things noticed

- `fni-health-check`, `fni-refresh-rate-properties` and the retired
  `fni-refresh-vehicle-types` check no secret at all. Nothing is in an
  address because nothing is asked for.
- Several documents and code comments show the address form with a
  placeholder, for example `?secret=YOUR_FNI_WEBHOOK_SECRET` in
  LAUNCH_FLOW.md. They hold no real value, but they teach the habit; they
  should change when the address form is turned off.
- `ZOHO_WEBHOOK_SECRET` has been in the request logs for every webhook call.
  It needs replacing once the webhook stops sending it in the address (Step C
  of the plan).

## Why the work stopped here

The instructions were to stop after the inventory if an affected function
is owned outside docuride-ps, naming zoho-sync as the example because R&R
also depends on it. zoho-sync is the only function with real address-form
traffic. Its code lives here and deploys from here, but what it writes is
read by R&R, so changing how it authenticates is Jim's call.

The seventeen `fni-*` functions are owned here and have no real
address-form callers, so they could stop accepting the address form with no
CRM change at all, once Jim approves.
