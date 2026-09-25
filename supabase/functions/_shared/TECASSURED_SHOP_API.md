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

`_shared/tecassured.ts` still has `getVehicleTypes`. Both callers now report its
absence as "Unavailable" rather than a failure, because a missing path says
nothing about whether a Dealer ID is good.

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

The required set genuinely varies: UTV requires `inservice.date`, MCYC does not.
PWAC, BOAT and RV require no `engine.ccs`; SNOW does.

Every vehicle type tried is valid for dealer 3-306: `UTV MCYC ATV BIKE PWAC
BOAT SNOW AUTO RV`.

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
