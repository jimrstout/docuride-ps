// A realistic fni.rated_offers row for the 2020 Can-Am Spyder RT session.
//
// Shaped as an actual rated_offers row rather than as convenient test data: the
// separate dealer_cost, the surcharge structure selected_options expects, real
// coverage terms and deductibles, and product codes in TecAssured's format.
// Building the UI against a simplified shape and reworking it the week
// credentials arrive is the risk this fixture exists to avoid.
//
// UNCONFIRMED: TecAssured had not issued credentials as of 2026-09-17 and the
// documentation carries no usable test set, so the exact Offer Format key names
// are inferred. The normalizer reads them tolerantly and keeps every raw object,
// so correcting this fixture later does not invalidate stored sessions.

export const RATED_OFFER_RESPONSE = {
  dealerCode: "1-304",
  vin: "2BXNBDD24LV001706",
  vtype: "MCYC",
  rateDate: "2026-09-19",
  products: [
    {
      productUnique: "VSC",
      productType: "Vehicle Service Contract",
      productName: "Vehicle Service Contract",
      rateUnique: "R-VSC-48-500-0001",
      termMonths: 48,
      termMiles: 48000,
      deductible: 100,
      dealerCost: 1349.0,
      surcharges: [
        { code: "TURBO", description: "Turbocharged or supercharged", cost: 185.0, applied: false },
        { code: "LIFT", description: "Lift kit installed", cost: 120.0, applied: false },
      ],
    },
    {
      productUnique: "GAP",
      productType: "Guaranteed Asset Protection",
      productName: "GAP",
      rateUnique: "R-GAP-60-0001",
      termMonths: 60,
      deductible: 0,
      dealerCost: 199.0,
      surcharges: [],
    },
    {
      productUnique: "TW",
      productType: "Tire & Wheel",
      productName: "Tire and Wheel Protection",
      rateUnique: "R-TW-36-0001",
      termMonths: 36,
      deductible: 0,
      dealerCost: 289.0,
      surcharges: [
        { code: "OVERSIZE", description: "Oversized or aftermarket tires", cost: 95.0, applied: false },
      ],
    },
    {
      productUnique: "KEY",
      productType: "Key Replacement",
      productName: "Key and Remote Replacement",
      rateUnique: "R-KEY-60-0001",
      termMonths: 60,
      deductible: 0,
      dealerCost: 79.0,
      surcharges: [],
    },
    {
      // Offered by the provider, but the store has no approved copy for it yet.
      // The planner must withhold it rather than show a nameless product.
      productUnique: "PPM",
      productType: "Prepaid Maintenance",
      productName: "Planned Maintenance",
      rateUnique: "R-PPM-36-0001",
      termMonths: 36,
      deductible: 0,
      dealerCost: 349.0,
      surcharges: [],
    },
  ],
};
