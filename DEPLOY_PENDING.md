# Two Edge Functions need deploying from your machine

Everything is committed and pushed to `main`, typechecked and tested (378 passing).
Two of the five Edge Functions could not be pushed from here.

## Why

Every Edge Function deploy from this session goes through one MCP call that carries
the function's entrypoint **and every shared module it imports**, as text I type
out. There is no incremental deploy: a partial file list is refused with
`Module not found`. This container cannot reach `api.supabase.com` or
`*.supabase.co` directly (the egress proxy denies both), and there is no
`SUPABASE_ACCESS_TOKEN`, so the Supabase CLI is not an option either.

`fni-session-verify` needs 11 files and `fni-rate-vehicle` needs 9. Both exceed
what one call can carry. I tried twice; the second attempt was refused cleanly
with `Entrypoint path does not exist`, which means nothing was changed and the
previously deployed version stayed live.

I already cut both bundles down as far as the design honestly allows: the VIN
decode moved to its own function and the rate-request builder moved out of
`rate-properties.ts`, which took `fni-session-verify` from 166 KB to 122 KB and
halved the two cron functions. Still too big for one call.

## The two commands

```bash
git pull
supabase functions deploy fni-session-verify --project-ref fovccigwlcmmzfubpfny
supabase functions deploy fni-rate-vehicle   --project-ref fovccigwlcmmzfubpfny
```

Both already exist, so nothing needs creating and no secrets change. Neither uses
JWT verification; the CLI preserves that from the existing function.

## What is live right now

| | State |
| --- | --- |
| Vercel console and planner (`main`) | **Live** |
| `fni-session-start` v9 | **Live** |
| `fni-vin-decode` v1 (new) | **Live** |
| `fni-session-verify` | **Not deployed** (old version serving) |
| `fni-rate-vehicle` | **Not deployed** (old version serving) |

Both new functions were smoke-tested through `pg_net` and answer 401 to a wrong
secret, which proves the bundle parses and every shared module resolves.

`fni-health-check` and `fni-refresh-rate-properties` also carry a stale copy of
`rate-properties.ts`. Their behaviour is identical either way -- they use only
`parseRequiredProperties` and `writeRateProperties`, neither of which changed --
so they are not urgent. Deploy them whenever convenient:

```bash
supabase functions deploy fni-health-check            --project-ref fovccigwlcmmzfubpfny
supabase functions deploy fni-refresh-rate-properties --project-ref fovccigwlcmmzfubpfny
```

## Which of the four bugs that leaves working

**Fixed and live now** (both were in the Next app):

1. **Save changes.** The action reads only the known rating input names, so
   React's hidden `$ACTION_ID` field can no longer refuse a save.
4. **Refusal messages are out of the URL.** They travel in a 20-second
   `httpOnly` cookie and the URL stays `/verify/<session_id>`.

**Fixed in the repo, waiting on the two deploys:**

2. **Term and APR reading Missing.** Both the sheet and the TecAssured rate
   request now resolve through `_shared/finance-basis.ts`. Needs
   `fni-session-verify` (the screen) and `fni-rate-vehicle` (the rate).
3. **The cash-deal help text on a financed deal.** In `_shared/verification.ts`,
   so it needs `fni-session-verify`.

Until those two are deployed, deal 13759's Verify screen will still show Term and
APR as Missing and still explain cash deals underneath them, and Confirm and
Continue will stay disabled. Nothing is broken by the mismatch: the new console
sends nothing the old endpoint refuses.

## The one thing to do differently next time

If you want me to be able to ship Edge Function changes end to end, the cheapest
fix is a GitHub Action that runs `supabase functions deploy` on a push to `main`,
with `SUPABASE_ACCESS_TOKEN` as a repository secret. Then a push is a deploy and
none of this hand-assembly happens at all. Say the word and I will write it.
