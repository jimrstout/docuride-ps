// lib/profiles.ts
//
// Vehicle-aware discovery copy.
//
// This is the smartest idea in the reference build and it survives the port
// intact: the discovery question changes with the vehicle rather than asking
// everyone the same thing. "Where will you ride?" for a motorcycle, "Where will
// you use it?" for a side-by-side, "Where will it work?" for equipment.
//
// In the prototype this was driven by a hardcoded vehicle key. Here it is driven
// by the TecAssured vehicle type already stored on the session.

export interface DiscoveryOption {
  value: string;
  label: string;
  hint: string;
  image: string;
}

export interface VehicleProfile {
  key: string;
  question: string;
  intro: string;
  quote: string;
  options: DiscoveryOption[];
}

const RIDE: DiscoveryOption[] = [
  { value: "local", label: "Local riding", hint: "Around town, shorter trips", image: "/assets/appalachia-hero.jpg" },
  { value: "weekend", label: "Weekend / recreational", hint: "Back roads, scenic rides", image: "/assets/sunset-ridges.jpg" },
  { value: "distance", label: "Long distance", hint: "Touring, multi-day trips", image: "/assets/road.jpg" },
  { value: "unsure", label: "Not sure yet", hint: "Help me think it through", image: "/assets/lake-mountains.jpg" },
];

const UTILITY: DiscoveryOption[] = [
  { value: "property", label: "Property / farm", hint: "Farm, woods, acreage", image: "/assets/appalachia-hero.jpg" },
  { value: "trails", label: "Trails / recreation", hint: "Weekend rides, trail systems", image: "/assets/road.jpg" },
  { value: "work", label: "Work / utility", hint: "Projects, hauling, daily work", image: "/assets/lake-mountains.jpg" },
  { value: "outdoors", label: "Hunting / outdoors", hint: "Remote access and seasons", image: "/assets/sunset-ridges.jpg" },
];

const YOUTH: DiscoveryOption[] = [
  { value: "property", label: "On our property", hint: "Farm, woods, trails", image: "/assets/appalachia-hero.jpg" },
  { value: "designated", label: "Designated riding areas", hint: "Parks, OHV areas", image: "/assets/youth-trail.jpg" },
  { value: "learning", label: "Beginner / learning", hint: "New to riding", image: "/assets/lake-mountains.jpg" },
  { value: "family", label: "Recreational riding", hint: "Family riding and weekends", image: "/assets/sunset-ridges.jpg" },
];

const EQUIPMENT: DiscoveryOption[] = [
  { value: "jobsite", label: "Construction sites", hint: "Daily jobsite work", image: "/assets/appalachia-hero.jpg" },
  { value: "property", label: "Farm / property", hint: "Maintenance and projects", image: "/assets/lake-mountains.jpg" },
  { value: "landscaping", label: "Landscaping", hint: "Multiple applications", image: "/assets/sunset-ridges.jpg" },
  { value: "multi", label: "Multiple sites", hint: "Commercial / mobile use", image: "/assets/road.jpg" },
];

const WATER: DiscoveryOption[] = [
  { value: "local-lake", label: "Local lake or river", hint: "Close to home", image: "/assets/lake-mountains.jpg" },
  { value: "weekend", label: "Weekends away", hint: "Trips and getaways", image: "/assets/sunset-ridges.jpg" },
  { value: "family", label: "Family and guests", hint: "Towing, swimming, days out", image: "/assets/appalachia-hero.jpg" },
  { value: "unsure", label: "Not sure yet", hint: "Help me think it through", image: "/assets/road.jpg" },
];

const PROFILES: Record<string, VehicleProfile> = {
  road: {
    key: "road",
    question: "Where will you ride?",
    intro: "Select all that apply. Your answers change the order things appear in, and nothing else.",
    quote: "Different roads.<br/>A better tomorrow.",
    options: RIDE,
  },
  utility: {
    key: "utility",
    question: "Where will you use it?",
    intro: "Select all that apply. Your answers change the order things appear in, and nothing else.",
    quote: "More ground.<br/>More possibility.",
    options: UTILITY,
  },
  youth: {
    key: "youth",
    question: "Where will they ride?",
    intro: "Select all that apply. Your answers change the order things appear in, and nothing else.",
    quote: "Confidence today.<br/>Bigger tomorrows.",
    options: YOUTH,
  },
  equipment: {
    key: "equipment",
    question: "Where will it work?",
    intro: "Select all that apply. Your answers change the order things appear in, and nothing else.",
    quote: "Work today.<br/>Possibility tomorrow.",
    options: EQUIPMENT,
  },
  water: {
    key: "water",
    question: "Where will you take it out?",
    intro: "Select all that apply. Your answers change the order things appear in, and nothing else.",
    quote: "Open water.<br/>Open calendar.",
    options: WATER,
  },
};

// TecAssured vehicle type codes, as mapped by fni-session-start's BODY_TYPE_MAP.
const BY_CODE: Record<string, string> = {
  MCYC: "road",
  BIKE: "road",
  SNOW: "road",
  ATV: "utility",
  UTV: "utility",
  PWAC: "water",
  BOAT: "water",
  // Non-ratable units (trailers, e-bikes, excavators, zero turns, tractors)
  // arrive with no code at all and fall through to the default.
};

/**
 * The youth variant needs a signal the session does not yet carry. TecAssured
 * has no distinct youth vehicle type in the mapping fni-session-start uses, and
 * guessing from a model name would mislabel adult machines. Until a real signal
 * exists (a youth vehicle type code, or engine displacement on the session),
 * an ATV gets the utility profile and the youth copy stays unreachable rather
 * than firing on a heuristic.
 */
export function profileFor(
  vehicleTypeCode: string | null,
  override?: string | null
): VehicleProfile {
  if (override && PROFILES[override]) return PROFILES[override];
  const key = vehicleTypeCode ? BY_CODE[vehicleTypeCode.toUpperCase()] : undefined;
  return PROFILES[key ?? "equipment"];
}

export { PROFILES };
