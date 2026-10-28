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
  rateSource: Record<string, unknown>
): ProviderAdapter & { detail: TecAssuredDetail } {
  const vtype = (rateSource.vehicle_type_code as string | null) ?? null;
  const detail: TecAssuredDetail = {
    vtype,
    dealer_code: store.dealerCode,
    unsupplied: [],
    refusal: null,
  };

  let cachedRequired: RequiredProperty[] | null = null;

  /** Cached overnight by fni-refresh-rate-properties; live when cold. */
  async function required(): Promise<RequiredProperty[]> {
    if (cachedRequired) return cachedRequired;
    if (!vtype) return [];
    const cached = await readRateProperties(supabase, store.account.id, vtype);
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

      if (props.length === 0) {
        return {
          state: "Not Offered",
          reason: `Dealer ID ${store.dealerCode} has no rateable products for vehicle type ${vtype}.`,
          response: { requiredproperties: [], vtype, dealer_code: store.dealerCode },
        };
      }

      const built = buildRateRequest(props, rateSource as unknown as RateSource, {
        dealerCode: store.dealerCode,
        vtype,
      });
      detail.unsupplied = built.missing.map((m) => m.name);
      // A deal date that will not do stops the rate here, before anything is
      // sent: no date is ever made up to fill the gap (_shared/deal-dates.ts).
      if (built.dateProblem) return { state: "Failed", reason: built.dateProblem };
      const request = built.request;
      // A call that never answers still says what it asked, so a failed
      // re-rate can show it was about the same deal as the offers kept
      // (_shared/rerate.ts).
      let response: unknown;
      try {
        response = await store.client.rateVehicle(request);
      } catch (err) {
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

      const offers = tecAssuredOffers(response, provider);
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
