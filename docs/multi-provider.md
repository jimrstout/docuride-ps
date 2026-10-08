# DocuRide PS: many F&I providers

Status: design, kept current as the parts land. Part 1 is the first to be built.

DocuRide PS was built around one F&I vendor: Riders Advantage, rated and
contracted through the TecAssured API. This document describes how it becomes a
system for many providers:

- **Connected providers** have an API. TecAssured today; others later.
- **Price Sheet providers** are OEM programs (BRP, Kawasaki, Honda, Indian
  Motorcycle, Polaris ORV, and any others staff add) whose rates come from price
  sheets the dealer uploads. The sheets are read with the Claude API, checked,
  reviewed by staff, and published.
- **Menu templates** decide which products a deal is offered, chosen per deal by
  deal type, vehicle type, New or Used, make and store.

The rule throughout: a deal at Parkersburg verifies, rates with TecAssured and
presents the same products it does today, until a template or a price sheet
provider says otherwise.

Everything stored and shown is human-readable ("Price Sheet", "Recorded by
Staff", "Published"), never a code.

---

## 1. Data model

### fni.providers (Part 1)

| Column | Meaning |
|---|---|
| id, tenant_id | |
| name | "Riders Advantage", "BRP" |
| kind | "Connected" or "Price Sheet" |
| adapter | For Connected: the adapter that talks to its API ("TecAssured"). Null for Price Sheet. |
| contract_method | "Through API" or "Recorded by Staff" |
| makes | The vehicle makes whose OEM program this is. Empty for aftermarket. Matched case-insensitively. |
| active, notes | |
| created_at, updated_at, updated_by | |

Seeded for the one tenant: Riders Advantage (Connected, TecAssured, Through
API, no makes), BRP (Can-Am, Sea-Doo, Ski-Doo), Kawasaki (Kawasaki), Honda
(Honda), Indian Motorcycle (Indian, Indian Motorcycle), Polaris ORV (Polaris).
The five OEMs are Price Sheet and Recorded by Staff.

### provider_id everywhere a product is named (Part 1)

- `product_catalog.provider_id`, not null, backfilled to Riders Advantage.
  Uniqueness is (tenant, provider, product code), with the store added for a
  store's own copy of a product. A store override of the tenant's copy is how
  the catalog already works, so it is kept.
- `product_catalog.category`: one of "Mechanical Protection", "Maintenance",
  "Tire and Wheel", "Theft", "Battery", "Appearance", "Other".
- `selected_products.provider_id` and `agreement_products.provider_id`, not
  null, backfilled. Their uniqueness gains the provider: two providers may use
  the same product code.
- `rated_offers.provider_id`, backfilled. One row per (session, provider), so a
  session holds one rating attempt per provider. `out_of_date` stays per row,
  and a recorded attempt always clears it.
- `pricing_rules.provider_id`, nullable. Null means any provider.
- `store_provider_accounts.provider_id` replaces the `provider` text.
  `dealer_code` and `credential_id` become nullable, because a Price Sheet
  provider has neither. A Connected account still needs both, which the code
  that reads it checks.

The admin Pricing page's "menu stores" become stores with at least one active
provider account.

### Menu templates (Part 3)

`fni.menu_templates`: name, description, conditions (store_ids, deal_types,
vehicle_types, conditions, makes; an empty list means any), priority, active,
updated_by.

`fni.menu_template_slots`: template_id, position, title, category, mode ("Best
Match" or "Side by Side"), and the ordered list of eligible product ids.

`sessions.menu_template_id` records the template matched at rating time.

### Price sheets (Part 5)

`fni.price_sheets`: provider, name, effective dates, status ("Draft",
"Published", "Retired"), the source file in private storage, parse status and
notes, model, tokens, who uploaded and published it and when.

`fni.price_sheet_rates`: one row per buyable rate, with eligibility (makes,
model contains, model years, vehicle types, New or Used, maximum age, maximum
odometer, engine size range), the terms (months, miles, deductible), dealer
cost, suggested retail, options, the source page or tab and row, the model's
confidence, and a flag with its reason.

### OEM contracts (Part 7)

A "Recorded by Staff" product is contracted in the OEM's own portal. Staff
record the contract number and upload the contract PDF on Verify; the agreement
product is then Recorded, and Void marks it Voided with a reason and a name.

---

## 2. The normalized offer (Part 2)

Every adapter returns offers in one shape. One offer is one buyable rate.

```ts
interface NormalizedOffer {
  provider_id: string;
  provider_name: string;
  product_id: string | null;   // the catalog row, when matched
  product_code: string;        // the provider's own product code
  product_name: string;
  category: Category | null;
  family_code: string;         // groups tiers that are one decision
  plan: string | null;         // plan or coverage level: "Gold", "Plan A"
  term_months: number | null;
  term_miles: number | null;
  deductible: number | null;
  deductible_label: string | null;
  disappearing_deductible: boolean;
  dealer_cost: number | null;
  suggested_retail: number | null;
  maximum_price: number | null; // a cap the provider enforces at submit
  options: SurchargeOption[];
  eligibility_notes: string[];
  rate_key: string;            // what contracts this exact offer
}
```

The planner still decides one family at a time (Platinum, Gold, Silver and
Bronze are tiers of one decision). `groupOffers` folds normalized offers back
into families, tiers and rates, keyed by provider and family, so the screens do
not change shape. Pricing reads `dealer_cost` and the provider; nothing below
the adapter sees a provider's raw response.

---

## 3. Adapters (Part 2)

```ts
interface ProviderAdapter {
  requiredInputs(ctx): Promise<RatingInput[]>;
  rate(ctx): Promise<{ offers: NormalizedOffer[] } | { failure: string }>;
  // Connected, Through API only:
  submitContract?(...); contractDocuments?(...); voidContract?(...);
}
```

- **TecAssured** wraps the existing client. What it sends and receives does not
  change; it only maps the response to normalized offers, with `rate_key` being
  the provider's `rateUnique`.
- **Price Sheet** asks for make, model, year, New or Used, vehicle type,
  odometer, engine size, sale date and in-service date, but only those its
  Published sheet uses for eligibility. Rating filters the sheet's rows to the
  ones whose eligibility matches the deal. With no Published sheet the failure
  reads "No price sheet published for BRP."

---

## 4. Template matching (Part 3)

A template matches a deal when every condition it specifies matches: the store
is in its stores, the deal type is in its deal types, and so on. An empty list
matches anything. Makes match case-insensitively.

Among matching active templates:

1. The one with the most specified conditions wins (a template naming store,
   deal type and make beats one naming only make).
2. A tie goes to the higher priority.
3. A further tie goes to the most recently updated.

The seeded "All deals" template has no conditions and priority 0, so it matches
everything and loses to anything more specific. Its slots reproduce today's
menu: the same goal grouping and order, all eleven TecAssured products.

Slots:

- **Best Match** shows the first product in its list that the deal actually got
  an offer for.
- **Side by Side** shows every product in its list that got an offer, together.
- A slot with no offers is hidden from the customer and listed for staff on
  Verify.

Open questions are recorded in section 8.

---

## 5. Rating (Part 4)

1. Match the template for the deal.
2. Collect the providers its slots need.
3. Rate each through its adapter, in parallel.
4. Write one `rated_offers` row per provider. A provider that fails gets a
   Failed row and does not stop the others; its slots fall back or hide.

Verify asks for the union of the required inputs of those providers (with the
Gasoline default and the automatic VIN decode as today), shows the matched
template's name, and gives the rating per provider in plain English: "Riders
Advantage: Rated, 11 products. BRP: No price sheet published." Open
presentation appears when at least one provider rated and none is out of date.

Changing a rating input marks every provider's row out of date. The maximum
amount financed is not a rating input and does not.

---

## 6. Price sheet parsing (Part 5)

1. Staff upload a PDF, XLSX, XLS or CSV to a private Storage bucket.
2. `fni-price-sheet-parse` (operator sign-in only) sends it to the Anthropic
   Messages API with the `DOCURIDE_PS_ANTHROPIC_API_KEY` secret and the model in
   `DOCURIDE_PS_ANTHROPIC_MODEL` (default `claude-sonnet-5-5`). No other secret
   name is read. A missing key fails with a sentence naming it.
3. PDFs go as document blocks. Spreadsheets go as CSV text, one tab at a time.
   Large sheets are split by page or tab and merged.
4. A tool with a strict JSON schema matching `price_sheet_rates` makes the reply
   structured. Every row carries a source reference and a confidence; the model
   flags what it is unsure of instead of guessing.
5. Server checks then flag (never drop) rows with a missing or non-positive
   cost, a term or deductible outside sane ranges, duplicates, or eligibility
   that matches no vehicle type.
6. The result is always a Draft. Publishing is a person's decision, refused
   while any row is flagged, and it retires the provider's previous Published
   sheet for overlapping dates.

Model, tokens and duration are recorded. The key is never logged or returned.

---

## 7. Migration plan

| Part | Migration | What changes for a live deal |
|---|---|---|
| 1 | 0021 providers | Nothing. Every row is backfilled to Riders Advantage. |
| 2 | none | Nothing. TecAssured offers pass through the adapter unchanged. |
| 3 | 0022 menu templates | Nothing. "All deals" reproduces today's menu. |
| 4 | none, or a small one | Rating writes one row per provider; only Riders Advantage has offers. |
| 5 | 0023 price sheets | Nothing until a sheet is published and a template uses its products. |
| 6 | none | Admin pages only. |
| 7 | 0024 OEM contracts | Planner renders slots; TecAssured contracts as today. |

Each migration is applied immediately before the push that deploys the
functions that need it, because the old functions read the old columns. Live
traffic is one test session today, so the window is acceptable.

---

## 8. Decisions to review

- **Catalog uniqueness** keeps the store column, so a store can still carry its
  own copy of a product (Parkersburg has five demo rows like this).
- **The five Parkersburg demo catalog rows** (VSC, TW, KEY, GAP, PPM) are not
  TecAssured products. They are backfilled to Riders Advantage like everything
  else and given the nearest category (KEY and GAP as Other).
- **Deploys** depend on the workflow's `SUPABASE_ACCESS_TOKEN`, which Supabase
  is currently rejecting. See the report for Part 1.
