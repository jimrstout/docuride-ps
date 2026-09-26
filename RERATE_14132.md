# Re-rating deal 14132

Session `89fb3482-c09b-49ee-b1d8-78d1ac78e16c`
2026 Can-Am Defender XT HD7, VIN 3JBUKAJ44TK002241, stock 30111, cash deal,
store 3-306, vtype **UTV**.

I could not run this myself. The call needs `FNI_WEBHOOK_SECRET`, which exists
only as a Supabase Edge Function secret, and you asked me not to rotate it.

## Three ways to do it. Any one is enough.

**1. Just open the planner.** This is the fix, so this is also the test.
`https://ps.docuride.com/plan/89fb3482-c09b-49ee-b1d8-78d1ac78e16c`
The planner now asks for the rate itself on first load, which is what was never
happening. Watch the Care & Protection step: it will show the neutral message
while the rate runs, then the menu appears.

**2. The console.** Sign in at `https://ps.docuride.com`, find deal 14132, and
press **Rate** in its row. The new Rating column shows the outcome either way.

**3. Curl, if you want the raw response.**

```sh
curl -sS -X POST "https://fovccigwlcmmzfubpfny.supabase.co/functions/v1/fni-rate-vehicle" \
  -H "x-webhook-secret: $FNI_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"89fb3482-c09b-49ee-b1d8-78d1ac78e16c"}' \
  | head -c 600
```

## What I expect, and what each outcome means

The request now goes out where it never did before. Two fields still have no
source anywhere in DocuRide, so they are absent from it:

  - **engine.ccs** (Engine CCs)
  - **Warranty** (Remaining Manufacturer Warranty Months)

No Zoho field carries either. DX1 gives us photos only. I deliberately did not
invent values: a guess at engine size is a guess at this customer's price.

TecAssured decides whether it can rate without them, which is the point of the
change. Either answer is useful:

**It rates.** `"status":"Rated"` with a product count. The customer sees the
menu. We have also learned that engine size is not required for UTV products on
this dealer, which is worth knowing.

**It refuses**, most likely `" Missing displacement."` Then the console's Rating
column reads **Failed** and names both fields, the customer keeps seeing the
neutral message rather than being told plans are not offered, and we need the
engine size once. For the HD7 that is the 650cc Rotax, but I am not putting a
number I inferred from a model name onto a real customer's rate. Confirm it and
run:

```sh
curl -sS -X POST "https://fovccigwlcmmzfubpfny.supabase.co/functions/v1/fni-rate-vehicle" \
  -H "x-webhook-secret: $FNI_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
        "session_id": "89fb3482-c09b-49ee-b1d8-78d1ac78e16c",
        "overrides": {
          "vehicle_properties": { "engine.ccs": "650", "warranty": "6" }
        }
      }' | head -c 600
```

`warranty` is the remaining factory warranty in months on the day of sale. Six
is BRP's standard term on a new Defender; put in whatever the actual coverage
is.

## The gap this leaves

There is no screen for entering engine size and warranty months. Today it is
`overrides.vehicle_properties` on the rate call, which is a curl, not a job
anybody in F&I can do. That wants a small per-session form on the console next
to the Rate button. Say the word and I will build it.

## Tell me the result

Post the response or just say which way it went, and I will read
`fni.rated_offers` and report vtype, product count, and what the customer's
screen says.

Rate only. Nothing here submits a contract.
