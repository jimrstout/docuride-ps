# DocuRide PS: many F&I providers

Status: kept current as the parts land. Parts 1 (providers), 2 (adapters), 3
(menu templates), 4 (rating across providers), 5 (price sheets) and 6 (admin
sections) are live.

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

Built in Part 3 as migration 0023. Conditions are stored in the words people
read: deal types "Loan" and "Cash" (sessions.finance_type), conditions "New"
and "Used", makes as written. A slot's products are catalog ids of the
tenant's own rows, not a store's copy, so a store override of a product's
wording never drops it from a menu.

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
See section 10.

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
  provider_markup: number;     // TecAssured's markup inside its maximum; 0 otherwise
  options: SurchargeOption[];
  eligibility_notes: string[];
  rate_key: string;            // what contracts this exact offer
  source: { product, rate };   // the provider's own objects, for the record only
}
```

Built in Part 2 as `_shared/normalized-offer.ts`. Two fields were added to the
planned shape: `provider_markup`, because TecAssured's maximum is cost plus its
markup and the planner already shows both, and `source`, because a selection
records the provider's rate object verbatim as its rate snapshot. Pricing and
the screens read neither.

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

Built in Part 2 under `_shared/adapters/`: `types.ts` (the interface, with
inputs named the way Verify names them: "make", "new.used", "engine.ccs"),
`tecassured.ts` and `tecassured-offers.ts`, and `price-sheet.ts`.
`normalizeOffer` is now `groupOffers(tecAssuredOffers(quote))`, and a test holds
its output on a recorded quote to the byte against the code before Part 2.
fni-rate-vehicle moves onto the adapters in Part 4, when rating runs per
provider.

- **TecAssured** wraps the existing client. What it sends and receives does not
  change; it only maps the response to normalized offers, with `rate_key` being
  the provider's `rateUnique`.
- **Price Sheet** asks for make, model, year, New or Used, vehicle type,
  odometer, engine size, sale date and in-service date, but only those its
  Published sheet uses for eligibility. Rating filters the sheet's rows to the
  ones whose eligibility matches the deal. With no Published sheet the failure
  reads "No price sheet published for BRP." and is recorded as Failed, because
  it is a setup gap staff can close, not a statement that nothing is offered.
  Rows that match nothing are Not Offered. Eligibility checks make, model
  contains, model years, vehicle type, New or Used, model years old at the sale
  date, odometer, engine size, and months in service. A field a row tests that
  the deal does not carry fails that row.

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

Today's family screen, with its tier buttons (Bronze, Silver, Gold, Platinum),
is a Side by Side slot. So "All deals" seeds five Side by Side slots, one per
TecAssured family, in the catalog's display order: Maintenance, Mechanical
Protection, Tire and Wheel, Theft, Battery. Best Match is for templates that
prefer one provider's product and fall back to another's.

An offered product that no slot of the matched template names is not shown:
the template decides the menu. "All deals" names all eleven, so nothing changes.

The rules live in `_shared/menu-templates.ts` (pure, tested) and the reads in
`_shared/menu-template-rows.ts`. Rating starts recording the matched template
in Part 4; the planner starts rendering slots in Part 7.

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

Built in Part 4 as `_shared/rate-session.ts`, called by fni-rate-vehicle, with
migration 0024 adding `sessions.rated_provider_ids`:

- The session records the matched template (`menu_template_id`) and the
  providers this rating covered (`rated_provider_ids`). The menu, the save and
  Verify read only those providers' rows, so a provider an earlier rating needed
  (before the deal's make was corrected, say) can neither add products nor hold
  the menu back as out of date. Its row stays as a record.
- With no template at all, the TecAssured provider alone is rated, as before.
- A TecAssured row keeps the provider's quote, read back the way it always was.
  Any other provider's row keeps its normalized offers: a snapshot of the sheet
  as rated, so a sheet republished later cannot change a price already shown.
- The one-line status reads Rated when any provider rated, Not Offered only when
  every provider said so (the only state a customer is told "not offered"
  for), and Failed otherwise. One provider out of date holds back the whole
  menu, as one quote did before.
- fni-rate-vehicle answers callers as before: `product_count` on success, an
  error naming each provider's outcome otherwise. The login and Dealer ID are
  copied to the session only when TecAssured answered.
- Contracts still go to TecAssured only; Recorded by Staff contracts are Part 7.

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

Built in Part 5 as migration 0025 and two functions:

- `fni-price-sheets` (admin): list, open, upload, correct a rate, leave a rate
  out, publish, retire. `fni-price-sheet-parse` reads one sheet with Claude.
  Both take the shared secret; only the admin area's server calls them, after
  its operator sign-in, and every write names the operator.
- The parse answers at once (Parsing) and reads in the background, because a
  long sheet takes longer than a request should wait. The page shows Parsed or
  Parse Failed with notes when it is done.
- Structured outputs (`output_config.format` with the schema in
  `_shared/price-sheet-extract.ts`) constrain the answer, not a forced tool:
  Sonnet 5.5 refuses forced tool use. When the model is one that accepts it,
  the request asks for the server-side refusal fallback (`fallbacks: "default"`).
  A refusal or an answer too long for one reading is said in plain English; a
  CSV piece too dense is halved and read again.
- Nothing is deleted. A misread rate is **left out** with a reason: kept as the
  record, never offered, and not counted against publishing. A sheet is read
  once; to read it again, upload it again. A replaced sheet is Retired.
- A rate that names no make takes the provider's makes. The checks still flag a
  rate that would be offered on every brand.
- The sheet in force for a deal is the Published one whose dates cover the sale
  date (today when the deal has none).

---

## 7. Migration plan

| Part | Migration | What changes for a live deal |
|---|---|---|
| 1 | 0021 providers | Nothing. Every row is backfilled to Riders Advantage. |
| 2 | none | Nothing. TecAssured offers pass through the adapter unchanged. |
| 3 | 0023 menu templates | Nothing. "All deals" reproduces today's menu. |
| 4 | none, or a small one | Rating writes one row per provider; only Riders Advantage has offers. |
| 5 | 0024 price sheets | Nothing until a sheet is published and a template uses its products. |
| 6 | none | Admin pages only. |
| 7 | 0025 OEM contracts | Planner renders slots; TecAssured contracts as today. |

0022 went to the public.deals.raw allow list, which shipped between Parts 1
and 2, so the later numbers moved up by one.

Each migration is applied immediately before the push that deploys the
functions that need it, because the old functions read the old columns. Live
traffic is one test session today, so the window is acceptable.

---

## 8. Decisions

Reviewed and accepted with Part 1:

- **Catalog uniqueness** keeps the store column, so a store can still carry its
  own copy of a product (Parkersburg has five demo rows like this). For the
  tenant's own rows it is (tenant, provider, product code), as planned.
- **The five Parkersburg demo catalog rows** (VSC, TW, KEY, GAP, PPM) are not
  TecAssured products. They are backfilled to Riders Advantage like everything
  else and given the nearest category (KEY and GAP as Other).
- **Polaris ORV matches every "Polaris" make.** Narrowing it to ATV and UTV is
  the job of menu templates (Part 3) and price sheet eligibility (Part 5), not
  of the provider.
- **Migrations and deploys go out back to back.** The old functions read the
  old columns, so each migration is applied immediately before the deploy of
  the functions that need it, and the short window between them is accepted.

### Closed items

- **A store account's login is checked against its provider again,** restored in Part 6 by migration 0026 before
  any screen edits store accounts. A trigger on fni.store_provider_accounts
  refuses a Connected provider's account without a login and a Dealer ID, or
  with a login for another adapter, and a Price Sheet provider's account with a
  login. The migration checked the existing rows first; all four passed.

## 9. Admin sections (Part 6)

Three sections join the admin area, in the house style and the shared layout:

- **Providers**: every provider, how it is rated, its makes, the stores that
  sell it and its price sheets. A provider added here is a Price Sheet provider
  whose contracts are recorded by staff; one rated through an API needs code. A
  Price Sheet provider's stores are ticked here. A Connected provider's store
  accounts carry a login and a Dealer ID and are shown, not edited. Nothing is
  deleted: a provider is switched off.
- **Menus**: every template, what it matches in plain English ("New, Can-Am,
  at Parkersburg"), its priority and its slots. A slot's products are numbered in
  the order they are preferred. Slots move up and down. A slot with no products
  is not shown; a menu is switched off rather than removed.
- **Price sheets**: per provider, the sheets with their status and reading;
  upload a sheet; open one to review it rate by rate (what it fits, term, money,
  where it was read from, how sure, flagged or ready), correct a rate, leave one
  out with a reason, publish, or retire. The file goes from the browser straight
  into the private bucket through a one-time signed URL, because a sheet can be
  bigger than the admin area's server takes in one request.

Every write goes through fni-admin-settings (Providers, Menus) or
fni-price-sheets (Price sheets) with the operator's email.

## 10. Planner and contracts (Part 7)

**The menu is the template's slots.** Rating records the template a deal
matched. fni-session-get resolves its slots against what was offered and turns
each shown slot into one decision, in the slot's order:

- A slot whose tiers all come from one family is that family, cut to those
  tiers. "All deals" (one family per slot) gives back exactly the families the
  planner always showed, which a test holds.
- A Side by Side slot that gathers tiers from more than one family or provider
  becomes one decision of its own (family code `slot-<position>`), its tiers
  cheapest first, each tier naming its provider. Prices, the provider's maximum,
  copy and the saved selection all follow the tier's provider.
- A slot nothing was offered for is not shown to the customer. Verify lists it
  under Menu with the reason ("Theft: none of its 2 products got an offer for
  this deal, so it is not shown.").

**Product copy is found by provider and code.** Two providers may share a
product code, so the catalog is indexed by both. A row with no provider keeps
its old key.

**OEM products join the catalog when their sheet is published.** Publishing
adds a catalog row for each product the sheet offers that the provider does not
have yet: name, category and a starting goal, and no customer wording. Without
wording the product is not presentable, so the planner withholds it and says so
in its coverage log. Staff write the wording under Providers, Product wording.
Nothing writes it for them.

**OEM contracts are recorded by staff** (migration 0027, fni-oem-contracts).
Verify lists the customer's OEM selections under OEM contracts. Staff write the
contract on the OEM's own system, then type its number and upload the signed
contract (PDF, JPG or PNG), which the browser puts straight into the private
oem-contracts bucket. The record is an fni.agreement_products row with status
Live and recorded_by set, shown as "Recorded", so the one-live-contract rule
holds. Voiding a record needs a reason and changes the row only.

**Nothing about an OEM contract reaches TecAssured.**

- fni-contract-submit holds back any selection from a Recorded by Staff
  provider before it takes the lock, and reports it as `recorded_by_staff`. If
  that leaves nothing, it refuses and sends nothing.
- Its duplicate check reads only this provider's API contracts, so a recorded
  OEM contract with the same product code never blocks a Riders Advantage one.
- fni-contract-void refuses a recorded contract before it opens a TecAssured
  client, and points to OEM contracts on Verify.

### Part 7 decisions

- **A new OEM product's goal** starts from its category, as the Riders
  Advantage catalog pairs them: Mechanical Protection and Maintenance are Keep
  ownership manageable, Theft is Keep the asset valuable, everything else Keep
  ownership enjoyable. Staff change it with the wording.
- **Catalog rows from a sheet are only ever added.** A product already in the
  catalog keeps its name and wording; a failure to add is said on publish and
  publishing again adds what is missing.
- **A recorded contract opens the deal's agreement as a Draft** if there is
  none, and never changes an existing agreement's status, which belongs to the
  API submit's paperwork.
- **Recording and voiding need an admin sign-in,** like Void for TecAssured
  contracts: they are paperwork, not a customer decision.
- **The signed contract is required** to record. A ten-minute link to it is
  shown on Verify.

## 11. Test contracts on the QA server

TecAssured confirmed that contracts on its QA server (ratessys-qa.com) are
test documents and that any of them can be voided. While DocuRide is being
tested, fni-contract-submit, fni-contract-documents and fni-contract-void
refuse, in plain English and before anything is sent, unless:

- the store's TecAssured login points at ratessys-qa.com, and
- the deal is 13759, or its session is marked is_test, and
- the deal is not 14957 (session 5f8be61f), which is never sent.

The rule lives in one place, `_shared/contract-guard.ts`. The deal 13759
session is marked is_test.

### Go-live items

- **Lift the QA-only contract rule.** Before any real contract, a person
  decides to allow the production server, and `_shared/contract-guard.ts`
  changes with that decision. Nothing else turns it off.

## 12. Contract documents in the Deal Jacket

fni-contract-documents pulls each live contract's document from the provider
and saves it to the deal's WorkDrive Deal Jacket, alongside DocuRide DC's own
documents.

**Name.** `_shared/document-names.ts`, the one place it is built:

    {prefix}{nn} MUI #{deal number} {buyer display name} {product name} {contract number}|SignedDocuRideDC|{signed documents folder id}|.pdf

- The prefix is the provider's (Admin > Providers; Riders Advantage is TA).
  A provider with no prefix cannot send documents to WorkDrive, and the
  function says so.
- {nn} is the contract's place on the deal, given at submit in submit order
  and never changed (agreement_products.document_position).
- Buyer display name and the Signed Documents folder id come from dc.deals
  (by Zoho id, then deal number). The character cleanup is DC's own:
  \ / : * ? " < > become "-", double spaces collapse, pipes stay. ".pdf" is
  added as WorkDrive shows DC's stored documents.

**Folders.** Only DocuRide DC makes a deal's folders (V2 Generate Documents).
A deal not in dc.deals, or with no Deal Jacket or Signed Documents folder,
stops with "Missing Folder" and nothing is saved.

**Replace, don't duplicate.** A file in the Deal Jacket with the same name is
moved to the WorkDrive trash first, as DC replaces its own, then the PDF is
uploaded.

**What is kept** on fni.agreement_products (migration 0029): the WorkDrive
file id, name and when it was saved; the provider's signature data exactly
as returned (provider_signatures); everything else it returned except the PDF
(provider_document); the page count and each page's size in points.

**Access.** WorkDrive is reached with DocuRide DC's Zoho client
(ZOHO_DC_*, scope WorkDrive.files.ALL), sharing DC's one token row and its
refresh lock (`_shared/dc-zoho.ts`, a copy of DC's to keep in step). No token
or secret value is read, logged or returned. A refusal for a missing
permission names the scope.

**Void** cancels the contract with TecAssured, records who, when and why, and
renames the file by adding " VOID" before the first pipe. The file is never
deleted.

**Staff contracts panel on Verify.** Shown once the customer has finished the
planner (session Products Selected or later) and chose something from a
provider contracted through its API:

- The chosen products, and "Submit contracts to Riders Advantage". It sends
  the planner's saved choices (`use_saved_selections`), through the same OEM
  split, submit lock and QA rule as any submit. While a submit runs, or the
  deal is at Submit Status Unknown, the button is replaced by a sentence.
- Per contract: number, status, "Get document" (saves to the Deal Jacket),
  a link to the saved file, and "Void" with a reason and a tick to confirm.
- Every button is disabled while it works and says what it is doing.
- Signed in only, like Void always was.

### Part 12 decisions

- **WorkDrive through DC's Zoho client.** PS's own Zoho client is CRM only.
  DC's already has WorkDrive.files.ALL for the same Deal Jackets, so PS uses
  it and shares DC's token row and refresh lock, rather than a second grant.
- **Replacing a file moves the old one to the WorkDrive trash,** exactly as
  DC replaces its own documents; nothing is deleted outright.
- **Contracts submitted before places existed** get the next place, in the
  order they were recorded, the first time their document is fetched.
- **The checks come first.** Prefix and folders are checked before
  TecAssured is asked, so a refusal saves nothing and asks for nothing.
- **What TecAssured returned is kept whole**: signatures as returned, and
  every other field except the PDF.
- **The planner's saved choices are what Submit sends.** Staff do not
  re-pick products on Verify.
