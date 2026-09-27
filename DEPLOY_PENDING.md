# Deploying Edge Functions

A push to `main` now deploys the Edge Functions that push changed. One thing is
needed from you first, and there is a warning below about the manual CLI command
I gave you earlier.

---

## 1. Add one secret, once

Generate a personal access token at
<https://supabase.com/dashboard/account/tokens>, then add it to this repository
under **Settings, Secrets and variables, Actions** as:

```
SUPABASE_ACCESS_TOKEN
```

Nothing else. The project ref is in the workflow and every function secret already
lives in Supabase.

Until that secret exists the workflow fails on its first step with a message
saying so. That is deliberate: a deploy that quietly does nothing is the exact
problem this replaces.

## 2. Then catch everything up in one go

Actions, **Deploy Edge Functions**, **Run workflow**, and type `all` in the box.
That deploys all 18 functions this repo owns and leaves the repository and the
live project in agreement, including the two that are still behind
(`fni-session-verify` and `fni-rate-vehicle`).

After that, pushing to `main` is enough.

---

## The warning about the CLI command

**Do not run `supabase functions deploy` against a checkout older than commit
`39d4dbe`.** The two commands in the previous version of this file would have
broken the live system, and I am glad you had not run them yet.

`supabase functions deploy` reads `verify_jwt` from `supabase/config.toml`, and
**its default is true**. That file named 6 of the 19 functions. A function missing
from it is not left alone by a CLI deploy: it is switched to requiring a Supabase
JWT. Every function here authenticates with `FNI_WEBHOOK_SECRET`, checked inside
the handler, so the switch turns every call into a 401 before the handler runs.

Deploying `fni-session-verify` and `fni-rate-vehicle` with the old config would
have taken the Verify screen and all rating off the air. Deploying more of them
would have taken down the planner, the CRM button, the console and both cron jobs.

Nothing had broken yet only because every deploy so far went through the
Management API, which leaves the existing setting alone.

`config.toml` now names all 19 with the values read off the live project on
2026-09-27: `false` for every `fni-*` and both `zoho-*`, and `true` for
`rr-report`, which is what it has always required.
`test/edge-function-config.test.mjs` fails the build if a function is ever added
without a `verify_jwt` line, so this cannot come back.

---

## How the workflow decides what to deploy

`scripts/changed-edge-functions.mjs` walks each function's import graph and
deploys a function when the push touched its own directory or anything in its
transitive closure. That matters because of `_shared`: each function carries its
own bundled copy, so editing `_shared/verification.ts` changes two deployed
functions and editing `_shared/money.ts` changes five. Deploying only the
directory somebody edited would leave the rest running yesterday's shared code.

A change to `config.toml` deploys everything, because it carries `verify_jwt`.
A change outside `supabase/functions/` deploys nothing.

**`rr-report` and `admin-users` are never deployed from here**, by name, not by
convention. They serve the live Reynolds and Reynolds system and `admin-users` has
no source in this repository at all. Asking for one by name in a manual run is
refused with an error rather than skipped quietly.

The workflow runs `npx tsc --noEmit` and the full test suite before it deploys
anything, runs one deploy at a time, and afterwards checks each function answers
401 to a deliberately wrong secret. That last check is real rather than a
formality: the handler only reaches its auth check once the bundle has parsed and
every shared module has resolved, so a 401 proves the deploy is sound in the one
way a deploy can silently fail.

## What it deliberately does not do

**Migrations.** `supabase db push` on every merge is a much larger promise, and a
migration can be irreversible. Keep running those by hand.

---

## Current state

| | State |
| --- | --- |
| Vercel console and planner | **Live** |
| `fni-session-start` v9 | **Live** |
| `fni-vin-decode` v1 | **Live** |
| `fni-session-verify` | Behind by one version |
| `fni-rate-vehicle` | Behind by one version |
| `fni-health-check`, `fni-refresh-rate-properties` | Stale shared copy, behaviour identical |

Of the four bugs from deal 13759, the two that live in the Next app are already
fixed and live: **Save changes works**, and **refusal messages are out of the
URL**. The two that live in Edge Functions are fixed in the repo and waiting on
step 2 above: **Term and APR reading Missing**, and **the cash-deal help text on a
financed deal**.

Until then, 13759's Verify screen still shows Term and APR as Missing and Confirm
and Continue stays disabled. Nothing is broken by the mismatch: the new console
sends nothing the old endpoint refuses.
