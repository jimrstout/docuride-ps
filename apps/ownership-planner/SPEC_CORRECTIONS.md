# Ownership Planner — spec corrections

Step zero of the build spec says its function signatures were inferred from project
notes rather than read from source, and to correct the document where it is wrong.
This is that correction, made against the deployed Edge Functions in
`fovccigwlcmmzfubpfny` and the live `fni` schema on 2026-09-19.

Everything below is a place the spec and reality disagree. Where the spec is right,
it is not repeated here.

---

## 1. Payment math is wrong in three places

This is the most consequential correction, so it goes first. The spec's amortization
*function* is correct; all three of its **inputs** are wrong.

Verified against the one real session in `fni.sessions`
(`44e41c35-c501-4ee8-84ed-8858b6b9101f`, a 2020 Can-Am Spyder RT), whose Zoho
snapshot carries:

| Zoho field              | Value      |
| ----------------------- | ---------- |
| `Sold_1_Vehicle_DSP`    | 16,023.79  |
| `DC_Sold_1_Balance_Due` | 13,800.94  |
| `TILA_Amount_Financed`  | 13,930.94  |
| `Interest_Rate`         | 7.84       |
| `TILA_APR`              | 8.5165     |
| `Term_Months`           | 60         |
| `TILA_Pmt1_Count`       | 59         |
| `TILA_Pmt1_Amount`      | 285.93     |
| `TILA_Pmt2_Count`       | 1          |
| `TILA_Pmt2_Amount`      | 285.60     |
| `TILA_Finance_Charge`   | 3,224.53   |

Running the spec's own amortization formula over the candidate inputs:

| Principal | Rate           | Term | Payment  | vs. actual 285.93 |
| --------- | -------------- | ---- | -------- | ----------------- |
| 13,930.94 | 8.5165 (APR)   | 60   | 285.9254 | **exact**         |
| 13,930.94 | 8.5165 (APR)   | 59   | 289.8169 | +3.89             |
| 13,800.94 | 8.5165 (APR)   | 60   | 283.2572 | −2.67             |
| 13,800.94 | 7.84 (Int.)    | 60   | 278.7777 | −7.15             |
| 13,930.94 | 7.84 (Int.)    | 60   | 281.4037 | −4.53             |

Only one combination reproduces the contract. It also reconciles both ways to the
penny: `59 × 285.93 + 285.60 = 17,155.47`, and
`TILA_Amount_Financed + TILA_Finance_Charge = 13,930.94 + 3,224.53 = 17,155.47`.

### 1a. Principal is `TILA_Amount_Financed`, not `amount_financed`

The spec says "base payment uses `amount_financed`, which maps from
`DC_Sold_1_Balance_Due`". That value is the balance due on the unit, not the
amount the lender amortizes — the two differ by $130.00 on this deal (a finance
or documentary fee financed on top). Using it puts every payment on the screen
$2.67/month light.

`TILA_Amount_Financed` is not stored on `fni.sessions` at all. Added as
`tila_amount_financed` (see §2).

### 1b. Term is 60, not `finance_term`

`fni-session-start` maps `finance_term` from `TILA_Pmt1_Count`. On a deal with an
odd final payment that is the count of the *first* payment stream, not the loan
term — here 59, with a 60th payment of 285.60 carried in `TILA_Pmt2_*`.
Amortizing over 59 is $3.89/month wrong, and the error only appears on deals with
an irregular final payment, which is most of them.

The true term is `Term_Months` (60), equal to `TILA_Pmt1_Count + TILA_Pmt2_Count`.
Added as `finance_term_total`. `finance_term` is left as-is so nothing downstream
that already reads it changes meaning.

### 1c. `deal.interest_rate` does not exist

The spec's `const rate = deal.apr ?? deal.interest_rate;` cannot run — `fni.sessions`
has an `apr` column and no interest rate column. Zoho does carry `Interest_Rate`
(7.84 here, distinct from the 8.5165 APR), so the spec's intent is sound and the
column was simply missing. Added as `interest_rate`.

The precedence in the spec is correct and confirmed by the data: APR is the value
that reproduces the contract, so APR wins when present. The honest-labelling rule
stands — when the planner amortizes with APR the field must read "Annual
percentage rate".

---

## 2. Schema additions, corrected

The spec's three additions are right and are implemented. Three more are required
by §1, and two of its details would have failed against live constraints.

Implemented in `0006_fni_ownership_planner.sql`:

- `fni.product_catalog` — as specced.
- `fni.pricing_rules` — as specced.
- `fni.sessions.expires_at` — as specced, default 24h.
- `fni.selected_products.disposition` — as specced.
- `fni.sessions.interest_rate`, `.tila_amount_financed`, `.finance_term_total` — **new**, per §1.

### 2a. `sessions.status` cannot be set to "In Progress"

The spec says `fni-session-save` should "update `sessions.status` to In Progress on
the first save". `fni.sessions.status` carries a CHECK constraint admitting only:

    Initiated | Rated | Presenting | Products Selected | Agreement Created
    Finalized | Written Back | Cancelled

Writing "In Progress" would fail the insert outright. `fni-session-save` writes
**`Presenting`** on first save instead, which is the existing vocabulary for the
same state, and `Products Selected` once the customer completes the plan.

### 2b. `selected_products` has no product code, and no upsert key

The spec's "upsert into `selected_products` keyed on session plus product code"
has two problems. There is no `product_code` column — the provider identifiers are
`product_type`, `provider_product_id` and `rate_unique_id` — and there is no unique
constraint to upsert against, so a repeated save would have inserted duplicates
rather than updating.

Resolved by adding a unique index on `(session_id, provider_product_id)` and
treating `provider_product_id` as the product code the spec means. The Next.js and
Edge layers call it `product_code` in their payloads and map it at the boundary.

### 2c. Decline rows need the NOT NULL columns relaxed

`selected_products` declares `product_name`, `provider_product_id`, `rate_unique_id`,
`dealer_cost`, `retail_price`, `customer_price` and `rate_snapshot` NOT NULL. That is
correct for a selection but impossible for a decline, which the spec now requires a
row for. `dealer_cost`, `retail_price`, `customer_price` and `rate_snapshot` are made
nullable; the identity columns stay NOT NULL because a decline still names a product.

---

## 3. `rated_offers` is one row per session, not many

The spec's `fni-session-get` response has `offers: [ ...rated_offers rows, or [] ]`.
`fni.rated_offers` has a **unique constraint on `session_id`** and stores the entire
TecAssured Offer Format in a single `response_payload` JSONB column, with
`request_payload`, `product_count` and `rated_at` alongside. `fni-rate-vehicle`
upserts it on conflict.

`fni-session-get` therefore returns a single `offer` object — the row, with its
payload — and `offer: null` when the session has not been rated. The UI unpacks
products out of `response_payload`.

---

## 4. Session field names

The spec's proposed response nests vehicle and financial fields under invented
names. Actual column names on `fni.sessions`:

| Spec name          | Actual column        |
| ------------------ | -------------------- |
| `year`             | `unit_year`          |
| `make`             | `unit_make`          |
| `model`            | `unit_model`         |
| —                  | `unit_submodel`      |
| `body_type`        | `condition` is separate; body type is not stored — only the mapped code |
| `tecassured_code`  | `vehicle_type_code`  |
| `mileage_or_hours` | `odometer`           |
| `term_months`      | `finance_term` (and `finance_term_total`, §1b) |
| `interest_rate`    | added, §1c           |

`fni-session-get` keeps the spec's nested `vehicle` / `financials` shape for the
client, and does the renaming server-side, so the UI reads the spec's vocabulary
while the database keeps its own.

---

## 5. Auth accepts a query parameter as well as a header

The spec says `FNI_WEBHOOK_SECRET` header. Every deployed function accepts
**either** `?secret=` on the query string **or** the `x-webhook-secret` header, and
compares with the constant-time `secretsMatch` in `_shared/supabase.ts`.

The new functions match that behaviour. The Next.js edge wrapper uses the header,
so the secret stays out of request URLs and therefore out of logs.

---

## 6. `menu_url` points at the wrong path

`fni-session-start` returns `` `${FNI_MENU_BASE_URL}/${session_id}` ``, defaulting to
`https://docuride.app/fni`. The planner serves `/plan/[sessionId]`. Set
`FNI_MENU_BASE_URL` to `https://<planner-domain>/plan` when the Vercel project is
created — no code change needed, and no change to the Zoho button, which only opens
whatever URL the function returns.

---

## 7. Pre-existing bug in `fni-contract-documents` (not fixed here)

Flagging rather than fixing, because it sits in the credentials-blocked bucket and
correcting it needs the real TecAssured `/contract/document` response shape.

The function reads four columns off `fni.agreement_products` that do not exist:

    product.product_id          product.product_unique
    document_retrieved_at       filename            (both written in an UPDATE)

The table has `provider_product_id`, `product_type`, `contract_number`, `document_id`
and `pdf_link`. The reads yield `undefined` and the UPDATE will error. This will
throw the first time it is called with live credentials.

The signature-map format it produces is confirmed correct and is what the
acknowledgment document appends to:

    filename|page|left|top|right|bottom|signer_type

one line per contract, newline-joined, returned as `signature_map`. Note the
function only *returns* the string — it does not write `FNI_Signature_Map` in Zoho.

---

## 8. Unchanged open question: `vehiclePrice` on the rate call

The spec flags this and it is genuinely open. `fni-rate-vehicle` sends
`vehiclePrice: sess.sale_price`, and the deployed source already carries a comment
raising the same GAP concern. Still needs confirming with TecAssured. No change made.
