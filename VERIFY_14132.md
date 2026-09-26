# Deal 14132 on the Verify screen

`https://ps.docuride.com/verify/89fb3482-c09b-49ee-b1d8-78d1ac78e16c`
2026 Can-Am Defender XT HD7, VIN 3JBUKAJ44TK002241, stock 30111, cash deal.
State right now: **Needs Verification**. Nothing has been rated.

## The VIN decode answered two of the three gaps

I called `/decode/ps` against the QA server with this VIN. It returns more than
section 3 of the documentation promises:

```json
{"year":"2026","make":"Can-Am","model":"Defender","displacement":"650","vtype":"UTV","fuelType":"G"}
```

| Field | Documented | What it answers |
| --- | --- | --- |
| `displacement` 650 | yes | `engine.ccs`, which nothing else in the system had |
| `fuelType` G | no | `fuel.type`, which we had been defaulting to gasoline |
| `vtype` UTV | no | An independent check on our body-type mapping. It agrees |

**No warranty information of any kind.** Not in the documented response and not
in the live one. So remaining factory warranty months has no source anywhere:
not CRM, not DX1, not the decode.

That decode is already cached on the session, so the screen reads it now.

## What the screen shows as missing

Of the seventeen fields TecAssured asks for on a UTV, sixteen have values and
**one is missing**:

> **Factory warranty remaining (months)** — Missing, required

Everything else resolves. In the words the screen uses:

**Deal** Deal # 14132, Stock # 30111, Deal type Cash, Sale date 2026-09-26. All
CRM.

**Vehicle** VIN, Year 2026, Make Can-Am, Model Defender XT HD7, New, Vehicle
type UTV, Odometer 1, In-service date 2026-09-26 from CRM. Engine size 650 and
Fuel type G from **VIN Decode**. Factory warranty remaining: **Missing**.

**Money** Sale price $16,899.00 from CRM. Amount financed $0.00, Term 0, APR 0%
from CRM, because a cash deal finances nothing. Note the sale price is not the
$19,764.64 sitting in `amount_financed`: that is a leftover from an earlier draft
with no lienholder attached, and neither the screen nor the rate request uses it.

**Customer** Barboursville, WV, 25504. City, state and ZIP only. Nothing on this
screen needs a name or a street to check a rate.

So the Verify button is greyed out with one line under it:

> Still needed before this can be verified: **Factory warranty remaining
> (months)**.

## To finish it

1. Open the link, type the remaining factory months in that one box, Save.
2. Press **Verify and rate**. That records you, the time, and every value with
   its source, then asks TecAssured for the menu.

Six is BRP's standard term on a new Defender, but I am not putting a number I
inferred onto a real customer's rate. Read it off the coverage.

## What changed behind it

- The planner will not rate an unverified session. Until Verify is pressed, the
  customer sees "We're still getting your options ready. Your dealership will
  help you with this step."
- CRM fields are read-only on the screen, each saying "Correct this in CRM, then
  click Refresh."
- Refresh re-pulls only the rating inputs. If one moved since the verification,
  the session drops back to Needs Verification and the old quote is marked out of
  date rather than deleted.
- The Verify button and the endpoint use one `ready` computation, so the button
  cannot be enabled over a request the endpoint would refuse.
- Not knowing counts as not ready: a cold properties cache, an unmapped vehicle
  type, or a required property the screen has no field for all block Verify.

## One thing I could not do

I could not press Verify for you. It needs `FNI_WEBHOOK_SECRET`, which exists
only as an Edge Function secret, and you asked me not to rotate it. The decode
above I ran directly against TecAssured from Postgres, which needs only the
provider credentials already in the database.
