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

## `/rate` needs BOTH formats in one body

This is the thing that cost the most time, so it is worth stating flatly.

The documentation (§5, §6.2) describes `/rate` as top-level camelCase fields:
`vin`, `odometer`, `vehiclePrice`, `financeAmount`, `displacement`, `fuelType`
and so on. `/rate/requiredproperties` returns what looks like a competing wire
format: dotted lowercase names (`engine.ccs`, `finance.amount`, `new.used`,
`postal.code`) wrapped in a `properties` array.

They are not competing. §7.7 calls the dotted list **Form Properties** — it is
the schema of the *rating form*, telling you which inputs this dealer's product
set needs. The server wants the camelCase envelope **and** the properties array
in the same request:

| What we sent | What the server answered |
|---|---|
| Properties array alone | `{"error":"Array index out of range: 0"}` |
| Top-level fields alone | `{"error":" Missing displacement."}` — `displacement` inside `properties` does not satisfy it |
| **Both together** | **HTTP 200 and a full quote: 11 products, 41 rates** |

Confirmed 2026-09-25 against Dealer ID 3-306 (QA, shared test account), UTV,
serial `4XARSM994V8046456`. Quote reference number `2026092514`, ident `48582`.

`buildRateRequest()` in `_shared/rate-properties.ts` emits both halves from one
set of stored values, so there is no second source of truth and the two halves
cannot drift apart.

### Where the two formats duplicate each other

Every name `/rate/requiredproperties` returns for UTV has a top-level
counterpart. Five are the same name; the rest are renames.

| requiredproperties | top-level | note |
|---|---|---|
| `vin` | `vin` | identical |
| `year` | `year` | identical |
| `make` | `make` | identical |
| `model` | `model` | identical |
| `odometer` | `odometer` | identical |
| `price` | `vehiclePrice` | rename |
| `new.used` | `purchaseType` + `vehicleStatus` | one value, two top-level fields |
| `engine.ccs` | `displacement` | rename |
| `fuel.type` | `fuelType` | rename **and** a different value domain — see below |
| `warranty` / `Warranty` | `remainingMWM` | rename; the casing varies by vtype |
| `finance.type` | `financeType` | rename |
| `finance.amount` | `financeAmount` | rename |
| `finance.apr` | `financeApr` | rename |
| `finance.term` | `financeTerm` | rename |
| `sale.date` | `saleDate` + `vehiclePurchaseDate` | one value, two top-level fields |
| `inservice.date` | `inServiceDate` | rename |
| `postal.code` | `customerPostalCode` | rename |

Top-level fields with **no** requiredproperties counterpart, which therefore
have to come from our own knowledge of the request rather than from the form
schema: `dealerCode`, `sessionId`, `productType`, `rateDate`, `customerCity`,
`customerState`, `customerCountry`.

`fuelType` is the one place the two halves legitimately disagree on the *value*
and not just the name. §6.5 documents single letters — `G`, `E`, `D` — while the
form schema carries the word the form displays (`Gas`). The proven call sent
`"fuelType": "G"` alongside `{"name":"fuel.type","value":"Gas"}` and rated, so
the builder maps to the letter for the top-level field and echoes the stored
word in the array. Do not "fix" this into a single value.

`remainingMWM` is documented as conditional (used vehicles with remaining
manufacturer warranty), but `requiredproperties` asks for `warranty` on every
rateable vtype we have looked at, so we send it whenever we have a value.

## The Dealer ID mechanism is confirmed working

A wrong Dealer ID is rejected distinctly:

```
dealerCode 9-999  ->  {"error":"Invalid Client Website Pair"}
dealerCode 3-306  ->  gets past dealer validation
```

That is the check the one-login/per-store-Dealer-ID design depends on, and it
does what it should.

## What a successful quote looks like

The 2026-09-25 call returned 78,618 bytes of JSON with a single top-level key,
`quote`, holding `asyncModify`, `attributes`, `buyerPostal`, `calculating`,
`client`, `createdIP`, `createdName`, `createdWhen`, `displayName`, `ident`,
`lienholder`, `modifiedWhen`, `referenceNumber`, `rerateFlag`, `saleDate`,
`status`, `taxRate`, `vehicles` and `webSite`.

Products hang off `quote.vehicles[0]`, each with a `rates` array. Every rate
carries `attributes`, `consumables`, `dealerCost`, `dealerDeduct`, `expireDate`,
`expireMiles`, `fromService`, `fromZero`, `fuzzy`, `graceDays`, `ident`,
`options`, `product`, `providerMarkup`, `selected`, `subTotal`, `systemMarkup`,
`termMiles`, `termMonths` and `unique`. `dealerCost` is the number
`fni-contract-submit` validates against before it will submit.

Two things worth knowing about the QA response:

- **Every product came back labelled USED** (`USED PLATINUM UTV`,
  `USED ATV/UTV CARE`, …) even though the request said `purchaseType: "New"`,
  `vehicleStatus: "New"` and `new.used: "New"`. The quote does not echo back
  enough to say why. Most likely the shared QA Dealer ID simply has only used
  programs loaded. Worth confirming against the production Dealer ID before
  anyone reads product names as a condition check.
- **There is no `error` key on success.** The refusal check has to look for the
  key, not for a non-200 — see "Errors come back as HTTP 200" above.

## The request body we send

Generated by the deployed builder. `sessionId` comes from
`/auth/loginassertion`; everything else is derived from the session row and the
cached `fni.store_rate_properties` for that store and vtype.

### UTV

```json
{
  "sessionId": "<from /auth/loginassertion>",
  "dealerCode": "3-306",
  "vtype": "UTV",
  "productType": "All",
  "rateDate": "2026-09-25",
  "vin": "4XARSM994V8046456",
  "year": "2027",
  "make": "Polaris",
  "model": "Ranger Crew XP 1000 Cab",
  "odometer": "5",
  "vehiclePrice": "28995",
  "purchaseType": "New",
  "vehicleStatus": "New",
  "vehiclePurchaseDate": "2026-09-25",
  "saleDate": "2026-09-25",
  "inServiceDate": "2026-09-25",
  "financeAmount": "30500",
  "financeTerm": "60",
  "financeType": "Purchase",
  "financeApr": "8.99",
  "customerCity": "Parkersburg",
  "customerState": "WV",
  "customerCountry": "US",
  "customerPostalCode": "26101",
  "displacement": "999",
  "fuelType": "G",
  "remainingMWM": "12",
  "properties": [
    {
      "name": "vin",
      "value": "4XARSM994V8046456"
    },
    {
      "name": "fuel.type",
      "value": "Gas"
    },
    {
      "name": "year",
      "value": "2027"
    },
    {
      "name": "make",
      "value": "Polaris"
    },
    {
      "name": "model",
      "value": "Ranger Crew XP 1000 Cab"
    },
    {
      "name": "new.used",
      "value": "New"
    },
    {
      "name": "engine.ccs",
      "value": "999"
    },
    {
      "name": "finance.type",
      "value": "Purchase"
    },
    {
      "name": "finance.amount",
      "value": "30500"
    },
    {
      "name": "finance.apr",
      "value": "8.99"
    },
    {
      "name": "finance.term",
      "value": "60"
    },
    {
      "name": "odometer",
      "value": "5"
    },
    {
      "name": "price",
      "value": "28995"
    },
    {
      "name": "sale.date",
      "value": "2026-09-25"
    },
    {
      "name": "inservice.date",
      "value": "2026-09-25"
    },
    {
      "name": "Warranty",
      "value": "12"
    },
    {
      "name": "postal.code",
      "value": "26101"
    }
  ]
}
```

### ATV

Identical apart from `vtype` and the `warranty` casing the server itself chose —
lowercase for ATV, capitalised for UTV. `remainingMWM` is spelled the same in
both, because that name comes from the documentation rather than from the form
schema.

```json
{
  "sessionId": "<from /auth/loginassertion>",
  "dealerCode": "3-306",
  "vtype": "ATV",
  "productType": "All",
  "rateDate": "2026-09-25",
  "vin": "4XARSM994V8046456",
  "year": "2027",
  "make": "Polaris",
  "model": "Ranger Crew XP 1000 Cab",
  "odometer": "5",
  "vehiclePrice": "28995",
  "purchaseType": "New",
  "vehicleStatus": "New",
  "vehiclePurchaseDate": "2026-09-25",
  "saleDate": "2026-09-25",
  "inServiceDate": "2026-09-25",
  "financeAmount": "30500",
  "financeTerm": "60",
  "financeType": "Purchase",
  "financeApr": "8.99",
  "customerCity": "Parkersburg",
  "customerState": "WV",
  "customerCountry": "US",
  "customerPostalCode": "26101",
  "displacement": "999",
  "fuelType": "G",
  "remainingMWM": "12",
  "properties": [
    {
      "name": "vin",
      "value": "4XARSM994V8046456"
    },
    {
      "name": "fuel.type",
      "value": "Gas"
    },
    {
      "name": "year",
      "value": "2027"
    },
    {
      "name": "make",
      "value": "Polaris"
    },
    {
      "name": "model",
      "value": "Ranger Crew XP 1000 Cab"
    },
    {
      "name": "new.used",
      "value": "New"
    },
    {
      "name": "engine.ccs",
      "value": "999"
    },
    {
      "name": "finance.type",
      "value": "Purchase"
    },
    {
      "name": "finance.amount",
      "value": "30500"
    },
    {
      "name": "finance.apr",
      "value": "8.99"
    },
    {
      "name": "finance.term",
      "value": "60"
    },
    {
      "name": "odometer",
      "value": "5"
    },
    {
      "name": "price",
      "value": "28995"
    },
    {
      "name": "sale.date",
      "value": "2026-09-25"
    },
    {
      "name": "inservice.date",
      "value": "2026-09-25"
    },
    {
      "name": "warranty",
      "value": "12"
    },
    {
      "name": "postal.code",
      "value": "26101"
    }
  ]
}
```
