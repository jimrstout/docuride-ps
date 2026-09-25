// Building a TecAssured rate request from what the server asks for.
//
// The rate request is a `properties` array whose names come from
// /rate/requiredproperties, and the two things that make it easy to get wrong
// are both exercised here: the names are dotted and lowercase, and TecAssured
// spells `warranty` differently depending on the vehicle type.
//
// The property lists below are verbatim from the QA server on 2026-09-25,
// dealer 3-306. They are the point of the test: a plausible-looking invented
// list would pass while the real one failed.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRequiredProperties,
  buildRateProperties,
} from "../supabase/functions/_shared/rate-properties.ts";
import {
  BODY_TYPE_MAP,
  RATEABLE_VTYPES,
  vtypeForBodyType,
} from "../supabase/functions/_shared/vehicle-types.ts";

const p = (name, description, type = "STRING") => ({ name, description, type });

/** UTV on dealer 3-306. Note `Warranty`, capitalised, and inservice.date. */
const UTV = {
  properties: [
    p("vin", "VIN"), p("fuel.type", "Fuel Type"), p("year", "Year"),
    p("make", "Make"), p("model", "Model"), p("new.used", "Vehicle Status"),
    p("engine.ccs", "Engine CCs"), p("finance.type", "Finance Type"),
    p("finance.amount", "Finance Amount", "DECIMAL"),
    p("finance.apr", "Finance APR %", "DECIMAL"),
    p("finance.term", "Finance Term (months)", "INTEGER"),
    p("odometer", "Odometer", "INTEGER"), p("price", "Vehicle Price", "DECIMAL"),
    p("sale.date", "Sale Date", "DATE"), p("inservice.date", "In-Service Date"),
    p("Warranty", "Remaining Manufacturer Warranty Months"),
    p("postal.code", "Customer Postal Code"),
  ],
};

/** MCYC on the same dealer. Note `warranty`, lowercase, and NO inservice.date. */
const MCYC = {
  properties: [
    p("year", "Year"), p("vin", "VIN"), p("model", "Model"), p("make", "Make"),
    p("fuel.type", "Fuel Type"), p("engine.ccs", "Engine CCs"),
    p("finance.amount", "Finance Amount", "DECIMAL"),
    p("finance.apr", "Finance APR %", "DECIMAL"),
    p("finance.term", "Finance Term (months)", "INTEGER"),
    p("odometer", "Odometer", "INTEGER"), p("price", "Vehicle Price", "DECIMAL"),
    p("new.used", "Vehicle Status"), p("finance.type", "Finance Type"),
    p("warranty", "Remaining Manufacturer Warranty Months"),
    p("sale.date", "Sale Date", "DATE"), p("postal.code", "Customer Postal Code"),
  ],
};

const session = (over = {}) => ({
  vin: "4XARSM994V8046456",
  unit_year: 2027,
  unit_make: "Polaris",
  unit_model: "Ranger Crew XP 1000 Cab",
  condition: "New",
  odometer: 5,
  sale_price: 28995,
  amount_financed: 30500,
  apr: 8.99,
  finance_term: 60,
  finance_type: "Loan",
  sale_date: "2026-09-25",
  in_service_date: "2026-09-25",
  buyer_zip: "26101",
  vehicle_properties: { "engine.ccs": "999", "fuel.type": "Gas", warranty: "12" },
  ...over,
});

const asMap = (built) => Object.fromEntries(built.properties.map((x) => [x.name, x.value]));

test("every property the server asks for is answered, and nothing else is sent", () => {
  const required = parseRequiredProperties(UTV).properties;
  const built = buildRateProperties(required, session());

  assert.deepEqual(built.missing, []);
  assert.equal(built.properties.length, required.length);
  // Same names, same order, same spelling.
  assert.deepEqual(built.properties.map((x) => x.name), required.map((r) => r.name));
});

test("the dotted names carry the values the camelCase fields used to", () => {
  const built = asMap(buildRateProperties(parseRequiredProperties(UTV).properties, session()));

  assert.equal(built["price"], "28995");
  assert.equal(built["finance.amount"], "30500");
  assert.equal(built["finance.apr"], "8.99");
  assert.equal(built["finance.term"], "60");
  assert.equal(built["sale.date"], "2026-09-25");
  assert.equal(built["inservice.date"], "2026-09-25");
  assert.equal(built["postal.code"], "26101");
  assert.equal(built["odometer"], "5");
  assert.equal(built["engine.ccs"], "999");
});

test("Loan becomes Purchase, because that is TecAssured's word", () => {
  const b = (t) => asMap(buildRateProperties(parseRequiredProperties(UTV).properties, session({ finance_type: t })));
  assert.equal(b("Loan")["finance.type"], "Purchase");
  assert.equal(b("Lease")["finance.type"], "Lease");
  assert.equal(b("Cash")["finance.type"], "Cash");
});

test("condition becomes new.used", () => {
  const b = (c) => asMap(buildRateProperties(parseRequiredProperties(UTV).properties, session({ condition: c })));
  assert.equal(b("New")["new.used"], "New");
  assert.equal(b("Used")["new.used"], "Used");
});

// ── The casing trap ───────────────────────────────────────────────────────
// TecAssured returns `Warranty` for UTV and `warranty` for MCYC. One stored
// value has to satisfy both, and the name sent back has to be theirs.

test("a lowercase stored warranty answers a capitalised Warranty", () => {
  const built = buildRateProperties(
    parseRequiredProperties(UTV).properties,
    session({ vehicle_properties: { "engine.ccs": "999", "fuel.type": "Gas", warranty: "12" } })
  );
  assert.deepEqual(built.missing, []);
  assert.equal(asMap(built)["Warranty"], "12");
  assert.equal("warranty" in asMap(built), false, "must echo the server's spelling, not ours");
});

test("a capitalised stored Warranty answers a lowercase warranty", () => {
  const built = buildRateProperties(
    parseRequiredProperties(MCYC).properties,
    session({ vehicle_properties: { "engine.ccs": "636", "fuel.type": "Gas", Warranty: "12" } })
  );
  assert.deepEqual(built.missing, []);
  assert.equal(asMap(built)["warranty"], "12");
  assert.equal("Warranty" in asMap(built), false, "must echo the server's spelling, not ours");
});

test("MCYC is not asked for inservice.date, so none is sent", () => {
  const built = asMap(buildRateProperties(parseRequiredProperties(MCYC).properties, session()));
  assert.equal("inservice.date" in built, false);
  assert.equal("sale.date" in built, true);
});

// ── Refusing rather than guessing ─────────────────────────────────────────

test("a property with no value stops the request and says which", () => {
  const built = buildRateProperties(
    parseRequiredProperties(UTV).properties,
    session({ vehicle_properties: { "fuel.type": "Gas", warranty: "12" } })
  );
  assert.deepEqual(built.missing.map((m) => m.name), ["engine.ccs"]);
  // The description is what tells an F&I user what to type.
  assert.equal(built.missing[0].description, "Engine CCs");
});

test("every unsupplied property is reported, not just the first", () => {
  const built = buildRateProperties(
    parseRequiredProperties(UTV).properties,
    session({ vehicle_properties: null, buyer_zip: null })
  );
  assert.deepEqual(
    built.missing.map((m) => m.name).sort(),
    ["Warranty", "engine.ccs", "fuel.type", "postal.code"]
  );
});

test("a user value overrides the session's", () => {
  const built = asMap(buildRateProperties(
    parseRequiredProperties(UTV).properties,
    session({ vehicle_properties: { "engine.ccs": "999", "fuel.type": "Gas", warranty: "12", price: "27500" } })
  ));
  assert.equal(built["price"], "27500");
});

// ── Parsing ───────────────────────────────────────────────────────────────

test("both a wrapped list and a bare array are understood", () => {
  assert.equal(parseRequiredProperties(UTV).names.length, 17);
  assert.equal(parseRequiredProperties(UTV.properties).names.length, 17);
});

test("an empty answer is an empty list, not a crash", () => {
  for (const empty of [null, undefined, {}, [], { properties: [] }, "nonsense"]) {
    assert.deepEqual(parseRequiredProperties(empty).names, []);
  }
});

test("an entry with no name is dropped rather than sent blank", () => {
  const parsed = parseRequiredProperties({ properties: [p("vin", "VIN"), { description: "?" }, p("  ", "blank")] });
  assert.deepEqual(parsed.names, ["vin"]);
});

// ── The vtype list ────────────────────────────────────────────────────────

test("the cached vtypes are exactly the ones a session can hold", () => {
  assert.deepEqual([...RATEABLE_VTYPES], ["ATV", "BIKE", "BOAT", "MCYC", "PWAC", "SNOW", "UTV"]);
  // Derived from the map, so the two cannot drift.
  assert.deepEqual([...RATEABLE_VTYPES], [...new Set(Object.values(BODY_TYPE_MAP))].sort());
});

test("body types map the way the planner expects", () => {
  assert.equal(vtypeForBodyType("SxS"), "UTV");
  assert.equal(vtypeForBodyType("Street Motorcycle"), "MCYC");
  assert.equal(vtypeForBodyType("Tractors"), null, "not TecAssured-ratable");
  assert.equal(vtypeForBodyType(null), null);
});

// ── The combined request ──────────────────────────────────────────────────
// Proved against the QA server on 2026-09-25: documented top-level fields PLUS
// the requiredproperties array rates; either half alone does not.

import { buildRateRequest } from "../supabase/functions/_shared/rate-properties.ts";

const full = (over = {}) => ({ ...session(), buyer_city: "Parkersburg", buyer_state: "WV", ...over });
const opts = { dealerCode: "3-306", vtype: "UTV", rateDate: "2026-09-25" };

test("the request carries both halves", () => {
  const { request, missing } = buildRateRequest(parseRequiredProperties(UTV).properties, full(), opts);
  assert.deepEqual(missing, []);
  // The documented half.
  assert.equal(request.vehiclePrice, "28995");
  assert.equal(request.displacement, "999");
  assert.equal(request.remainingMWM, "12");
  // And the form-schema half, untouched.
  assert.equal(request.properties.length, 17);
  assert.equal(request.properties.find((p) => p.name === "price").value, "28995");
});

test("fuelType is the documented code, not the word we store", () => {
  // Section 6.5 lists only G, E and D. "Gas" is not a documented value.
  const r = (v) => buildRateRequest(parseRequiredProperties(UTV).properties,
    full({ vehicle_properties: { "engine.ccs": "999", "fuel.type": v, warranty: "12" } }), opts).request;
  assert.equal(r("Gas").fuelType, "G");
  assert.equal(r("G").fuelType, "G");
  assert.equal(r("Electric").fuelType, "E");
  assert.equal(r("Diesel").fuelType, "D");
  // The array still echoes what was stored, which is what the proven call sent.
  assert.equal(r("Gas").properties.find((p) => p.name === "fuel.type").value, "Gas");
});

test("one stored value feeds both names for engine size and warranty", () => {
  const { request } = buildRateRequest(parseRequiredProperties(UTV).properties, full(), opts);
  assert.equal(request.displacement, request.properties.find((p) => p.name === "engine.ccs").value);
  assert.equal(request.remainingMWM, request.properties.find((p) => p.name === "Warranty").value);
});

test("a capitalised stored Warranty still reaches remainingMWM", () => {
  const { request } = buildRateRequest(parseRequiredProperties(MCYC).properties,
    full({ vehicle_properties: { "engine.ccs": "636", "fuel.type": "Gas", Warranty: "9" } }), { ...opts, vtype: "MCYC" });
  assert.equal(request.remainingMWM, "9");
  assert.equal(request.properties.find((p) => p.name === "warranty").value, "9");
});

test("purchaseType and vehicleStatus are both sent from the one value", () => {
  // Section 6.2 calls vehicleStatus a duplicate of purchaseType and marks both Required.
  const r = (c) => buildRateRequest(parseRequiredProperties(UTV).properties, full({ condition: c }), opts).request;
  assert.equal(r("New").purchaseType, "New");
  assert.equal(r("New").vehicleStatus, "New");
  assert.equal(r("Used").vehicleStatus, "Used");
});

test("an optional field with no value is omitted, not sent empty", () => {
  const { request } = buildRateRequest(parseRequiredProperties(MCYC).properties,
    full({ amount_financed: null, apr: null, finance_term: null }), { ...opts, vtype: "MCYC" });
  assert.equal("financeAmount" in request, false);
  assert.equal("financeApr" in request, false);
  assert.equal("financeTerm" in request, false);
  // Required ones are still there.
  assert.equal(request.vehiclePrice, "28995");
});

test("every requiredproperties name has a top-level counterpart", () => {
  // The two formats are near-complete duplicates under different names. This
  // pins the mapping so a rename on either side is caught here.
  const counterpart = {
    "vin": "vin", "year": "year", "make": "make", "model": "model",
    "odometer": "odometer", "price": "vehiclePrice",
    "new.used": "purchaseType", "engine.ccs": "displacement",
    "fuel.type": "fuelType", "warranty": "remainingMWM", "Warranty": "remainingMWM",
    "finance.type": "financeType", "finance.amount": "financeAmount",
    "finance.apr": "financeApr", "finance.term": "financeTerm",
    "sale.date": "saleDate", "inservice.date": "inServiceDate",
    "postal.code": "customerPostalCode",
  };
  const { request } = buildRateRequest(parseRequiredProperties(UTV).properties, full(), opts);
  for (const prop of request.properties) {
    const top = counterpart[prop.name];
    assert.ok(top, `no known top-level counterpart for ${prop.name}`);
    assert.ok(top in request, `${prop.name} maps to ${top}, which is not in the request`);
  }
});
