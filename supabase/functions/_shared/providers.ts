// _shared/providers.ts
//
// F&I providers: the words they are stored with, and the rules that read them.
// See docs/multi-provider.md.
//
// Every value here is what a person reads. A provider's kind is "Connected" or
// "Price Sheet", never a code, so the admin area, the database and a log line
// all say the same thing.
//
// Its own file, with no remote imports, so it can be tested from Node.

/** Connected providers have an API; Price Sheet providers are rated from
 *  uploaded, published price sheets. */
export const PROVIDER_KINDS = ["Connected", "Price Sheet"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** How a contract is written: through the provider's API, or by staff in the
 *  provider's own portal and then recorded here. */
export const CONTRACT_METHODS = ["Through API", "Recorded by Staff"] as const;
export type ContractMethod = (typeof CONTRACT_METHODS)[number];

/** The adapters a Connected provider can name. */
export const ADAPTERS = ["TecAssured"] as const;
export type AdapterName = (typeof ADAPTERS)[number];

/** What a product is for. The catalog's category column holds one of these. */
export const CATEGORIES = [
  "Mechanical Protection",
  "Maintenance",
  "Tire and Wheel",
  "Theft",
  "Battery",
  "Appearance",
  "Other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Provider {
  id: string;
  tenant_id: string;
  name: string;
  kind: ProviderKind;
  /** For Connected: the adapter that talks to its API. Null for Price Sheet. */
  adapter: AdapterName | null;
  contract_method: ContractMethod;
  /** The vehicle makes whose OEM program this is. Empty for aftermarket. */
  makes: string[];
  active: boolean;
  notes: string | null;
}

/** A make as compared: trimmed, single-spaced, lower case. */
export function normalizeMake(make: string | null | undefined): string {
  return (make ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Whether a vehicle's make is one of a provider's makes. Case and spacing do
 * not matter: "CAN-AM", "Can-Am" and " can-am " are one make. A provider with
 * no makes is aftermarket and is not tied to any make.
 */
export function makeMatches(makes: readonly string[], make: string | null | undefined): boolean {
  const m = normalizeMake(make);
  if (m === "") return false;
  return makes.some((x) => normalizeMake(x) === m);
}

/** Whether a stored value is one of the kinds, methods or categories. */
export function isProviderKind(v: unknown): v is ProviderKind {
  return typeof v === "string" && (PROVIDER_KINDS as readonly string[]).includes(v);
}
export function isContractMethod(v: unknown): v is ContractMethod {
  return typeof v === "string" && (CONTRACT_METHODS as readonly string[]).includes(v);
}
export function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}
