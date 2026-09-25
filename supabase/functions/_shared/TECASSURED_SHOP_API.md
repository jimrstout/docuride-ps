# TecAssured Shop API — what the QA server actually accepts

Everything here was observed against `https://ratessys-qa.com/rs/` on
2026-09-25 with the shared Riders Advantage test login (`RidersShopAPI`) and
the shared test Dealer ID `3-306`. It is written down because it contradicts
what the code was built against in several places, and because a QA server is
cheaper to ask than it is to guess at twice.

Nothing here replaces the Shop API Services documentation. Where the two
disagree, the documentation wins and this file should be corrected.

## Endpoints that exist

| Path | Exists |
| --- | --- |
| `POST /auth/loginrequest` | yes |
| `POST /auth/loginassertion` | yes |
| `POST /rate` | yes |
| `POST /rate/requiredproperties` | yes |
| `POST /contract/submit` | yes |
| `POST /contract/document` | yes |
| `POST /contract/void` | yes |
| `POST /rate/vehicletypes` | **no — 404** |

`/rate/vehicletypes` is absent under every spelling tried (`vehicletypes`,
`vehicleTypes`, `vehicletype`, `vehicletypelist`, `vtypes`, and under `/dealer`,
`/shop`, `/api`, `/lookup` and `/rates` prefixes), by POST and by GET.

The probe distinguishes a missing path from a present one in both directions:
`/rate/requiredproperties` answers while `/rate/requiredProperties` 404s, and
`GET /rate` returns **405 Method Not Allowed** rather than 404. So a 404 here
means the path is not there, not that the request was wrong.

**`getVehicleTypes` has been removed** (2026-09-25). `/rate/requiredproperties`
replaces it: it answers the more useful question — not "what does this dealer
sell" but "what must I send to rate it" — and a vehicle type a dealer does not
sell comes back empty, which is the same information. `fni.store_rate_properties`
caches that per store per vehicle type, and records an empty answer as
`Unavailable`. The old `fni-refresh-vehicle-types` function is a tombstone
returning 410 and naming its replacement.

## Errors come back as HTTP 200

This is the single most important thing in this file. TecAssured answers a
refused session, a rejected request and a server fault alike with **HTTP 200**
and an `error` string in the body:

```json
{"error":"Invalid Session Id, please try logging in again"}
{"error":" Missing displacement."}
{"error":"Invalid Client Website Pair"}
{"error":"Array index out of range: 0"}
```

Any code that treats `res.ok` as success will store an error object as though it
were data. The client checks the body, not the status.

Note the leading space in `" Missing displacement."` — theirs, not a typo here.

## The rate request is a properties array, not named fields

`/rate/requiredproperties` returns what a given dealer needs for a given vehicle
type, and the names are **dotted, lowercase**, not the camelCase fields the
build was sending:

```
vin  fuel.type  year  make  model  new.used  engine.ccs
finance.type  finance.amount  finance.apr  finance.term
odometer  price  sale.date  inservice.date  postal.code
warranty | Warranty
```

Sending the camelCase top-level fields (`vehiclePrice`, `financeAmount`,
`purchaseType`, `inServiceDate`, …) produces `" Missing displacement."` even
when `displacement` is supplied in `properties`. Sending the dotted names gets
past that check. So the request is built from the properties array.

**`warranty` is lowercase for MCYC and ATV and capitalised as `Warranty` for
UTV, BIKE and AUTO.** That is TecAssured's inconsistency, observed directly, and
it means the property list has to be taken from `requiredproperties` per
vehicle type rather than hard-coded.

The required set genuinely varies. Cached from dealer 3-306 on 2026-09-25 by
`fni-refresh-rate-properties`, every vehicle type DocuRide can produce:

| vtype | properties | warranty spelled | needs `inservice.date` | needs `engine.ccs` |
| --- | --- | --- | --- | --- |
| ATV  | 17 | `warranty` | yes | yes |
| BIKE | 17 | `Warranty` | yes | yes |
| BOAT | 14 | *(not required)* | no | no |
| MCYC | 16 | `warranty` | no | yes |
| PWAC | 14 | *(not required)* | no | no |
| SNOW | 15 | *(not required)* | no | yes |
| UTV  | 17 | `Warranty` | yes | yes |

Three types do not ask for a warranty property at all, and the two that spell it
with a capital are not the two that need `inservice.date`. There is no rule to
infer here, which is exactly why the request is built from this endpoint's answer
rather than from a table in our code.

`AUTO` and `RV` also answer for this dealer but are not in DocuRide's body-type
map, so nothing can produce them.

## The Dealer ID mechanism is confirmed working

A wrong Dealer ID is rejected distinctly:

```
dealerCode 9-999  ->  {"error":"Invalid Client Website Pair"}
dealerCode 3-306  ->  gets past dealer validation
```

That is the check the one-login/per-store-Dealer-ID design depends on, and it
does what it should.

## Open: `/rate` returns "Array index out of range: 0"

With the login accepted, the Dealer ID accepted and every required property
supplied, `/rate` answers:

```json
{"error":"Array index out of range: 0"}
```

It is a server-side Java fault, not a validation message, and it is **unchanged**
by:

- vehicle type (UTV, MCYC, and an invented one all behave the same)
- the properties array being complete, partial, or empty
- wrapping the vehicle in `vehicles: [...]`, in `vehicle: {...}`, or neither
- `productType` being `All` or omitted

Because an empty properties array and an invalid vehicle type produce exactly
the same error, the server is failing **before** it reads the vehicle data. The
two candidates are an envelope element the request still lacks, or the shared
test Dealer ID having no rate programs configured on QA. Telling those apart
needs the documentation or TecAssured; further guessing at their QA server is
not a good use of anyone's time.

## The request body we send for a UTV

Generated by the deployed builder from the QA test session, for comparison
against TecAssured's sample when it arrives. `sessionId` is added by the client.

```json
{
  "sessionId": "<from /auth/loginassertion>",
  "dealerCode": "3-306",
  "vtype": "UTV",
  "productType": "All",
  "properties": [
    { "name": "vin",            "value": "4XARSM994V8046456" },
    { "name": "fuel.type",      "value": "Gas" },
    { "name": "year",           "value": "2027" },
    { "name": "make",           "value": "Polaris" },
    { "name": "model",          "value": "Ranger Crew XP 1000 Cab" },
    { "name": "new.used",       "value": "New" },
    { "name": "engine.ccs",     "value": "999" },
    { "name": "finance.type",   "value": "Purchase" },
    { "name": "finance.amount", "value": "30500" },
    { "name": "finance.apr",    "value": "8.99" },
    { "name": "finance.term",   "value": "60" },
    { "name": "odometer",       "value": "5" },
    { "name": "price",          "value": "28995" },
    { "name": "sale.date",      "value": "2026-09-25" },
    { "name": "inservice.date", "value": "2026-09-25" },
    { "name": "Warranty",       "value": "12" },
    { "name": "postal.code",    "value": "26101" }
  ]
}
```

Three things to check it against:

- **`Warranty` is capitalised** because that is how the server spelled it for
  UTV. The stored value is lowercase `warranty`; the builder looks values up
  case-insensitively and echoes the server's name. For MCYC the same session
  produces lowercase `warranty`.
- **Every name comes from `/rate/requiredproperties`**, in its order. Nothing is
  added on our side — no `msrp`, no camelCase duplicates — and nothing required
  is omitted.
- **`Loan` is sent as `Purchase`**, and `condition` as `new.used`.

The unresolved part is the envelope, not the properties: `dealerCode`, `vtype`
and `productType` are our best reading, and `/rate` still answers
`{"error":"Array index out of range: 0"}` identically for an empty properties
array and an invented vehicle type — so the server is failing before it reads
any of this. That is what the sample is needed to settle.
