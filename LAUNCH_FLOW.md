# The CRM button now opens Verify

Everything below is live as of 2026-09-27. Edge Function `fni-session-start` is at
version 8, and the Vercel production deployment is commit `326c6dc`.

---

## 1. Where the URL comes from (item 5)

**It is built in `fni-session-start`, and I have changed it. Nothing in Zoho needs
touching.**

The Zoho button opens whatever URL that function returns in `menu_url`. No Deluge
function builds a URL of its own, which is why there was exactly one place to
change. You do not need to edit a button, a workflow, or a custom function.

What changed, in `supabase/functions/fni-session-start/index.ts`:

| Field in the response | Before | Now |
| --- | --- | --- |
| `menu_url` | `https://ps.docuride.com/plan/<id>` | `https://ps.docuride.com/verify/<id>` |
| `verify_url` | did not exist | `https://ps.docuride.com/verify/<id>` |
| `plan_url` | did not exist | `https://ps.docuride.com/plan/<id>` |
| `menu_base_url` | did not exist | echoes the secret it resolved |
| `verify_base_url` | did not exist | echoes the verify base it derived |

`menu_url` keeps its name so the button keeps working untouched. `verify_url` is
the same value under an honest name. `plan_url` is the customer's link, returned
so staff can copy it without building it by hand.

### How the verify base is worked out

`FNI_MENU_BASE_URL` is `https://ps.docuride.com/plan`. The function swaps a
trailing `/plan` for `/verify`. That means **no secret needs editing**. If the two
routes ever stop being siblings, set `FNI_VERIFY_BASE_URL` and it wins outright.

All four response paths carry the new links: brand-new session, normal reopen,
reopen where the refresh failed, and reopen where contracts already exist.

---

## 2. Deal 13759 (item 6)

### The URL

```
https://ps.docuride.com/verify/a2a9bb77-afa2-4c44-b917-38dcd1a5e74e
```

Session `a2a9bb77-afa2-4c44-b917-38dcd1a5e74e`, Zoho id `4742556000231058020`,
store All Seasons Powersports, Parkersburg, Dealer ID 3-306. Not expired
(lapses 2026-09-28 00:36 UTC).

**One honest caveat.** I could not press the button myself. `FNI_WEBHOOK_SECRET`
is not available to me, and this container cannot reach `docuride.com` at all. So
the URL above is derived from the documented secret value rather than read off a
live response. To confirm it from your machine:

```bash
curl -s -X POST \
  "https://fovccigwlcmmzfubpfny.supabase.co/functions/v1/fni-session-start?secret=YOUR_FNI_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"zoho_deal_id":"4742556000231058020","initiated_by":"Jim Stout"}' | jq
```

That is exactly what the Zoho button does. The response now echoes
`verify_base_url` and `menu_base_url`, so it will tell you in its own words which
base it resolved instead of leaving the answer locked inside a secret.

### What that screen shows

This is not a guess. I ran the real sheet builder against the row as the database
holds it right now, with the live `requiredproperties` list cached for UTV on
Dealer ID 3-306 (17 properties).

Header: **Deal #13759 — Needs Verification**, with a "Checked by" box.

| | Field | Value | Source |
| --- | --- | --- | --- |
| Deal | Deal # | 13759 | CRM (read-only) |
| | Stock # | *nothing* | Missing (read-only) |
| | Deal type | Finance | CRM |
| | Sale date | 2026-09-26 | CRM |
| Vehicle | VIN | 3JBACAX43TE001930 | CRM |
| | Year | 2026 | CRM |
| | Make | Can-Am | CRM |
| | Model | Commander MAX XT 1000R | CRM |
| | New or Used | New | CRM |
| | Vehicle type | UTV | CRM |
| | **Engine size (cc)** | **nothing** | **Missing** |
| | Odometer | 1 | CRM |
| | In-service date | 2026-09-26 | CRM |
| | **Factory warranty remaining** | **nothing** | **Missing** |
| | **Fuel type** | **nothing** | **Missing** |
| Money | Sale price | $24,999.00 | CRM |
| | Amount financed | $27,547.64 | CRM |
| | **Term (months)** | **nothing** | **Missing** |
| | **APR** | **nothing** | **Missing** |
| Customer | City | Big Springs | CRM |
| | State | WV | CRM |
| | ZIP | 26137 | CRM |

Every row except Deal # and Stock # is a text box you can type in.

**Five fields block Confirm and Continue**: Engine size, Factory warranty
remaining, Fuel type, Term, APR. No CRM-difference warning, because nothing has
been edited yet. No duplicate-VIN warning: no other open session carries this VIN.

Two of those five are real gaps in the Zoho deal rather than gaps in DocuRide.
**Term and APR are empty on deal 13759** — `TILA_Pmt1_Count` and `TILA_APR` were
never filled, on a deal marked Finance with $27,547.64 financed. Until this week
that was a dead end. Now somebody can type them here, and the warning will tell
you they no longer match CRM until you go and fix the deal.

Note also that the amount financed ($27,547.64) exceeds the sale price
($24,999.00) by $2,548.64. That is ordinary for tax, title and a trade payoff,
but it is worth a glance before you confirm.

---

## 3. Screen by screen

### Step 1 — the button in Zoho

Salesperson or F&I manager presses the menu button on the DocuRide deal. No
change to the button.

`fni-session-start` finds the deal's existing session or makes one, refreshes the
rating inputs from Zoho, and returns the Verify link. If a rating input moved
since somebody verified, the session drops back to Needs Verification and the old
rates are marked out of date. If contracts already exist, nothing is touched and
the response says *"Contracts already submitted on this deal: <numbers>"*.

### Step 2 — Verify opens. No sign-in.

Same protection as the presentation: an unguessable session id in the URL and
nothing else. There is no password prompt on this page any more.

**Every launch lands here.** New, existing, verified, unverified. The old
behaviour — verified deals skipping straight to the presentation — is gone,
because a deal verified yesterday may have moved today, and the person about to
sit with a customer is the right person to look.

### Step 3 — "Checked by"

One box in the header. Type your name once and it is remembered in a cookie for a
year, so it is filled in on every later deal. **Confirm and Continue stays
disabled until it has a name in it** — a verification snapshot with nobody's name
on it is not worth recording.

This cookie is a convenience, not security. It authorises nothing.

### Step 4 — read the sheet, correct what is wrong

Every rating input is a text box, grouped Deal / Vehicle / Money / Customer, each
with its source beside it: CRM, VIN Decode, Entered by Staff, Edited by Staff, or
Missing. Missing-and-required rows are highlighted.

Type over anything, including values that came from CRM. When you do:

- The field shows **Edited by Staff**, with a line under it reading what it was
  and where that came from — *"was $24,999.00 from CRM"*.
- Your name, the old value, the new value and the timestamp all go into the
  verification snapshot.
- If the field also exists in CRM, a warning appears above the button:
  *"These values now differ from the CRM deal: Sale price, Odometer. Update the
  deal in CRM so the sale documents match."*
- Engine size and Factory warranty raise **no** warning. CRM does not carry them,
  so there is nothing to disagree with.

Nothing is written back to Zoho. The warning stays up on the staff view until the
CRM values match.

Three fields are closed on a cash deal — amount financed, term, APR — because on
a cash deal those are the deal's arithmetic, not unknowns. Change the deal type to
Finance and they open.

### Step 5 — Refresh, and your edits

**Refresh** re-pulls the deal from Zoho and **keeps your edits**. To throw them
away, use **Discard my edits and reload from CRM** — which drops only the edits to
fields CRM owns and keeps the ones it does not, so a refresh never costs you the
engine size you just read off the machine.

### Step 6 — Confirm and Continue

Enabled once every required field has a value, every edit reads as a number or a
date, and "Checked by" has a name. A CRM difference does **not** block it — that
was your rule: staff can still verify, and the warning stays visible.

One press does three things: saves the snapshot (every value, every source, every
edit, who and when), runs the rating, and goes **straight into the presentation at
step 1**.

If the session was verified before, the screen shows those values with a note of
who verified them and when, above the button.

### Step 7 — the presentation

`https://ps.docuride.com/plan/a2a9bb77-...`, step 1. The customer's own link,
unchanged. A customer reopening it later still goes straight in, provided the
session is verified — that is item 4 of your list, and it still holds.

If the session is *not* verified, the customer sees *"We're still getting your
options ready. Your dealership will help you with this step."* rather than any
claim about what is or is not offered.

---

## 4. Two things you should decide

### Fuel type blocks every UTV deal, and it does not need to

`Fuel type` is in TecAssured's required list for UTV, so the sheet reports it
Missing and the button stays disabled. But the rate builder already defaults fuel
type to gasoline and sends it regardless — `DEFAULT_FUEL_TYPE` in
`_shared/rate-properties.ts`. So this is one keystroke per deal that buys nothing:
there is no case where leaving it blank produces a wrong rate.

Every deal with no VIN decode on file will stop here, including 13759.

The fix is to show it as gasoline with its own source label rather than as
Missing. I have not done it, because it needs a new source word on the screen
("Default", or something you prefer) and that is your wording to pick, not mine.
Say the word and it is a small change — though `verification.ts` is bundled into
three functions, so it costs three redeploys.

### No login anywhere has a consequence worth naming

You asked for no sign-in on Verify, and that is what is shipped. The consequence:
**a customer holding their own `/plan/` link can reach `/verify/` on the same
session id, change the sale price, and re-rate.** Same id, one word different in
the path.

What still needs a password:

- the session browser at `/` (it lists buyer names, addresses and phones)
- settings and pricing
- **Void a contract**
- **Clear Submit Status Unknown**

So the paperwork-level actions are still protected. What is not is the rating
inputs on a session whose link the customer already has.

If you want that closed without a login, the clean fix is a second unguessable
token in the staff URL — `/verify/<session>/<staff-token>` — that
`fni-session-start` returns and nothing customer-facing ever contains. The
customer's link would then not be enough to reach Verify. That is maybe an hour's
work and no password for anybody. Your call; I have not built it.
