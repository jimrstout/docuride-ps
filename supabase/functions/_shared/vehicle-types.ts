// _shared/vehicle-types.ts
//
// The vehicle types DocuRide can rate, and how a Zoho body type becomes one.
//
// ── Why this list is here and not fetched ───────────────────────────────
// /rate/vehicletypes would have answered "what does this dealer sell", and it
// does not exist -- see _shared/TECASSURED_SHOP_API.md. What is left is the
// other direction: the types DocuRide can actually produce from a Zoho deal,
// which is exactly the set below, because a session's vehicle_type_code is
// only ever one of these or null.
//
// So the refresh job asks /rate/requiredproperties about each of these per
// store. A dealer that does not sell one answers with nothing, and that is
// recorded as "Unavailable" -- which is the same information the missing
// endpoint would have given, arrived at from the side that works.

/** Zoho Sold_1_Body_Type -> TecAssured vtype. */
export const BODY_TYPE_MAP: Record<string, string> = {
  "ATV Off Road": "ATV",
  "ATV": "ATV",
  "SxS": "UTV",
  "Street Motorcycle": "MCYC",
  "3 Wheel Motorcycle": "MCYC",
  "Motorcycle Off Road": "BIKE",
  "Motocross Off Road": "BIKE",
  "PWCs": "PWAC",
  "Power Boats": "BOAT",
  "Snowmobile": "SNOW",
  //
  // Not TecAssured-ratable, so deliberately unmapped:
  // Boat Trailers, Trailer, Trailers, Trailer - Utility, Electric Bicycle,
  // Excavators, Commercial zero turns, Residential zero turns,
  // Residential tractors, Tractors
};

/**
 * Every vtype a session can end up with, derived from the map rather than
 * written twice. Adding a body type above is enough to get it cached.
 */
export const RATEABLE_VTYPES: readonly string[] = [
  // SCO (Scooter) has no CRM body type yet, but staff can choose it on Verify,
  // so what TecAssured asks for it is cached like the rest.
  ...new Set([...Object.values(BODY_TYPE_MAP), "SCO"]),
].sort();

export function vtypeForBodyType(bodyType: string | null): string | null {
  if (!bodyType) return null;
  return BODY_TYPE_MAP[bodyType] ?? null;
}

// ── The vehicle type staff choose on Verify ───────────────────────────────
//
// TecAssured offers each Riders Advantage product in vehicle-specific versions
// (On-Road, Off-Road MC, UTV/ATV) and enforces the match at contract time, not
// at quote time. A street bike quoted the Off-Road Tire and Wheel is refused
// when the contract goes in. So the vehicle type is a choice staff can see and
// change, stored exactly as shown, and it decides both the menu template and
// the vtype sent to TecAssured.

export const VEHICLE_TYPES = [
  "ATV",
  "UTV",
  "On-Road Motorcycle",
  "Off-Road Motorcycle",
  "Scooter",
  "Personal Watercraft",
  "Snowmobile",
  "Other",
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/**
 * What TecAssured is sent for each choice: exactly its own vehicle type codes
 * (API guide 6.3). MCYC is On-Road Motorcycle, BIKE Off-Road Motorcycle, SCO
 * Scooter, PWAC Personal Watercraft, SNOW Snowmobile. UTV and motorcycles send
 * what they always sent. "Other" is not a vehicle TecAssured rates, so nothing
 * is sent and the deal is not rated.
 */
export const TECASSURED_VTYPE: Record<VehicleType, string | null> = {
  "ATV": "ATV",
  "UTV": "UTV",
  "On-Road Motorcycle": "MCYC",
  "Off-Road Motorcycle": "BIKE",
  "Scooter": "SCO",
  "Personal Watercraft": "PWAC",
  "Snowmobile": "SNOW",
  "Other": null,
};

export function isVehicleType(v: unknown): v is VehicleType {
  return typeof v === "string" && (VEHICLE_TYPES as readonly string[]).includes(v);
}

/** The vtype to send TecAssured, or null. */
export function tecAssuredVtype(type: string | null | undefined): string | null {
  return isVehicleType(type) ? TECASSURED_VTYPE[type] : null;
}

/** The choice an earlier stored TecAssured code stands for. */
export function vehicleTypeForCode(code: string | null | undefined): VehicleType | null {
  switch (String(code ?? "").trim().toUpperCase()) {
    case "ATV": return "ATV";
    case "UTV": return "UTV";
    case "MCYC": return "On-Road Motorcycle";
    case "BIKE": return "Off-Road Motorcycle";
    case "SCO": return "Scooter";
    case "PWAC": return "Personal Watercraft";
    case "SNOW": return "Snowmobile";
    case "": return null;
    default: return "Other";
  }
}

/**
 * Model names that clearly mark an off-road motorcycle: KX, CRF, YZ, RM-Z, KLX,
 * TC, SX, EXC, FC and their kin, as a word or a word with a number on it
 * ("KX250", "CRF450R", "250 SX-F"). A street model that merely contains the
 * letters ("Vulcan 900", "FXDR") does not match.
 */
const OFF_ROAD_MODEL =
  /(^|[^A-Z0-9])(KX|KLX|CRF|YZ|YZF|WR|RM-?Z|RMX|DR-?Z|TC|TE|FC|FE|FX|SX|SX-?F|XC|XC-?F|XC-?W|EXC|MC|TTR|TT-R|PW)(\d|[^A-Z]|$)/i;

/** True when the model name clearly marks an off-road bike. */
export function looksOffRoad(model: string | null | undefined): boolean {
  return OFF_ROAD_MODEL.test(String(model ?? ""));
}

/** What a CRM body type says the vehicle is, before the model is looked at. */
const BODY_TYPE_CHOICE: Record<string, VehicleType> = {
  "ATV Off Road": "ATV",
  "ATV": "ATV",
  "SxS": "UTV",
  "Street Motorcycle": "On-Road Motorcycle",
  "3 Wheel Motorcycle": "On-Road Motorcycle",
  "Motorcycle Off Road": "Off-Road Motorcycle",
  "Motocross Off Road": "Off-Road Motorcycle",
  "PWCs": "Personal Watercraft",
  "Snowmobile": "Snowmobile",
};

export interface VehicleTypeEvidence {
  body_type: string | null;
  make: string | null;
  model: string | null;
  /** TecAssured's own vtype from the VIN decode, if there was one. */
  decoded_vtype: string | null;
}

export interface VehicleTypePick {
  type: VehicleType;
  /** One plain line for Verify: where the choice came from. */
  source: string;
}

/**
 * The vehicle type to start a deal with. The one place the rule lives.
 *
 *   1. The CRM body type, when it names one.
 *   2. Otherwise the VIN decode's vtype.
 *   3. Otherwise Other.
 * MCYC (a street or three-wheel body type, or MCYC from the decode) is
 * ambiguous: it is On-Road unless the model clearly marks an off-road bike.
 */
export function pickVehicleType(e: VehicleTypeEvidence): VehicleTypePick {
  const body = String(e.body_type ?? "").trim();
  const fromBody = BODY_TYPE_CHOICE[body];
  // A street body type is what becomes MCYC. The model can still say plainly
  // that it is an off-road bike, and then it wins.
  if (fromBody === "On-Road Motorcycle" && looksOffRoad(e.model)) {
    return {
      type: "Off-Road Motorcycle",
      source: `Picked from the model ${String(e.model).trim()}, an off-road bike, although the CRM body type is ${body}. Change it if that is wrong.`,
    };
  }
  if (fromBody) {
    return { type: fromBody, source: `Picked from the CRM body type ${body}. Change it if that is wrong.` };
  }

  const vtype = String(e.decoded_vtype ?? "").trim().toUpperCase();
  if (vtype === "MCYC") {
    return looksOffRoad(e.model)
      ? { type: "Off-Road Motorcycle", source: `Picked from the VIN decode (MCYC) and the model ${String(e.model).trim()}. Change it if that is wrong.` }
      : { type: "On-Road Motorcycle", source: "Picked from the VIN decode (MCYC): a motorcycle, taken as On-Road. Change it if that is wrong." };
  }
  const fromCode = vtype === "" ? null : vehicleTypeForCode(vtype);
  if (fromCode && fromCode !== "Other") {
    return { type: fromCode, source: `Picked from the VIN decode (${vtype}). Change it if that is wrong.` };
  }

  return {
    type: "Other",
    source: body
      ? `The CRM body type ${body} is not one DocuRide can rate. Choose the vehicle type if it is one.`
      : "Neither the CRM nor the VIN decode says what this is. Choose the vehicle type.",
  };
}

export interface ResolvedVehicleType {
  type: VehicleType | null;
  /** Where it came from, as Verify's source column says it. */
  from: "CRM" | "VIN Decode" | "Missing";
  /** The plain line shown under the choice. */
  line: string;
}

/**
 * A session's vehicle type, as rating and Verify see it, before staff edits.
 *
 *   • The stored choice (sessions.vehicle_type), with the line saying where
 *     it came from (sessions.vehicle_type_source).
 *   • A stored "Other" or nothing yet: the VIN decode's vtype, picked by the
 *     same rule, once the VIN has been decoded.
 *   • A session from before the choice existed: its stored TecAssured code.
 */
export function resolveVehicleType(s: Record<string, unknown>): ResolvedVehicleType {
  const stored = s.vehicle_type;
  const storedLine = typeof s.vehicle_type_source === "string" && s.vehicle_type_source.trim() !== ""
    ? s.vehicle_type_source.trim()
    : null;
  if (isVehicleType(stored) && (stored !== "Other" || s.vehicle_type_entered === true)) {
    return { type: stored, from: "CRM", line: storedLine ?? "From the CRM deal. Change it if that is wrong." };
  }

  const decode = (s.vin_decode ?? null) as Record<string, unknown> | null;
  const decodedVtype = decode && typeof decode.vtype === "string" ? decode.vtype : null;
  if (decodedVtype) {
    const pick = pickVehicleType({
      body_type: null,
      make: typeof s.unit_make === "string" ? s.unit_make : null,
      model: typeof s.unit_model === "string" ? s.unit_model : null,
      decoded_vtype: decodedVtype,
    });
    if (pick.type !== "Other") return { type: pick.type, from: "VIN Decode", line: pick.source };
  }

  if (stored === "Other") {
    return { type: "Other", from: "CRM", line: storedLine ?? "Not a vehicle DocuRide can rate. Choose the vehicle type if it is one." };
  }
  const legacy = vehicleTypeForCode(typeof s.vehicle_type_code === "string" ? s.vehicle_type_code : null);
  if (legacy) return { type: legacy, from: "CRM", line: "From the CRM deal. Change it if that is wrong." };
  return { type: null, from: "Missing", line: "Choose the vehicle type. It decides the menu and what TecAssured is asked." };
}

/**
 * The vehicle type columns for a session, from a Zoho DocuRide record:
 * vehicle_type, the line saying where it came from, and the TecAssured code.
 * Shared by session creation and Refresh, so the two cannot disagree.
 */
export function crmVehicleType(record: Record<string, unknown>): {
  vehicle_type: VehicleType;
  vehicle_type_source: string;
  vehicle_type_code: string | null;
} {
  const t = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());
  const pick = pickVehicleType({
    body_type: t(record.Sold_1_Body_Type),
    make: t(record.Sold_1_Make),
    model: t(record.Sold_1_Model),
    decoded_vtype: null,
  });
  return { vehicle_type: pick.type, vehicle_type_source: pick.source, vehicle_type_code: TECASSURED_VTYPE[pick.type] };
}
