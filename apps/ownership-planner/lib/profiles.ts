// lib/profiles.ts
//
// The ownership-profile configuration layer.
//
// Everything that varies by what the customer bought lives here: which
// questions make sense, which answers are offered, which photography reads as
// the right kind of place, and the phrase that sits under it. Presentation
// components read a profile; they never test a make or a model. Adding a
// vehicle category is an edit to this file alone.
//
// Two rules govern the questions.
//
// They are discovery, not an interrogation: two at most, and never something
// the dealership already knows from the deal. "How long do you plan to keep
// it?" is deliberately absent -- customers answer it aspirationally, so the
// answer is not usable.
//
// And they must make sense for the machine. A touring motorcycle is not asked
// about mud. A youth ATV is not asked about interstate riding. That is the
// whole reason the options are per-profile rather than a shared list.
//
// What the answers do: they change the ORDER products appear in, and nothing
// else. They never remove a product, never gate one, and never change a price.
// Eligibility comes from the rating call and the catalog, which is business
// logic and lives elsewhere.

export type ProfileKey =
  | "ON_ROAD"
  | "UTILITY_RECREATION"
  | "OFF_ROAD_RECREATION"
  | "YOUTH"
  | "EQUIPMENT";

export interface DiscoveryOption {
  /** Stored in session.discovery and matched against catalog relevance_tags. */
  value: string;
  label: string;
  hint: string;
  /** Atmospheric, and of the right kind of place. Never the customer's unit. */
  image: string;
  /** What the photograph shows, for anyone who cannot see it. */
  alt: string;
}

export interface DiscoveryQuestion {
  /** The key this question's answers are stored under in session.discovery. */
  id: "use_context" | "priorities";
  question: string;
  help: string;
  options: DiscoveryOption[];
}

export interface VehicleProfile {
  key: ProfileKey;
  /** Plain name for the category, for labels and accessible text. */
  label: string;
  /** Sits under the contextual photograph in the rail. Ownership, not sales. */
  tagline: string;
  /** The rail photograph. Category-appropriate, never a specific trim. */
  railImage: string;
  railAlt: string;
  questions: DiscoveryQuestion[];
}

// ── Photography ───────────────────────────────────────────────────────────
//
// Appalachian and Ohio Valley: deciduous ridges, river valleys, rural and
// gravel roads, farms, wooded trails. Not Rocky Mountain alpine, which is the
// stock-photo default and reads as somewhere else entirely.
//
// ⚠ The five files below are NOT photographs. Every one is a small crop of a
// design comp -- 135x430 to 510x425 -- and two of them carry interface baked
// into the pixels:
//
//   road.jpg            a product card reading "2024 Indian Challenger
//                       Limited / Thunder Black Smoke | 112 ci", two dead
//                       links ("View Dealer Info", "View Window Sticker"),
//                       and the caption "Different roads. A better tomorrow."
//   appalachia-hero.jpg a landing page, headline and a "Let's get started"
//                       form with Can-Am / Defender Limited / 2026 selected.
//
// Shown to a customer these would be strange at best and misleading at worst:
// a specific trim and colour presented as atmosphere, next to buttons that
// cannot be pressed because they are a picture. At the sizes this interface
// renders them they would also be visibly upscaled.
//
// So the system is built and the assets are not used. PHOTOGRAPHY_READY gates
// every image in the flow; the slots, the categories and the alt text below
// are real and stay real. Drop five genuine photographs at these paths and
// flip the constant -- that is the whole change.
export const PHOTOGRAPHY_READY = false;

const IMG = {
  ridges: "/assets/appalachia-hero.jpg",
  sunset: "/assets/sunset-ridges.jpg",
  road: "/assets/road.jpg",
  valley: "/assets/lake-mountains.jpg",
  trail: "/assets/youth-trail.jpg",
} as const;

// ── The second question, shared in shape across every profile ─────────────
//
// It asks what the customer wants out of owning the thing, and its three
// answers are the three goals the product catalog already files every plan
// under. That is what makes it do real work rather than decorate the screen:
// a product whose catalog goal matches an answer sorts forward.
//
// The values are matched case-insensitively against `product_catalog.goal`, so
// a store's own wording is what decides, not a constant in this file.
const PRIORITIES: DiscoveryQuestion = {
  id: "priorities",
  question: "What matters most in owning it?",
  help: "Pick any that fit. This orders what you see first.",
  options: [
    {
      value: "keep ownership manageable",
      label: "Costs I can plan for",
      hint: "Fewer surprises in the budget",
      image: IMG.valley,
      alt: "A river valley under low hills",
    },
    {
      value: "keep ownership enjoyable",
      label: "Time on it, not waiting on it",
      hint: "Back out quickly when something comes up",
      image: IMG.sunset,
      alt: "Late sun across forested ridges",
    },
    {
      value: "keep it valuable",
      label: "Keeping it in good shape",
      hint: "Condition and value over the years",
      image: IMG.ridges,
      alt: "Wooded Appalachian ridgelines in morning haze",
    },
  ],
};

const PROFILES: Record<ProfileKey, VehicleProfile> = {
  ON_ROAD: {
    key: "ON_ROAD",
    label: "on-road motorcycle",
    tagline: "Built for the miles that matter.",
    railImage: IMG.road,
    railAlt: "A two-lane road curving through wooded hills",
    questions: [
      {
        id: "use_context",
        question: "Where will you ride?",
        help: "Select all that apply. Your answers help us put the most relevant information first.",
        options: [
          { value: "local", label: "Close to home", hint: "Around town, shorter rides", image: IMG.valley, alt: "A rural road through a river valley" },
          { value: "weekend", label: "Weekends and back roads", hint: "Scenic rides, day trips", image: IMG.sunset, alt: "Evening light over forested ridges" },
          { value: "distance", label: "Long distance", hint: "Touring, multi-day trips", image: IMG.road, alt: "An open two-lane road running into the hills" },
          { value: "commute", label: "Getting to work", hint: "Regular miles, most weeks", image: IMG.ridges, alt: "A road through wooded Appalachian ridges" },
        ],
      },
      PRIORITIES,
    ],
  },

  UTILITY_RECREATION: {
    key: "UTILITY_RECREATION",
    label: "utility side-by-side",
    tagline: "Work today. Possibility tomorrow.",
    railImage: IMG.ridges,
    railAlt: "Farm and woodland along an Appalachian ridge",
    questions: [
      {
        id: "use_context",
        question: "Where will you use it?",
        help: "Select all that apply. Your answers help us put the most relevant information first.",
        options: [
          { value: "property", label: "Property and farm", hint: "Acreage, woods, outbuildings", image: IMG.ridges, alt: "Farmland running up to a wooded ridge" },
          { value: "trails", label: "Trails", hint: "Trail systems and back country", image: IMG.trail, alt: "A wooded trail through hardwood forest" },
          { value: "work", label: "Work and hauling", hint: "Projects, loads, daily jobs", image: IMG.valley, alt: "A gravel track across open ground" },
          { value: "outdoors", label: "Hunting and the outdoors", hint: "Remote access, seasons", image: IMG.sunset, alt: "Timber and ridgeline at last light" },
        ],
      },
      PRIORITIES,
    ],
  },

  OFF_ROAD_RECREATION: {
    key: "OFF_ROAD_RECREATION",
    label: "off-road machine",
    tagline: "Same roads. New stories.",
    railImage: IMG.trail,
    railAlt: "A wooded trail climbing through hardwood forest",
    questions: [
      {
        id: "use_context",
        question: "Where will you ride it?",
        help: "Select all that apply. Your answers help us put the most relevant information first.",
        options: [
          { value: "trails", label: "Trail systems", hint: "Marked trails and forest roads", image: IMG.trail, alt: "A marked trail through dense woods" },
          { value: "property", label: "Our own ground", hint: "Property, fields, woods", image: IMG.ridges, alt: "Open ground below a wooded ridge" },
          { value: "technical", label: "Rougher going", hint: "Rocks, ruts, steep ground", image: IMG.road, alt: "A rutted track climbing a hillside" },
          { value: "outdoors", label: "Hunting and the outdoors", hint: "Getting in and back out", image: IMG.sunset, alt: "Timber at dusk" },
        ],
      },
      PRIORITIES,
    ],
  },

  YOUTH: {
    key: "YOUTH",
    label: "youth machine",
    tagline: "Confidence today. Bigger tomorrows.",
    railImage: IMG.trail,
    railAlt: "A quiet trail through open woodland",
    questions: [
      {
        id: "use_context",
        question: "Where will they ride?",
        help: "Select all that apply. Your answers help us put the most relevant information first.",
        options: [
          { value: "property", label: "On our property", hint: "Fields, woods, familiar ground", image: IMG.ridges, alt: "Open ground and woodland on a family property" },
          { value: "designated", label: "Designated riding areas", hint: "Parks and OHV areas", image: IMG.trail, alt: "A groomed trail in a riding area" },
          { value: "learning", label: "Still learning", hint: "New to riding", image: IMG.valley, alt: "A level field beside a creek" },
          { value: "family", label: "Family riding", hint: "Weekends, riding together", image: IMG.sunset, alt: "Evening light over a wooded hillside" },
        ],
      },
      PRIORITIES,
    ],
  },

  EQUIPMENT: {
    key: "EQUIPMENT",
    label: "equipment",
    tagline: "More miles. More of what matters.",
    railImage: IMG.valley,
    railAlt: "Cleared ground and outbuildings in a river valley",
    questions: [
      {
        id: "use_context",
        question: "Where will it work?",
        help: "Select all that apply. Your answers help us put the most relevant information first.",
        options: [
          { value: "jobsite", label: "Job sites", hint: "Daily site work", image: IMG.valley, alt: "A cleared work site on level ground" },
          { value: "property", label: "Farm and property", hint: "Maintenance and projects", image: IMG.ridges, alt: "Farm buildings below a wooded ridge" },
          { value: "landscaping", label: "Grounds and landscaping", hint: "Mowing, grading, clearing", image: IMG.sunset, alt: "Mown ground running up to treeline" },
          { value: "multi", label: "More than one site", hint: "Trailered between jobs", image: IMG.road, alt: "A rural road between work sites" },
        ],
      },
      PRIORITIES,
    ],
  },
};

// TecAssured vehicle type codes, as mapped by fni-session-start's
// BODY_TYPE_MAP. A code that is not listed -- trailers, e-bikes, excavators,
// zero turns, tractors -- arrives with no code at all and falls to EQUIPMENT,
// which is the honest default for a machine that works rather than rides.
const BY_CODE: Record<string, ProfileKey> = {
  MCYC: "ON_ROAD",
  SNOW: "ON_ROAD",
  BIKE: "OFF_ROAD_RECREATION",
  ATV: "UTILITY_RECREATION",
  UTV: "UTILITY_RECREATION",
  PWAC: "OFF_ROAD_RECREATION",
  BOAT: "OFF_ROAD_RECREATION",
};

/**
 * The profile for a session's machine.
 *
 * The youth variant needs a signal the session does not carry. TecAssured has
 * no distinct youth vehicle type in the mapping fni-session-start uses, and
 * guessing from a model name would mislabel adult machines -- so an ATV gets
 * the utility profile and the youth copy stays unreachable until a real signal
 * exists (a youth type code, or engine displacement on the session). The
 * override argument is that signal's way in when it arrives; it is also what
 * lets the flow be exercised across categories.
 */
export function profileFor(
  vehicleTypeCode: string | null,
  override?: string | null
): VehicleProfile {
  if (override && override.toUpperCase() in PROFILES) {
    return PROFILES[override.toUpperCase() as ProfileKey];
  }
  const key = vehicleTypeCode
    ? BY_CODE[vehicleTypeCode.toUpperCase()]
    : undefined;
  return PROFILES[key ?? "EQUIPMENT"];
}

/**
 * Relevance score for ordering, never for filtering.
 *
 * A product scores for each discovery answer that appears in its catalog
 * relevance_tags, and again when its catalog goal is one the customer said
 * matters. Both sides come from store data, so a store changes what is
 * relevant by editing its catalog rather than by shipping code.
 */
export function relevanceScore(
  tags: string[] | null | undefined,
  goal: string | null | undefined,
  answers: string[]
): number {
  if (answers.length === 0) return 0;
  const chosen = new Set(answers.map((a) => a.toLowerCase()));
  let score = 0;
  for (const t of tags ?? []) if (chosen.has(t.toLowerCase())) score += 1;
  if (goal && chosen.has(goal.toLowerCase())) score += 1;
  return score;
}

export { PROFILES };
