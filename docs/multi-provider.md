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
record the contract number and upload the contract PDF on Details; the agreement
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
inputs named the way Details names them: "make", "new.used", "engine.ccs"),
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
  Details.

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

Details asks for the union of the required inputs of those providers (with the
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
  Details read only those providers' rows, so a provider an earlier rating needed
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
- A slot nothing was offered for is not shown to the customer. Details lists it
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
Details lists the customer's OEM selections under OEM contracts. Staff write the
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
  client, and points to OEM contracts on Details.

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
  shown on Details.

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

**What a test contract is submitted at.** A test session on the QA server
submits each product at the most QA dealer 3-306 allows (dealer cost +
provider markup + options), automatically, and the cap check stays as a
guard. The customer's chosen price is kept on their selections; only the
contract carries the maximum. Everywhere else no cap is assumed (see Go-live
items).

**Reading a submit's answer, product by product** (`_shared/submit-outcome.ts`).
TecAssured can report a submit as failed while StoneEagle has created some of
the contracts. On deal 13437 Tire and Wheel was refused, Battery and Theft
were created, the answer carried a top-level error, nothing was recorded, and
a resubmit was refused as a duplicate. Now each product is one of:

| Outcome | What the answer showed | What happens |
|---|---|---|
| Created | an entry with a contract number and no error of its own | recorded as a Live contract, whatever the top-level answer |
| Refused | an entry with its own error, or a top-level error with no entries at all | not recorded; the reason in plain English |
| Not known | the answer does not mention it | the session goes to Submit Status Unknown |

A clear no for every product hands the lock back, as before. A contract
number that matches nothing we sent is named, and also parks the session at
Submit Status Unknown (the whole answer is kept on the agreement). Details
shows the result one product per line, for example: "TecAssured created 2 of
3 contracts. Tire and Wheel: not created. TecAssured would not accept Tire
and Wheel: it has no rate for this product that matches the vehicle ...
Battery Plus: created, contract ... Theft, Plan A: created, contract ..."

**Where is_test comes from.** A session starts as a test session when its
DocuRide record has "Test Record Only" ticked (API name `Test_Record_Only`).
Reopening a session (Start the planner again) marks it is_test if the box has
been ticked since, and nothing ever clears is_test: a session that has sent
test contracts never turns back into a real deal.

### Go-live items

- **Lift the QA-only contract rule.** Before any real contract, a person
  decides to allow the production server, and `_shared/contract-guard.ts`
  changes with that decision. Nothing else turns it off.
- **Confirm how each production dealer's price cap works.** On QA dealer
  3-306 TecAssured caps a contract at dealer cost + provider markup +
  options, and the submit used to assume every dealer worked that way. It no
  longer does (`_shared/price-cap.ts`): outside a test session on the QA
  server the customer's price is sent and TecAssured's answer decides, its
  refusal shown in plain English ("TecAssured would not accept Theft, Plan A:
  its price, $1,450.00, is above the most TecAssured allows this dealer to
  sell it for, $1,094.00 ..."). Before go-live, ask TecAssured whether
  production dealers have a cap, what it is, and whether the rate response
  carries it, so the planner can stop a price the provider will refuse before
  the customer agrees to it.

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

**Staff contracts panel on Details.** Shown once the customer has finished the
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
  re-pick products on Details.

## 13. Holding documents until the Deal Jacket exists

A provider's contract PDF often exists before DocuRide DC has made the deal's
WorkDrive folders, which only happens when the full sale documents are
generated. So fni-contract-documents holds every PDF in a private Supabase
bucket, **fni-contracts** (migration 0030; never public), at
`{session id}/{file name}`, and:

- if dc.deals already has the deal's Deal Jacket and Signed Documents
  folder, also saves it to the Deal Jacket straight away, as before;
- if not, it no longer stops with "Missing Folder". The document is
  "Waiting for Deal Jacket" until it is moved.

**Names.** The stored name is the file name without its routing part,
"TA01 MUI #13759 {buyer} {product} {contract}" (agreement_products.
document_name). The full name, with "|SignedDocuRideDC|{signed documents
folder id}|.pdf", is built when the file moves, from the same
`_shared/document-names.ts`. Supabase Storage keys do not take "#", "|" or
accented letters, so in the bucket those become "-"; the WorkDrive name keeps
them. The buyer's name is DocuRide DC's, or the session's while the deal is
not in DC yet.

**Statuses** (agreement_products.document_status): "Waiting for Deal
Jacket", "Saved to Deal Jacket", "Voided". The bucket copy is kept after a
move. Nothing is deleted.

**Moving** (`_shared/deal-jacket-move.ts`, shared by Get document and
fni-documents-to-deal-jacket): build the full name, move any same-named file
in the Deal Jacket to the WorkDrive trash, upload the PDF from the bucket,
record the WorkDrive file id, name and time. A document already in the Deal
Jacket is skipped, so a move is safe to repeat. A voided document moves with
" VOID" before the first pipe.

### The call for the CRM: fni-documents-to-deal-jacket

For the Deluge function that runs **right after DocuRide DC has created the
deal's WorkDrive folders** (V2 Generate Documents). It moves every document PS
holds for the deal into the Deal Jacket. Safe to call any number of times:
documents already in the Deal Jacket are skipped. It calls no provider and
deletes nothing.

    POST https://fovccigwlcmmzfubpfny.supabase.co/functions/v1/fni-documents-to-deal-jacket
    Header:  x-webhook-secret: <FNI_WEBHOOK_SECRET>   (the same secret as the other CRM calls)
    Header:  Content-Type: application/json

    {
      "record_id": "4742556000231058020",
      "deal_jacket_folder_id": "<optional>",
      "signed_documents_folder_id": "<optional>"
    }

- `record_id` is the Zoho DocuRide record id. `deal_number` ("13759") may be
  sent instead.
- The folder ids are optional. Any sent win over the ones in dc.deals, so the
  call can go out the moment the folders exist, before dc.deals is updated.
- No folders in either: 409, "Missing Folder", and nothing is changed.
- No DocuRide session for the deal: 404, nothing changed.

Example answer (200):

    {
      "deal_number": "13759",
      "folders_from": "DocuRide DC",
      "moved_count": 2,
      "message": "2 of 3 documents were moved to the Deal Jacket.",
      "files": [
        { "contract_number": "RA123456",
          "file_name": "TA01 MUI #13759 Chad Baber Mechanical Protection RA123456|SignedDocuRideDC|<signed folder id>|.pdf",
          "outcome": "Saved to Deal Jacket." },
        { "contract_number": "RA123457",
          "file_name": "TA02 MUI #13759 Chad Baber Theft Protection, Plan A RA123457 VOID|SignedDocuRideDC|<signed folder id>|.pdf",
          "outcome": "Saved to Deal Jacket, marked VOID." },
        { "contract_number": "RA123458",
          "file_name": "TA03 MUI #13759 Chad Baber Tire and Wheel Protection RA123458|SignedDocuRideDC|<signed folder id>|.pdf",
          "outcome": "Already in the Deal Jacket. Nothing changed." }
      ]
    }

`folders_from` is "This call", "DocuRide DC", or "This call and DocuRide DC".
Each `outcome` is a sentence; anything other than "Saved to Deal Jacket..." or
"Already in the Deal Jacket..." means that file did not move and says why.

**On Details,** each contract on the Contracts panel says where its document
is, in plain English:

- "Waiting for Deal Jacket", with "View PDF": a ten-minute signed link to
  the held copy (the bucket is private; the page never sees the storage path).
- "Saved to Deal Jacket", with the WorkDrive link.
- Voided contracts stay listed, marked Voided.

While any held document is not in the Deal Jacket, staff see "Move documents
to Deal Jacket" (pending label "Moving documents..."). It makes the same call
the CRM will, so the move can be tried by hand before the Deluge trigger
exists.

**Voiding a waiting document** cancels it with TecAssured as before, marks it
Voided, and adds " VOID" to its stored name, so if it ever moves to the Deal
Jacket it lands with " VOID" before the first pipe. The bucket copy is left as
it is.

### Section 13 decisions

- **Storage names** use "-" for characters Supabase Storage keys refuse
  ("#", "|", accented letters). The WorkDrive name is unchanged.
- **Get document again** replaces the same contract's own copy in the bucket
  and, if it was already in the Deal Jacket, replaces that file too.
- **Finalized** now means every live contract's document is held, whether or
  not it has reached the Deal Jacket yet.
- **The buyer's name** comes from DocuRide DC when the deal is there, and
  from the session otherwise, so a document can be held before DC has the deal.
- **The Details page's button sends the session id**; the CRM sends the record id or
  deal number. Both reach the same move.
- **Filed when the CRM makes the folders** (2026-10-29). zoho-sync keeps the
  deal's three folder IDs on its session (`fni.record_deal_folders`,
  migration 0041). When the Deal Jacket and Signed Documents folders both
  became known with that write, it files the session's waiting documents
  after it has answered (`_shared/deal-jacket-file.ts`, the same filing the
  endpoint runs). Filed: the session event "Contracts filed to Deal Jacket
  when CRM created the deal's folders" with the count. Not filed: "Contract
  not filed to Deal Jacket" per contract, with the reason. Nothing waiting:
  no event. A filing problem never fails the sync; the Details button files
  again. Folders come from the call, then the session, then dc.deals.
- **One filing per contract at a time.** Each contract is claimed before it
  is filed (`agreement_products.filing_started_at`), so the sync, the
  endpoint and Get document never file the same one at once; a claim older
  than five minutes is taken to be abandoned. The row records the Deal
  Jacket folder it was filed into.
- **Get document files at once** (2026-10-29) when the deal's folders are
  known: the session's first (from the CRM, via zoho-sync), then dc.deals,
  id by id. Before, it read dc.deals only, so a deal whose folders the CRM
  had sent but DC did not have yet waited for the next move.

## 14. Vehicle type on Details

TecAssured offers each Riders Advantage product in vehicle-specific versions
(On-Road, Off-Road MC, UTV/ATV) and enforces the match when the contract goes
in, not when it is quoted. Deal 13437, a 2010 Kawasaki Vulcan 900 street bike,
was shown the Off-Road Tire and Wheel and TecAssured refused the contract
("no rate found matching criteria"). So the vehicle type is a choice on
Details, first in the Vehicle panel, stored exactly as shown
(sessions.vehicle_type, migration 0031):

    ATV, UTV, On-Road Motorcycle, Off-Road Motorcycle, Scooter, Personal Watercraft, Snowmobile, Other

**Picked automatically** by one rule, `pickVehicleType` in
`_shared/vehicle-types.ts`: the CRM body type (Sold_1_Body_Type) first, then
the VIN decode's vtype. MCYC (a street or three-wheel body type, or MCYC from
the decode) is On-Road Motorcycle unless the model clearly marks an off-road
bike (KX, CRF, YZ, RM-Z, KLX, TC, SX, EXC, FC and their kin). One plain line
under the choice says where it came from ("Picked from the CRM body type
Street Motorcycle. Change it if that is wrong."); once staff change it, it
reads "Entered by Staff" with who and when.

**Changing it** saves at once, re-matches the menu template, marks the
deal's quotes out of date and needs Confirm and Continue again. Any saved
change to a rating input now does the same (it used to happen only on
Refresh).

**What TecAssured is sent** is the code the choice stands for
(sessions.vehicle_type_code, derived), exactly TecAssured's own vehicle types
(API guide 6.3): ATV, UTV, MCYC (On-Road Motorcycle), BIKE (Off-Road
Motorcycle), SCO (Scooter), PWAC (Personal Watercraft), SNOW (Snowmobile).
UTV and motorcycles send exactly what they did. Other sends nothing and is not
rated. Scooter joins the database check in migration 0032, which replaces the
constraint and so is applied by hand.

**Existing sessions** were converted from their stored code (UTV to UTV,
MCYC to On-Road Motorcycle ...), and each says so in its source line.
Verification snapshots taken before the change are read in the new terms, so
the change of field alone un-verifies nobody.

Menu templates match on the choice ("On-Road Motorcycle"); price sheet rates
still match on the code.

**A menu per vehicle type** (migration 0033). "All deals" stays the fallback.

| Template | Vehicle types | Slots (all Side by Side, All deals order) |
|---|---|---|
| ATV and UTV | ATV, UTV | Maintenance 66_7, 78_7, 72_7, 84_7; Mechanical Protection 16_3, 86_3, Premium 2060_141, Premium Service Drive 2064_141; Tire and Wheel 23_4; Theft; Battery |
| On-Road Motorcycle | On-Road Motorcycle | Maintenance 62_7, 77_7, 71_7, 83_7; Mechanical Protection 14_3, 88_3, 2058_141, 2066_141; Tire and Wheel 22_4; Theft; Battery |
| Off-Road Motorcycle | Off-Road Motorcycle | Maintenance 1619_7, 1616_7, 1618_7, 1617_7; Tire and Wheel 23_4; Theft; Battery. No Care: TecAssured offered none on our test deals. |

A test holds that the On-Road and Off-Road menus never share a
vehicle-specific product. Products with no customer wording stay hidden until
staff write it.

**Telling twins apart** (migration 0034). Our one product name covers several
TecAssured versions, so wherever staff see products (Admin > Menus, both the
product list and each slot; Admin > Product wording; the pricing scopes; and
the Details Contracts panel) a small grey label shows TecAssured's own program
name next to ours, for example "USED BRONZE ON-ROAD NON-EU". It is the rated
offer's product label up to " - ", kept on `product_catalog.provider_program_name`:
filled from the offers already held, and refreshed by every successful
TecAssured rating. Two products can share a program name (14_3 and 2058_141
are both "USED ON-ROAD CARE"), so the code stays beside it. Customers never
see it: the planner payload does not carry it, and a test holds that.

## 15. A failed re-rate keeps the last good offers

A rating attempt used to overwrite the provider's `rated_offers` row whatever
came back, so a timeout on a re-rate threw away a quote the customer may have
already chosen from, and the deal could no longer be submitted. Now
(`_shared/rerate.ts`, migration 0035):

- **Only an answer replaces offers.** Rated or Not Offered from the provider
  overwrites the row as before. A Failed attempt over a Rated row keeps it and
  writes the reason beside it (`last_failure_detail`, `last_failure_at`). The
  next answer clears it.
- **Still current?** When the failed attempt got as far as building its
  request, it is compared with the request behind the kept offers, ignoring
  rateDate. The same deal means the offers are current: Confirm and Continue
  marks every row out of date and then re-rates, so a timeout there leaves the
  deal submittable. A different deal means they are out of date. A failure
  before any request was built keeps the mark the row had.
- **Status and choices stand.** fni-rate-vehicle answers 200 with the kept
  count and a `warning`, and leaves the session status alone.
- **Staff are told.** Details says "Verified. Riders Advantage could not rate
  again (...). The last good offers are kept, so the deal can still go ahead
  on them." The provider line on Details and in Admin > Sessions adds "The
  last re-rate failed (...), so these are the earlier offers, kept." The
  customer sees the offers, never the warning.

**A re-rate after the customer has chosen** (fix 4d). A successful rating
used to set the session to Rated whatever it was, so re-rating a Products
Selected deal sent it back a step and Details stopped offering Submit. Now
(`statusAfterRating` in `_shared/rerate.ts`) the session keeps its status
while every product the customer took (Included in selected_products) is
still offered by the same provider at the same rate id. TecAssured's rate ids
are stable across quotes. A choice that is gone, or offered only at another
rate, sends the session back to Rated, as before.

## 16. The co-buyer and phone field probe (finished, removed)

TecAssured's Shop API documents only `buyerFirstName`, `buyerLastName` and
`buyerAddress`, yet iTap prints co-buyers on contracts through the same back
end. A temporary probe, on test sessions on the QA server only, sent guessed
field names in one submit, each carrying its own made-up marker, and the
contract showed which one printed.

- **Round 1, the co-buyer** (probe added 26 Oct 2026, read before round 2 on
  28 Oct 2026). Deal 15029, contract VLBT3440876-42153. Of 44 guessed keys
  only CB03 printed: `cobuyerFirstName` and `cobuyerLastName` on the quote
  fill the Riders Advantage contract's second contract holder line.
- **Round 2, the buyer's phone** (28 Oct 2026). Deal 15029, contract
  VLBT3440876-42274. CB03 printed on the second contract holder line again,
  and the buyer telephone printed as (304) 555-0104: probe key P04,
  `buyerHomePhone` on the quote, sent digits only.

The probe, its request flags, the Details checkbox and batch picker, and the
redaction exception for its made-up values were deleted on 28 Oct 2026. The
submit now sends the real values under those keys (section 21).

## 17. Dates are always sent and never invented

Deal 15029 (test session, 2026 Indian Pursuit, New, MCYC) was refused with
"The value '' cannot be parsed as the type 'DateTime'". Its request matched
13437's (Used MCYC, rated fine) except New against Used. Both left out
`inservice.date`, because the properties array followed TecAssured's required
properties per vehicle type and MCYC does not list it. Separately, the rate
request filled a missing sale date with today. That is the likely cause of a
maintenance contract showing today instead of the sale date.

The rule, in `_shared/deal-dates.ts`, used by the rate request, the
TecAssured adapter, the price-sheet path, the Details sheet and the submit:

| Date | Where it comes from | When it is missing |
|---|---|---|
| Sale date | the session (the CRM's Sale_Date, or a staff entry on Details) | No rate and no submit: "Sale date is missing. Add it on the deal and refresh from CRM, or enter it on Verify." (the Edge Function wording, unchanged in the navigation work) |
| In-service date | the session's own; for a New unit, the sale date | Used unit: no rate and no submit, with a plain-English message asking for it |
| rateDate | today | Never missing. It says when we asked, not anything about the deal. |

- **Every rate request carries all three deal dates:** `saleDate`,
  `inServiceDate` and `vehiclePurchaseDate` at the top level, and `sale.date`
  and `inservice.date` in the properties, whether or not TecAssured lists them
  for the vehicle type.
- **Details needs both dates for every vehicle type,** and says what is missing
  in the words above.
- **The CRM has no in-service date field.** So the CRM mappings now give a New
  unit its sale date and a Used unit none; staff enter it on Details. Existing
  sessions keep the value they have until their next Refresh or reopen.
- **The price-sheet path needs a sale date too,** since that date decides which
  sheet is in force. It never uses today instead.
- **Submit refuses on the same rule** before sending anything. It then makes
  the quote's echoed dates the session's own: `quote.saleDate` (kept in
  TecAssured's "Sep 6, 2026, 6:53:44 PM" format) and the `sale.date` /
  `inservice.date` values in each vehicle's `form.properties`. It changes
  values only, and adds nothing TecAssured did not send.

**What submit sent before this change.** The rated quote, as TecAssured
returned it:
- `quote.saleDate`: TecAssured's echo of the rate request's sale date, with
  the time of the rating attached.
- `sale.date` among each vehicle's `form.properties`, and `inservice.date`
  only where the vehicle type lists it.
- No vehicle purchase date and no in-service date of its own.

Each vehicle's `effectiveDate`, and each rate's `expireDate` (ten years on),
are TecAssured's own stamps of the moment of rating. They are left as they
are. If a contract still shows the rating day after this change, they are
the next place to look.

## 18. Navigation, and the Details page

- **The page is called Details.** It was called Verify. It holds the facts the
  menu runs on, the settings that shape it, and the record of contracts and
  documents afterward. Its address is `/details/<session id>`. The
  verification step inside it keeps its own words ("Verified", "Checked by",
  "Confirm and Continue"). The browser tab reads "Deal 15029 Details".
- **Old addresses still work.** `/verify/<session id>` redirects permanently
  (308, query string kept) to `/details/<session id>`, in
  `apps/ownership-planner/next.config.mjs`. The CRM button and old bookmarks
  use the old address, so the redirect must never be removed.
  `fni-session-start` still builds `verify_url` and `menu_url` as
  `/verify/<id>`, which lands on Details through the redirect.
- **A way home.** Every staff page's top bar starts with "DocuRide PS",
  linking to the main screen (`/`, the session browser): "DocuRide PS / Deal
  15029 / Details" on the deal page, and "DocuRide PS / Administration /
  Sessions" in the admin area. The customer's menu never shows it.
- **Menus open in a new tab.** Admin > Sessions "Open" and the Details page's
  "Open presentation" both use `target="_blank"` with `rel="noopener"`. The
  staff page stays where it was, so one person can work several deals at once.

- **No provider names written in** (2026-10-28). The button reads "Submit
  contracts". No label, button or message on Details, its components or the
  submit flow names a provider in its text. Where a name is needed (Void,
  Submit Status Unknown, the test session banner, submit results and
  refusals), it is the provider record's name (`fni.providers.name`), sent by
  fni-session-verify as `provider_name` and used by fni-contract-submit for
  its messages; without one the words say "the provider". Product names are
  the provider's own and are shown as they come. A test
  (`test/no-provider-branding.test.mjs`) sweeps those files.

## 19. Showing when the system is working

Rating, refreshing from the CRM, submitting and voiding take seconds, and the
staff pages used to look idle meanwhile. Now (`components/Working.tsx`, rules
in `lib/working.ts`):

- **The button that started it** shows a spinner and a plain working label
  ("Rating...", "Submitting contracts...", "Voiding..."), and is disabled
  (`components/PendingButton.tsx`).
- **Whole-deal actions cover the page.** A navy overlay shows the same
  message, and nothing underneath can be clicked or edited. These are:
  Confirm and Continue, Refresh from CRM, a vehicle type change, Decode the
  VIN, Discard my edits, Submit, Void (TecAssured and OEM), Move to Deal
  Jacket, clearing Submit Status Unknown, and in the admin area Rate, reading,
  publishing or retiring a price sheet, and copying pricing rules.
- **Smaller actions lock their own panel** with a spinner and the message:
  Get document, the sheet's Save changes, Checked by, +24h (that row's
  actions), OEM contract recording, a price sheet upload, and each admin
  editor's save.
- **One at a time.** While anything runs, no other form on the page can be
  sent: buttons are out of reach, and a send is stopped before it leaves.
- **After 10 seconds** the overlay or panel adds "Still working. This can take
  up to a minute." After two minutes it says it is taking longer than it
  should, and offers a reload. It never gives up silently.
- **During Submit and Void,** leaving or reloading the page asks first:
  "Contracts are still being submitted. Leaving now may leave them half done."
- **Screen readers:** busy areas carry `aria-busy`, and a live region
  announces the start and the result.
- **When it ends,** the page unlocks, and the result line (the page's own
  success or error notice) is also shown at the bottom of the screen. On an
  error, the person's entries are put back so nothing has to be retyped.
- **The customer's menu** holds its choices still while one saves (with a
  calm spinner and "One moment..." in the footer), and accepting the plan
  shows a calm "One moment..." pause and can only happen once.
- **View PDF** opens a ready-made link in a new tab, so nothing on the page
  waits for it, and it has no working state.

A form joins this by carrying one `<Working />` marker and a `PendingButton`
with `working="page"` or `"panel"` (the default) and its label. A test sweeps
every staff form for both.

**Double sends, checked on the server.** Disabling a button is not enough on
its own (a double click can land first, and a second tab has its own button):

- **Submit** was already safe. It takes its lock with a conditional UPDATE
  (`submit_state` from Idle to In Progress), so of two submits for one session
  exactly one goes on. The other is answered "Another submit for this session
  started first. Wait for it to finish, then reload to see the result."
- **Void** had no such guard: two Voids of one contract both read it as Live
  and both called TecAssured. It now claims the contract row first
  (`agreement_products.void_started_at`, migration 0037,
  `_shared/void-claim.ts`), so only one reaches TecAssured. The other is told
  "... is already being voided. Wait a moment, then reload the page to see the
  result. Nothing more was sent to TecAssured." The claim is cleared when the
  void ends, whatever the outcome; one older than three minutes counts as
  abandoned.

**The provider's answer is kept** (2026-10-28, `_shared/provider-answer.ts`).
A submit on deal 15029 at 17:29 UTC on 28 Oct ended in Submit Status Unknown,
and only the one-line summary was saved, so it could not be diagnosed. Now
`apiCallDetailed` (`_shared/tecassured.ts`) keeps the HTTP status and any
request ID header beside the parsed body, and a failure the provider answers
throws `ProviderHttpError` carrying the same; successful calls read exactly as
before. Every submit that reaches the provider and does not end in a clean
success (unknown, refused, partly refused, or a failure the provider answered)
keeps the status, request ID and body as the session event "Provider's answer
kept", once per submit. Before it is kept, any buyer, co-buyer or lienholder
name, address, email or phone is taken out, by key and by the session's own
values wherever they appear; credentials, tokens and session IDs are removed; the body is cut at
50,000 characters. Details shows the latest one behind Show details, with Copy
error, in the Submit Status Unknown notice or the Contracts panel. A rating the
provider answers with an HTTP failure keeps the same with the attempt
(`rated_offers.response_payload`); a refusal sent as HTTP 200 was already kept
whole.

## 20. Session dates: the store's day

A deal is sold on a day, in a store, so a planning session lasts until the end
of that store's day rather than for a fixed number of hours. Migration 0038.

| What | How |
|---|---|
| Store time zone | `public.stores.time_zone`, one of the US zones in `_shared/store-day.ts`. New York until set in Administration > Stores. `dc-dealer-sync` does not write it. |
| Session expiry | 23:59:59 on the store's today, or on the planned sale date when that is later. Set by a trigger on every new session (`fni.sessions_set_expiry`); existing sessions kept theirs. |
| Renew for Today | `fni.renew_session` sets that same moment again. Offered on Sessions when it would give the session longer, or when the sale date or a set planned sale date is before today at the store. It writes the expiry only when that is later, so it cannot stack. Replaced +24h, which added 24 hours a press (deal 13437 gained 48). |
| Planned sale date | `fni.sessions.planned_sale_date`, set on Details to prepare a deal the night before; the session stays open to the end of that day. It cannot be in the past and is never sent to a provider. |
| Submit | Only on the day of the sale at the store: the sale date must be today there, a planned sale date must equal it, and the in-service date cannot be after it. `fni-contract-submit` refuses before anything is sent; Details says why and disables Submit ahead of time. |

The day boundary is worked out in Postgres (`fni.store_day_end`), so a session
made by any path ends at the same moment; "today" for the submit check is
`storeToday` in `_shared/store-day.ts`, from the same zone.

**Renew for Today also moves past dates to today** (2026-10-28,
`_shared/sale-date.ts`). Before renewing, `fni-admin-sessions` compares the
session's sale date (the staff date where there is one) and planned sale date
with today at the store:

| Date | Before today | Today or later | Not set |
|---|---|---|---|
| Sale date | Moved to today, as a staff edit over the CRM's | Left alone | Left alone (still missing) |
| Planned sale date | Moved to today | Left alone, so a deal prepared for tomorrow keeps tomorrow | Left alone (stays empty) |

- The in-service date is never touched.
- **Offered whenever it would move a date** (2026-10-28). The button used to
  appear only when renewing would give the session longer, so a session
  already open to tonight with yesterday's sale date (deal 15029) could never
  have the date moved. It now also appears when the sale date (the staff date
  where there is one) or a set planned sale date is before today at the
  store (`renewOffered`). On such a session, pressing it moves the dates and
  writes their events, and leaves the open-until time as it is: the expiry is
  written only when the new one is later (`renewExtends`). There is no
  renewal event, so none is repeated.
- Each move is a session event: "Sale date moved from 27 Oct 2026 to 28 Oct
  2026 by JS". JS is the signed-in person's initials, as their admin avatar
  shows them; with nobody signed in it is "System". Never the Checked by name.
- Refresh from CRM writes the columns, never the edit, so the moved date
  stands. While the CRM holds a different date, Details shows "CRM now says
  ..." with Keep staff value and Use CRM value, as on the contract panels.
  Keeping records which CRM date was kept over, so it is not asked again until
  the CRM changes.
- The sale date is sent in the rate request. A move into another calendar
  month or year marks the rated offers out of date (kept, prices unchanged)
  and a verified deal goes back through Confirm and Continue. Submit refuses
  an out-of-date rating, or one rated on a sale date in another month, and
  Details disables Submit and says why.
- **Within the same month the rating stands** (2026-10-28, Jim's rule: rate
  cards change at month boundaries). A sale date moved within its month keeps
  the offers current and the deal verified; the move's session event is still
  written, with `rerate_needed: false`. Submit sends the stored quote with the
  deal's current dates (`alignContractDates`), as it did before PR 51. The same
  rule applies wherever a moved sale date used to mark the rating: Renew for
  Today, a sale date edited on Details or changed by Refresh from CRM or Use
  CRM value, and a relaunch from the CRM button (`saleDateMoveNeedsRerate`,
  `onlySameMonthSaleDateMove`, `_shared/sale-date.ts`).
  - The month is the date's own; the store's time zone decides it through
    "today", the day Renew moves a date to.
  - A Price Sheet provider's sheet can start or end on any day, so a move
    across a Published sheet's first day, or the day after its last, counts as
    a boundary too. If the sheets cannot be read, a re-rate is required.
    (Price sheet eligibility counts calendar months and model years, so a
    within-month move cannot change it.)
  - A New unit's in-service date follows its sale date and moves with it; any
    other rating input moving at the same time is handled as before.
  - A rating already out of date for another reason stays out of date. Nothing
    on these paths marks an offer current, and existing sessions are not
    changed: one already marked (deal 15029) stays so until it is re-rated.
  - **Existing sessions** were brought into line once, on 28 Oct 2026
    (migration 0039, `scripts/same-month-rating-check.mjs`, `ratedRequestDiff`).
    For each out-of-date offer the request the session would send now was
    rebuilt with the provider's own choices held at the stored request's,
    and compared. Only deal 15029 qualified (rated on 26 Oct, sale date now
    28 Oct, nothing else different); its offer was marked current, with the
    session event "Rating kept current: sale date moved within the same month
    (26 Oct 2026 to 28 Oct 2026)" by System. Verification was not touched.
    13437 was left out of date: its sale date had not moved. Deal 14957 was
    excluded.
  - A re-rate that fails still compares its whole request with the kept
    offers' request (`keptStillCurrent`, `_shared/rerate.ts`), so a sale date
    differing within the month there leaves the kept offers out of date. This
    is the safe direction and rarely reached, since a same-month move no
    longer sends a deal back to be rated.

## 21. Who goes on the contracts

Details shows the buyer, co-buyer and lienholder exactly as the service
contracts are sent with them, to a signed-in operator only (the page itself
needs only the session link, so names, addresses and phone numbers wait for a
sign-in). `_shared/contract-parties.ts` holds the rules.

| What | How |
|---|---|
| Fields | Every buyer, co-buyer and lienholder column on `fni.sessions`, in plain English. All editable. A business buyer (type Company) leads with the business name; no lienholder reads "Cash deal, no lienholder". |
| Edits | A staff edit in `staff_edits`, keyed on the column, with who, when and the value replaced, shown as "Entered by Staff: name, time. Was old value." Removing a co-buyer or lienholder is the edit `cobuyer` or `lienholder` = "Removed". |
| Refresh from CRM | Writes the columns, never the edits, so the staff value stands. If the CRM later says something new, both are shown ("CRM now says ...") with Keep staff value and Use CRM value. |
| Submit | Sends the staff value wherever one exists. If any contract detail was changed here, each change is listed in the Submit confirmation and Confirm Submit needs "I have made these changes in DX1, or they are not needed there."; fni-contract-submit refuses without it and records it as the session event "Contract detail changes confirmed for DX1". |
| Co-buyer on the contract | The quote carries `cobuyerFirstName` and `cobuyerLastName`, which print on the second contract holder line (section 16), from the contract parties, staff value over CRM value, only when there is a co-buyer; with none, or one removed on Details, neither key is sent. A Company co-buyer sends its business name (name as it prints) in `cobuyerLastName` and an empty `cobuyerFirstName`, as the Co-buyer panel leads with the business name; the buyer has no company rule of its own on the submit (`_shared/submit-parties.ts`). |
| Buyer phone on the contract | The quote carries `buyerHomePhone` (probe key P04, section 16), which prints as the buyer telephone, from the contract parties, staff value over CRM value, digits only: formatting is stripped and a leading 1 on an eleven-digit number is dropped. No phone, no key (`_shared/submit-parties.ts`). |
| Adding products after a contract | Accepted (2026-10-30). A product under a Live or Submit Status Unknown contract shows as Purchased on the Ownership Planner: included, at the price it was sold for, with no choices. fni-session-save never rewrites its row, whatever a browser sends, and still saves a Finalized session while it has a live contract; a finished save that includes a product with no contract puts the session back to Products Selected, so Submit (unchanged) takes it (`_shared/purchased.ts`). |
| Missing | Named beside the field ("Missing: buyer last name"). Not blocking yet. |
| Locked | While any contract on the deal is live (Live or Submit Status Unknown), the panels are read-only, edits are refused, and Discard keeps city, state and ZIP. Voiding every live contract unlocks them. |
| Reopened | When a void leaves the session with no live contract (none Live or Submit Status Unknown) and its own submit is idle, a session at Agreement Created or Finalized goes back to Products Selected, so Submit takes it again (`_shared/session-reopen.ts`, both voids). Only the status changes. The session event "Session reopened: all contracts voided" names the signed-in person's initials, or System. |
| Reopened, existing | Sessions voided before that rule were reopened once (migration 0040, 28 Oct 2026): 15029, whose only contract is voided. 13759 stayed Finalized; its contracts are live. Deal 14957 was excluded. |

City, state and ZIP are also rating inputs on the sheet: one edit, shown in
both places, and a change sends the deal back through Confirm and Continue.

### The Submit confirmation (2026-10-28)

"Submit contracts" opens a modal (`components/SubmitConfirm.tsx`) and sends
nothing. It shows the deal number, the buyer's name, the sale date at the
store ("28 Oct 2026"), a row per product (name, vendor from the provider
record, term, customer price) and the total customer price, with Cancel and
Confirm Submit.

- **Same figures as the submit.** fni-session-verify reads the customer's
  Included choices with the columns fni-contract-submit reads
  (`SUBMIT_ROW_COLUMNS`) and prices each line with `savedSelections`, the
  function that builds the submit's selections; the total is summed in whole
  cents (`submitConfirmation`, `_shared/saved-selections.ts`). OEM products,
  which are never sent, are left out of both. On a QA test session, where the
  test server is sent the provider's maximum instead, the modal says so.
- **The DX1 confirmation** moves into the modal when the panels have staff
  edits, and Confirm Submit stays disabled until it is ticked.
- **Busy.** Confirm Submit is the usual busy button (one spinner, one label,
  a second tap cannot send). The modal cannot be closed while it runs, and
  closes when the submit answers, so the result shows on the page. Cancel,
  or Escape, closes it and sends nothing.
- **Phones.** The modal is never wider than the screen less 16px a side; the
  product list scrolls inside it and the buttons stay in view.
- **Test sessions on an out-of-date rating** (2026-10-28). On a test session
  whose store points at the QA server (`pricePolicy` "Test at maximum"), an
  out-of-date rating no longer blocks Submit. Details says, in amber and not
  as an error, "The rating is out of date. This is a test session, so you can
  still submit.", and the modal says the same above the products.
  fni-contract-submit records the session event "Submitted on an out-of-date
  rating: test session", with the signed-in person's initials, before
  anything is sent, and sends nothing if it cannot. A real session is still
  refused. The sale day check applies to every session as before.
- **Spent rates after a void** (2026-10-28). A voided contract spends the
  rate it was made from: the provider refuses it again with "One or more of
  these products have been voided. Please re-rate and try again" (deal
  15029). iTap rates again without showing it, and so does Submit contracts
  (`_shared/spent-rates.ts`). A rate is spent when a contract made from it is
  Voided and the deal has not been rated since that void. Then pressing
  Submit contracts rates the deal again, the way staff do, before the modal
  opens, and matches every selection the submit sends to the fresh offer by
  product, term months, term miles, deductible and surcharges. When dealer
  cost, option cost and customer price are identical to the cent, each
  selection moves onto its fresh rate and the modal says "The rating was
  refreshed because an earlier contract was voided. Prices are unchanged."
  Otherwise nothing moves, the modal lists each difference (old and new
  figures, or "no longer offered"), says "Prices changed since this deal was
  rated. Review the products on Details before submitting.", and Confirm
  Submit stays disabled. A refresh never submits. If it fails, the
  provider's error is on the page behind Show details, with Copy error. The
  session events are "Rating refreshed after a void: prices unchanged" and
  "Rating refreshed after a void: prices changed, submit held", by the
  signed-in person's initials or System. A refresh leaves the session status
  alone, applies in any month, and does not change the same-month rule. Once
  rated after the void the rate is not spent, so a provider that still
  refuses is shown as a refusal and nothing retries.
- **Rate again** (2026-10-28). The Rating line on Details has a Rate again
  button for a signed-in operator, whatever the rating says, except while a
  submit is running or its outcome is unknown, or a contract on the deal is
  live (`lib/rate-again.ts`; fni-rate-vehicle refuses the same cases). It runs
  the same rating staff run, with the session's current inputs
  (`rate_again`). Each selection is matched to the fresh offer with the
  spent-rate rules, one by one: a match to the cent moves onto its fresh
  rate; anything else stays on its old rate and is listed under Rating as
  "Out of date", with what changed, until staff choose it again, and the
  Submit confirmation is held meanwhile. With selections the status is left
  alone; with none it moves as any rating moves it. A rating error shows in
  the rating banner with Show details and Copy error. Every press is
  recorded as "Rated again by <initials>", or "Rated again by System".
