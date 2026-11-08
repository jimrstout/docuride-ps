# The provider's own description of its API (Test server)

Fetched once each on 8 Nov 2026 from the provider's Test server
(ratessys-qa.com), read only, with no login. Live was not contacted. Nothing
here holds a credential, a session or a token: the files name a `Cookie`
header carrying `sessionId`, never a value.

## What was asked for, and what came back

| Address | Answer | Kept here |
| --- | --- | --- |
| `https://ratessys-qa.com/ws/?wsdl` | 404, "Invalid Request" | no |
| `https://ratessys-qa.com/ws/` | 404, "Invalid Request", and no pointer to a WSDL | no |
| `https://ratessys-qa.com/rs/application.wadl` | 200, a WADL (Jersey 2.46) | `ratessys-qa-rs-application.wadl` |
| `https://ratessys-qa.com/rs/application.wadl?detail=true` | 200, the full WADL the first one names in its own hint | `ratessys-qa-rs-application-detail.wadl` |
| `https://ratessys-qa.com/rs/openapi.json` | 500, the server's error page | no |
| `https://ratessys-qa.com/rs/swagger.json` | 404 | no |

So the Test server publishes no SOAP description at the documented WSDL
address, and the REST service describes itself only in WADL. The WADL has an
empty `<grammars/>`: it names each operation, its method and path, and the
session cookie, but no request or answer fields. Those are only in the
provider's PDF (`tecassured-shop-api.md`) and what PS has seen
(`supabase/functions/_shared/TECASSURED_SHOP_API.md`).

## Every operation the WADL lists

All are under `https://ratessys-qa.com/rs/`. The full WADL adds nothing but
the standard OPTIONS answer on each path and the WADL's own addresses.

| Method and path | Name in the WADL | In the PDF | Changes anything |
| --- | --- | --- | --- |
| POST `/auth/loginrequest` | loginRequest | yes | no (starts a login) |
| POST `/auth/loginassertion` | loginAssertion | yes | no (finishes a login) |
| POST `/auth/logincert` | loginCertification | **no** | no (a login, by certificate, by its name) |
| POST `/ps/makes` | getMakes | yes | no: the dealer's makes by vehicle type |
| POST `/ps/models` | getModels | yes | no: one make's models by vehicle type |
| POST `/decode` | decode | yes | no: a VIN, with a vehicle type |
| POST `/decode/ps` | decodeps | yes | no: a powersports VIN |
| POST `/dmslookup` | dmsLookup | yes | no: one deal read from the dealer's DMS |
| POST `/rate/requiredproperties` | requiredPropertiesRequest | yes | no: what a rate needs for a vehicle type |
| POST `/rate` | rateRequest | yes | no: the products and prices for one vehicle |
| POST `/contract/submit` | contractSubmit | yes | **yes**: creates contracts |
| POST `/contract/void` | contractVoid | yes | **yes**: voids a contract |
| POST `/contract/document` | contractDocumentStream | yes | no change, but it fetches a contract document |
| GET `/openapi.{json,yaml}` | getOpenApi | no | no (a description; the JSON one answers 500) |
| POST `/hello/greet` | greeting | no | no (a test greeting, query `name`) |

No operation lists the products, programs or plans a dealer is set up for,
or any dealer setup or coverage. Products come back only from `/rate`, for
one vehicle at a time.
