// _shared/adapters/tecassured.ts
//
// The TecAssured adapter: Riders Advantage, rated through the TecAssured API.
//
// It wraps the existing client and changes nothing it sends or receives: the
// required properties come from the overnight cache (or live when the cache is
// cold), the request is built by buildRateRequest, and the quote is read by
// tecAssuredOffers. What used to be steps 4 to 6 of fni-rate-vehicle, with the
// same messages, so staff read the same reasons they always have.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EndpointNotFoundError, ProviderHttpError, type StoreClient } from "../tecassured.ts";
import { providerAnswer } from "../provider-answer.ts";
import {
  parseRequiredProperties,
  readRateProperties,
  writeRateProperties,
  type RequiredProperty,
} from "../rate-properties.ts";
import { buildRateRequest, type RateSource } from "../rate-request.ts";
import { formCodesFromQuote, type FormCodes } from "../coded-values.ts";
import { engineSizeProblem, resolveEngineCc } from "../engine-size.ts";
import { brandFor, effectiveMake, makesFromResponse, spellingFor, type Brand, type BrandGroup, type ProviderMake, type Spelling } from "../brands.ts";
import { parseStaffEdits } from "../staff-edits.ts";
import { resolveVehicleType } from "../vehicle-types.ts";
import { rateLineCount, responseBytes, type RateTiming } from "../rate-timing.ts";

/** How old the provider's makes list may be before rating asks for it again. */
const MAKES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
import type { OfferProvider } from "../normalized-offer.ts";
import { tecAssuredOffers } from "./tecassured-offers.ts";
import type { ProviderAdapter, RateResult } from "./types.ts";

/** What a TecAssured attempt adds to its result, for the caller's response. */
export interface TecAssuredDetail {
  vtype: string | null;
  dealer_code: string;
  /** Properties requiredproperties named that the deal did not carry. */
  unsupplied: string[];
  /** The provider's own refusal, when it refused. */
  refusal: string | null;
}

export function tecAssuredAdapter(
  supabase: SupabaseClient,
  store: StoreClient,
  provider: OfferProvider,
  rateSource: Record<string, unknown>,
  /** Step timing for "Rated again" (_shared/rate-timing.ts). Measuring only. */
  timing?: RateTiming
): ProviderAdapter & { detail: TecAssuredDetail } {
  const vtype = (rateSource.vehicle_type_code as string | null) ?? null;
  const detail: TecAssuredDetail = {
    vtype,
    dealer_code: store.dealerCode,
    unsupplied: [],
    refusal: null,
  };

  let cachedRequired: RequiredProperty[] | null = null;
  // The provider's codes as its form last stated them for this vehicle type
  // (migration 0051). Null until a quote has been seen: the documented codes.
  let formCodes: FormCodes | null = null;

  /**
   * The make to send: the deal's brand in this provider server's spelling.
   * Null when no brands are set up (the make goes out as it is). A refusal
   * when the make is not a brand yet: staff must pick or confirm it.
   */
  /** What the make needs, read together: brands, groupings, settled spellings and the stored makes list. Only reads. */
  async function brandReads(src: Record<string, unknown>) {
    const tenantId = String(src.tenant_id ?? "");
    const environment = store.credentials.environment === "Live" ? "Live" : "Test";
    const [{ data: brandRows }, { data: groupRows }, { data: settled }, makes] = await Promise.all([
      supabase.schema("fni").from("brands").select("name, aliases, active").eq("tenant_id", tenantId),
      supabase.schema("fni").from("brand_groups").select("parent_name, brand_name, vehicle_types, preferred").eq("tenant_id", tenantId),
      supabase.schema("fni").from("brand_spellings")
        .select("provider_id, environment, vtype, brand_name, spelling").eq("provider_id", provider.id).eq("environment", environment),
      readMakes(environment),
    ]);
    return { brandRows, groupRows, settled, makes, environment };
  }

  async function providerMake(
    src: Record<string, unknown>,
    read: Awaited<ReturnType<typeof brandReads>>
  ): Promise<{ make: string | null } | { refusal: string }> {
    const { brandRows, groupRows } = read;
    const brands = (brandRows ?? []) as Brand[];
    if (brands.length === 0) return { make: null };
    const edits = parseStaffEdits(src.staff_edits);
    const choice = edits.unit_make?.value ?? null;
    const crm = choice !== null ? edits.unit_make?.original ?? null : src.unit_make;
    const vt = resolveVehicleType(src).type;
    const m = effectiveMake(crm, choice, vt === "Other" ? null : vt, brands, (groupRows ?? []) as BrandGroup[]);
    if (m.status !== "brand") return { refusal: m.message };
    const brand = brandFor(m.brand, brands)!;

    const environment = read.environment;
    const where = { provider_id: provider.id, environment, vtype: vtype ?? "" };
    const listed = await makesList(environment, read.makes);
    return { make: spellingFor(brand, where, (read.settled ?? []) as Spelling[], listed).spelling };
  }

  /** The stored makes list for this provider server and dealer (fni.provider_makes). */
  async function readMakes(environment: string): Promise<(ProviderMake & { fetched_at: string })[]> {
    const { data } = await supabase.schema("fni").from("provider_makes")
      .select("provider_id, environment, vtype, make, fetched_at")
      .eq("provider_id", provider.id).eq("environment", environment).eq("dealer_code", store.dealerCode);
    return (data ?? []) as (ProviderMake & { fetched_at: string })[];
  }

  /**
   * The provider's makes list for this server and dealer (fni.provider_makes),
   * asked for again when missing or over a week old. Best effort: rating never
   * fails for want of it, and the brand's own name is sent instead.
   */
  async function makesList(
    environment: string,
    stored: (ProviderMake & { fetched_at: string })[]
  ): Promise<ProviderMake[]> {
    let rows = stored;
    const oldest = rows.reduce((t, r) => Math.min(t, Date.parse(r.fetched_at)), Infinity);
    if (rows.length === 0 || Date.now() - oldest > MAKES_MAX_AGE_MS) {
      try {
        const fresh = makesFromResponse(await store.client.getMakes(store.dealerCode));
        if (fresh.length > 0) {
          const now = new Date().toISOString();
          await supabase.schema("fni").from("provider_makes").upsert(
            fresh.map((f) => ({ provider_id: provider.id, environment, dealer_code: store.dealerCode, vtype: f.vtype, make: f.make, fetched_at: now })),
            { onConflict: "provider_id,environment,dealer_code,vtype,make" },
          );
          rows = await readMakes(environment);
        }
      } catch {
        // The list as it was, or none: spellingFor falls back to the brand's name.
      }
    }
    return rows;
  }

  /** Cached overnight by fni-refresh-rate-properties; live when cold. */
  async function required(): Promise<RequiredProperty[]> {
    if (cachedRequired) return cachedRequired;
    if (!vtype) return [];
    const cached = await readRateProperties(supabase, store.account.id, vtype);
    const seen = cached?.form_codes;
    formCodes = seen && typeof seen === "object" && !Array.isArray(seen) ? (seen as FormCodes) : null;
    cachedRequired =
      cached && cached.status === "Cached"
        ? parseRequiredProperties(cached.properties).properties
        : (await writeRateProperties(
            supabase,
            store.account.id,
            vtype,
            await store.client.getRequiredProperties(vtype)
          )).properties;
    return cachedRequired;
  }

  return {
    detail,

    async requiredInputs() {
      return (await required()).map((p) => p.name);
    },

    async rate(): Promise<RateResult> {
      if (!vtype) {
        return {
          state: "Failed",
          reason:
            "No TecAssured vehicle type for this unit. The deal's body type is " +
            "either blank or not in BODY_TYPE_MAP (_shared/vehicle-types.ts), so " +
            "there is nothing to ask the provider about.",
        };
      }

      // The brand's inputs are read while the rate properties are: both are
      // only reads. The make is still settled after the properties, as before,
      // and the provider's makes list is fetched only once a brand is settled.
      const brandRead = brandReads(rateSource);
      brandRead.catch(() => {});

      let props: RequiredProperty[];
      try {
        props = await required();
      } catch (err) {
        return {
          state: "Failed",
          reason:
            err instanceof EndpointNotFoundError
              ? `TecAssured's ${err.url} is not answering, so the properties needed to ` +
                `rate a ${vtype} cannot be determined.`
              : `Could not determine what TecAssured needs to rate a ${vtype}: ` +
                (err instanceof Error ? err.message : String(err)),
        };
      }

      timing?.mark("rate properties ready");

      if (props.length === 0) {
        return {
          state: "Not Offered",
          reason: `Dealer ID ${store.dealerCode} has no rateable products for vehicle type ${vtype}.`,
          response: { requiredproperties: [], vtype, dealer_code: store.dealerCode },
        };
      }

      // ── The brand, and the provider's spelling of it ─────────────────────
      // (_shared/brands.ts). A make that is not a settled brand stops here,
      // with the reason staff see on Details; a brand goes out spelled the way
      // this provider server accepts it. Without brands set up, as before.
      const branded = await providerMake(rateSource, await brandRead);
      timing?.mark("brand and makes list ready");
      if ("refusal" in branded) return { state: "Failed", reason: branded.refusal };
      const source = branded.make === null ? rateSource : { ...rateSource, unit_make: branded.make };

      const built = buildRateRequest(props, source as unknown as RateSource, {
        dealerCode: store.dealerCode,
        vtype,
        formCodes,
      });
      detail.unsupplied = built.missing.map((m) => m.name);
      // A deal date that will not do stops the rate here, before anything is
      // sent: no date is ever made up to fill the gap (_shared/deal-dates.ts).
      if (built.dateProblem) return { state: "Failed", reason: built.dateProblem };
      // A value the provider's form has no code for stops the rate here, rather
      // than going out as a word the provider ignores (_shared/coded-values.ts).
      if (built.codeProblem) return { state: "Failed", reason: built.codeProblem };
      // Engine size above 0 wherever the form asks for it: with 0 the provider
      // drops every Mechanical Protection plan without a word (_shared/engine-size.ts).
      if (props.some((p) => p.name.toLowerCase() === "engine.ccs")) {
        const cc = resolveEngineCc(rateSource.vehicle_properties, rateSource.vin_decode)?.value ?? null;
        const problem = engineSizeProblem(cc);
        if (problem) return { state: "Failed", reason: problem };
      }
      const request = built.request;
      timing?.mark("rate request built");
      // Only while timing: the login on its own, so its time is not mixed
      // into the provider's. The same session the rate call would get.
      let sessionBefore: string | null = null;
      if (timing && typeof store.client.getSession === "function") {
        try {
          const auth = await store.client.getSession();
          timing.note("provider_login", auth.fromCache ? "cached" : "fresh");
        } catch {
          timing.note("provider_login", "failed");
        }
        sessionBefore = store.client.sessionId;
        timing.mark("provider login ready");
      }
      // A call that never answers still says what it asked, so a failed
      // re-rate can show it was about the same deal as the offers kept
      // (_shared/rerate.ts).
      let response: unknown;
      try {
        timing?.mark("rate request sent");
        response = await store.client.rateVehicle(request);
        if (timing) {
          timing.mark("rate response received");
          timing.note("response_bytes", responseBytes(response));
          timing.note("rate_lines", rateLineCount(response));
          // A refused session is retried after a fresh login inside the call.
          timing.note("provider_login_retried", sessionBefore !== null && store.client.sessionId !== sessionBefore);
        }
      } catch (err) {
        timing?.mark("rate request failed");
        return {
          state: "Failed",
          request,
          reason: `Rating failed: ${err instanceof Error ? err.message : String(err)}`,
          // An answer the provider gave as a failure: its status, request ID
          // and body, redacted, kept with the attempt (_shared/provider-answer.ts).
          // A refusal sent as HTTP 200 is kept whole below, as before.
          ...(err instanceof ProviderHttpError
            ? {
                response: providerAnswer({
                  kind: "Rating failed",
                  http_status: err.exchange.status,
                  request_ids: err.exchange.request_ids,
                  body: err.exchange.raw,
                }),
              }
            : {}),
        };
      }

      // TecAssured answers a rejected request with HTTP 200 and an error string.
      if (response && typeof response === "object") {
        const err = (response as Record<string, unknown>).error;
        if (typeof err === "string" && err.trim() !== "") {
          detail.refusal = err.trim();
          const unsupplied = built.missing.map((m) => m.description ?? m.name).join(", ");
          return {
            state: "Failed",
            request,
            response,
            reason:
              `TecAssured refused the rate request: ${err.trim()}` +
              (unsupplied === ""
                ? ""
                : ` The deal does not carry ${unsupplied}; enter ${built.missing
                    .map((m) => m.name)
                    .join(", ")} on the session (vehicle_properties) and rate again.`),
          };
        }
      }

      // Keep the codes this quote's form states, for the next rating of this
      // vehicle type. Best effort: a rating never fails for want of it.
      const stated = formCodesFromQuote(response);
      if (stated) {
        try {
          await supabase.schema("fni").from("store_rate_properties")
            .update({ form_codes: stated, form_codes_at: new Date().toISOString() })
            .eq("store_provider_account_id", store.account.id)
            .eq("vtype", vtype);
        } catch {
          // The documented codes, or the last ones kept, serve until next time.
        }
      }

      timing?.mark("form codes kept");

      const offers = tecAssuredOffers(response, provider);
      timing?.mark("offers read from the response");
      return offers.length > 0
        ? { state: "Rated", offers, request, response }
        : {
            state: "Not Offered",
            reason: "TecAssured accepted the request and offered nothing for this unit.",
            request,
            response,
          };
    },
  };
}
