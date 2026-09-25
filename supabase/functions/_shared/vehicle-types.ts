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
  ...new Set(Object.values(BODY_TYPE_MAP)),
].sort();

export function vtypeForBodyType(bodyType: string | null): string | null {
  if (!bodyType) return null;
  return BODY_TYPE_MAP[bodyType] ?? null;
}
