// _shared/tecassured.ts
// TecAssured REST API client with PBKDF2 authentication and session caching.
//
// ── One login, many dealers (2026-09-25) ────────────────────────────────
// TecAssured confirmed that one login covers the whole of Riders Advantage and
// that each store is identified by its own Dealer ID, sent as `dealerCode` on
// every request. This module used to assume the opposite: credentials were
// looked up BY STORE, and the dealer code was a column on the credential row.
//
// Two things follow from the correction, and both are load-bearing here:
//
//   The session belongs to the LOGIN.  A session is what authenticating buys,
//   and authenticating is per account, so nine stores on one account share one
//   session. Caching per store would mean nine logins to do the work of one,
//   and nine rows racing to overwrite the same cached session.
//
//   The dealer code belongs to the STORE.  It is resolved through
//   fni.store_provider_accounts and carried on the client, so a caller that
//   holds a client for a store cannot accidentally send another store's
//   Dealer ID.
//
// Migration 0009 is the schema half of this; 0011 replaced the vehicle-types
// cache with fni.store_rate_properties.
//
// ── What this client talks to ──────────────────────────────────────
// Seven endpoints, all verified present on the QA server:
//   /auth/loginrequest   /auth/loginassertion
//   /rate                /rate/requiredproperties
//   /contract/submit     /contract/document        /contract/void
// /rate/vehicletypes is NOT among them and has been removed.
// See _shared/TECASSURED_SHOP_API.md.
//
// ── Provenance ─────────────────────────────────────────────────────────
// Brought into the repository on 2026-09-20 after only ever being deployed out
// of band. The five functions that were in that same state -- fni-health-check,
// fni-refresh-vehicle-types, fni-session-start, fni-rate-vehicle and
// fni-contract-submit -- were brought in alongside this rewrite, so a clean
// checkout can now deploy all of them.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Types ───────────────────────────────────────────────────────────────

/** One provider ACCOUNT. No store and no dealer code: both moved to the mapping. */
export interface TecAssuredCredentials {
  id: string;
  tenant_id: string;
  provider: string;
  environment: "Test" | "Live";
  username: string;
  /** Plaintext despite the name -- see the column comment in migration 0009. */
  password_encrypted: string;
  api_base_url: string;
  active: boolean;
  session_id_cached: string | null;
  session_expires_at: string | null;
  updated_at: string;
}

/** One store's identity on an account. */
export interface StoreProviderAccount {
  id: string;
  store_id: string;
  credential_id: string;
  provider: string;
  dealer_code: string;
  active: boolean;
}

export interface LoginRequestResponse { nonce: string; digest: string; salt: string; }
export interface LoginAssertionResponse { fullName: string; sessionId: string; identifier: number; }
export interface AuthResult { sessionId: string; fromCache: boolean; }

/** What a caller gets for a store: the shared login, and this store's identity on it. */
export interface StoreClient {
  client: TecAssuredClient;
  credentials: TecAssuredCredentials;
  account: StoreProviderAccount;
  dealerCode: string;
}

// ─── Hex utilities ───────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── PBKDF2 token generation ─────────────────────────────────────────────
// SHA-1 and 1000 iterations are TecAssured's parameters, not a choice: the
// server computes the same digest and compares. Neither is ours to strengthen.

async function generatePBKDF2Token(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(salt), iterations: 1000, hash: "SHA-1" },
    keyMaterial,
    64 * 8
  );
  return bytesToHex(new Uint8Array(derivedBits));
}

// ─── Recognising a refused session ───────────────────────────────────────
//
// TecAssured answers a bad session with HTTP 200 and an error string rather
// than a 401, so the only way to tell "your session is stale" from a real
// result is to read the body. Matched on the two stable words rather than the
// whole sentence, which is theirs to reword.

function sessionRefusalText(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const err = (parsed as Record<string, unknown>).error;
  return typeof err === "string" ? err : "";
}

function isSessionRefusal(parsed: unknown): boolean {
  const text = sessionRefusalText(parsed);
  return text !== "" && /invalid session|session\s*id|logging in again/i.test(text);
}

/**
 * The path is not there.
 *
 * Its own type because it is not a failure of the request: no retry, no
 * re-auth and no credential change will make a missing endpoint appear, and a
 * caller that can carry on without this particular call needs to be able to
 * tell it apart from one that genuinely failed.
 */
export class EndpointNotFoundError extends Error {
  constructor(readonly url: string) {
    super(`TecAssured endpoint not found: ${url}`);
    this.name = "EndpointNotFoundError";
  }
}

// ─── The client ──────────────────────────────────────────────────────────

export class TecAssuredClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private credentialId: string;
  private supabase: SupabaseClient;
  private _sessionId: string | null = null;
  private _expiresAt: string | null = null;

  /**
   * This store's Dealer ID, when the client was built for a store.
   *
   * Null for a client built from a credential alone, which is the right shape
   * for fni-health-check's login test: proving the account works is a question
   * about the account, and answering it does not require being any dealer.
   */
  readonly dealerCode: string | null;

  /** Serializes concurrent re-auth so N stores cannot trigger N logins. */
  private authInFlight: Promise<AuthResult> | null = null;

  /** Called after every successful login, so a shared cache can follow along. */
  private onAuthenticated: ((client: TecAssuredClient) => void) | null;

  constructor(
    credentials: TecAssuredCredentials,
    supabase: SupabaseClient,
    dealerCode: string | null = null,
    onAuthenticated: ((client: TecAssuredClient) => void) | null = null
  ) {
    this.baseUrl = credentials.api_base_url.replace(/\/+$/, "");
    this.username = credentials.username;
    this.password = credentials.password_encrypted;
    this.credentialId = credentials.id;
    this.supabase = supabase;
    this._sessionId = credentials.session_id_cached;
    this._expiresAt = credentials.session_expires_at;
    this.dealerCode = dealerCode;
    this.onAuthenticated = onAuthenticated;
  }

  get sessionId(): string | null { return this._sessionId; }
  get expiresAt(): string | null { return this._expiresAt; }

  private isCachedSessionValid(): boolean {
    if (!this._sessionId || !this._expiresAt) return false;
    return new Date(this._expiresAt) > new Date();
  }

  /** Full authentication: loginrequest -> PBKDF2 -> loginassertion. */
  async authenticate(): Promise<AuthResult> {
    // Ten stores hitting an expired session at once should produce one login,
    // not ten. Whoever gets here first does the work; the rest await it.
    if (this.authInFlight) return await this.authInFlight;

    this.authInFlight = this.doAuthenticate().finally(() => {
      this.authInFlight = null;
    });
    return await this.authInFlight;
  }

  private async doAuthenticate(): Promise<AuthResult> {
    const loginReqRes = await fetch(`${this.baseUrl}/auth/loginrequest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.username }),
    });
    if (!loginReqRes.ok) {
      const text = await loginReqRes.text();
      throw new Error(`TecAssured loginrequest failed (${loginReqRes.status}): ${text}`);
    }
    const loginReq: LoginRequestResponse = await loginReqRes.json();

    const token = await generatePBKDF2Token(this.password, loginReq.salt);

    const assertRes = await fetch(`${this.baseUrl}/auth/loginassertion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: loginReq.nonce, token }),
    });
    if (!assertRes.ok) {
      const text = await assertRes.text();
      throw new Error(`TecAssured loginassertion failed (${assertRes.status}): ${text}`);
    }
    const assertion: LoginAssertionResponse = await assertRes.json();
    if (assertion.identifier === -1) {
      throw new Error("TecAssured authentication failed: invalid credentials");
    }

    this._sessionId = assertion.sessionId;
    // 25 minutes against TecAssured's 30, so the session is replaced before it
    // is refused rather than after.
    this._expiresAt = new Date(Date.now() + 25 * 60 * 1000).toISOString();

    await this.supabase
      .schema("fni")
      .from("provider_credentials")
      .update({ session_id_cached: this._sessionId, session_expires_at: this._expiresAt })
      .eq("id", this.credentialId);

    this.onAuthenticated?.(this);

    return { sessionId: this._sessionId, fromCache: false };
  }

  /** A valid session, from cache when there is one. */
  async getSession(): Promise<AuthResult> {
    if (this.isCachedSessionValid()) {
      return { sessionId: this._sessionId!, fromCache: true };
    }
    return await this.authenticate();
  }

  async invalidateSession(): Promise<void> {
    this._sessionId = null;
    this._expiresAt = null;
    await this.supabase
      .schema("fni")
      .from("provider_credentials")
      .update({ session_id_cached: null, session_expires_at: null })
      .eq("id", this.credentialId);
  }

  /**
   * Generic call, with one re-auth and retry on a refused session.
   *
   * ── TecAssured refuses a session with 200, not 401 ────────────────────
   * Verified against the QA server on 2026-09-25: a call with a bad sessionId
   * comes back HTTP 200 with {"error":"Invalid Session Id, please try logging
   * in again"} in the body. The 401/403 branch this method was built around
   * therefore never fires, and before this change an expired session was
   * returned to the caller as a successful result whose payload happened to be
   * an error object -- which fni-rate-vehicle would have stored in
   * rated_offers as though it were an offer.
   *
   * The status check is kept: a transport-level 401 is still a 401. The body
   * check is what actually catches it.
   */
  async apiCall<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    if (!this.isCachedSessionValid()) await this.getSession();

    const url = `${this.baseUrl}${path}`;
    const send = () =>
      fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(body ?? {}), sessionId: this._sessionId }),
      });

    const res = await send();

    // A 404 is the path, not the session. Retrying it just asks the same
    // missing endpoint twice, so it is surfaced as what it is.
    if (res.status === 404) {
      throw new EndpointNotFoundError(`${this.baseUrl}${path}`);
    }

    const refusedByStatus = res.status === 401 || res.status === 403;
    let parsed: unknown = null;

    if (!refusedByStatus) {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`TecAssured API call failed (${res.status}): ${text}`);
      }
      parsed = await res.json();
      if (!isSessionRefusal(parsed)) return parsed as T;
    }

    // ── The fall-through ───────────────────────────────────────────
    // A refused session ALWAYS lands here, whether it was refused by status or
    // by the body, and it always leads to a fresh login and exactly one retry.
    // No path above can hand a refusal back to the caller.
    //
    // This fires more often than an expiry clock would explain. TecAssured's
    // sessions appear to be bound to the calling IP, and an Edge Function's
    // outbound address is not stable between invocations -- so a session cached
    // twenty seconds ago by one isolate can be refused for the next, with no
    // expiry involved. The 25-minute cache is still worth having; this path is
    // what makes relying on it safe.
    //
    // Logged on one stable marker so the frequency is countable rather than
    // guessed at. In the Supabase log explorer, over edge_logs:
    //   event_message like '%TECASSURED_SESSION_REFUSED%'
    // and retry=succeeded vs retry=refused separates "normal, handled" from
    // "something is actually wrong with the account".
    const refusedBy = refusedByStatus ? `status ${res.status}` : sessionRefusalText(parsed);
    const mark = (outcome: string) =>
      console.warn(
        `TECASSURED_SESSION_REFUSED credential=${this.credentialId} path=${path} ` +
          `refused_by=${JSON.stringify(refusedBy)} retry=${outcome}`
      );

    await this.invalidateSession();
    await this.authenticate();

    const retryRes = await send();
    if (retryRes.status === 404) {
      throw new EndpointNotFoundError(`${this.baseUrl}${path}`);
    }
    if (!retryRes.ok) {
      const text = await retryRes.text();
      mark(`failed status=${retryRes.status}`);
      throw new Error(`TecAssured API call failed after re-auth (${retryRes.status}): ${text}`);
    }

    const retryParsed = await retryRes.json();

    if (isSessionRefusal(retryParsed)) {
      // A login that had just succeeded, refused on the very next call. That is
      // not a session problem any more, so it is not retried a second time.
      mark("refused");
      throw new Error(
        `TecAssured refused the session immediately after a successful login: ` +
          `${sessionRefusalText(retryParsed)}`
      );
    }

    mark("succeeded");
    return retryParsed as T;
  }

  /**
   * The Dealer ID to send: the one carried, or an explicit override.
   *
   * Throwing rather than omitting is deliberate. A request with no dealerCode
   * is not a request for "all dealers" -- it is a request TecAssured will
   * answer for whichever dealer it decides we are, and a contract submitted
   * under the wrong Dealer ID is a real document with the wrong dealer's name.
   */
  private dealer(override?: string): string {
    const code = override ?? this.dealerCode;
    if (!code) {
      throw new Error(
        "No Dealer ID for this call. Build the client with createTecAssuredClient(storeId) " +
          "so it carries the store's Dealer ID, or pass one explicitly."
      );
    }
    return code;
  }

  // ─── Endpoints ─────────────────────────────────────────────────────────

  /**
   * The property names this dealer needs to rate this vehicle type.
   *
   * This is the endpoint the rate request is built from, and the reason the
   * request is a properties array rather than a set of named fields. The names
   * are dotted and lowercase (engine.ccs, finance.amount, sale.date) and the
   * set differs by vehicle type -- UTV needs inservice.date, MCYC does not.
   *
   * /rate/vehicletypes used to sit here. It does not exist on the server under
   * any spelling or method, so it has been removed rather than left as a method
   * that can only throw. This call answers the more useful question anyway, and
   * a vtype the dealer does not sell comes back with nothing, which is the same
   * information the missing endpoint would have given.
   *
   * See _shared/TECASSURED_SHOP_API.md.
   */
  async getRequiredProperties(vtype: string, dealerCode?: string): Promise<unknown> {
    return await this.apiCall("POST", "/rate/requiredproperties", {
      dealerCode: this.dealer(dealerCode),
      vtype,
    });
  }

  /** The rate request carries its own dealerCode; callers build it from `dealerCode`. */
  async rateVehicle(rateRequest: Record<string, unknown>): Promise<unknown> {
    return await this.apiCall("POST", "/rate", rateRequest);
  }

  async submitContract(submitRequest: Record<string, unknown>): Promise<unknown> {
    return await this.apiCall("POST", "/contract/submit", submitRequest);
  }

  async getContractDocument(
    productId: string | number,
    contractNumber: string,
    dealerCode?: string
  ): Promise<unknown> {
    return await this.apiCall("POST", "/contract/document", {
      dealerCode: this.dealer(dealerCode),
      productId,
      contractNumber,
    });
  }

  async voidContract(
    productId: string | number,
    contractNumber: string,
    dealerCode?: string
  ): Promise<unknown> {
    return await this.apiCall("POST", "/contract/void", {
      dealerCode: this.dealer(dealerCode),
      productId,
      contractNumber,
    });
  }
}

// ─── Session sharing across stores in one invocation ─────────────────────
//
// A client is cached per credential so that a loop over nine stores logs in
// once. The key carries the credential's updated_at, so a rotated password
// produces a new key rather than a warm isolate holding the old one -- these
// maps outlive a request.
//
// dealerCode is NOT part of the cached object: each store gets its own thin
// client sharing the cached one's session, which is what "one session, many
// dealer codes" means in practice.

const sessionsByCredential = new Map<string, { sessionId: string | null; expiresAt: string | null }>();

function cacheKey(cred: TecAssuredCredentials): string {
  return `${cred.id}:${cred.updated_at}`;
}

/**
 * Build a client, reusing any session already established for this credential
 * in this isolate.
 */
export function clientFor(
  cred: TecAssuredCredentials,
  supabase: SupabaseClient,
  dealerCode: string | null = null
): TecAssuredClient {
  const shared = sessionsByCredential.get(cacheKey(cred));

  // A session held in memory is at least as fresh as the row, and after a
  // re-auth it is fresher.
  const withShared: TecAssuredCredentials = shared
    ? { ...cred, session_id_cached: shared.sessionId, session_expires_at: shared.expiresAt }
    : cred;

  // Whatever session this client establishes goes back into the shared slot,
  // so the next store in the loop starts from it rather than logging in again.
  return new TecAssuredClient(withShared, supabase, dealerCode, (c) =>
    sessionsByCredential.set(cacheKey(cred), {
      sessionId: c.sessionId,
      expiresAt: c.expiresAt,
    })
  );
}

/** Forget cached sessions. Tests and a credential change; nothing else needs it. */
export function resetSessionCache(): void {
  sessionsByCredential.clear();
}

// ─── Factories ───────────────────────────────────────────────────────────

/**
 * The client for a store: store -> active mapping -> account.
 *
 * Both halves must be active. An inactive mapping is a store that has been
 * taken off the provider, and an inactive credential is an account that has
 * been retired; neither should quietly keep working because the other is fine.
 */
export async function createTecAssuredClient(
  storeId: string,
  supabase: SupabaseClient,
  provider = "TecAssured"
): Promise<StoreClient> {
  const { data: account, error: accErr } = await supabase
    .schema("fni")
    .from("store_provider_accounts")
    .select("*")
    .eq("store_id", storeId)
    .eq("provider", provider)
    .eq("active", true)
    .maybeSingle();

  if (accErr) {
    throw new Error(`Failed to read ${provider} mapping for store ${storeId}: ${accErr.message}`);
  }
  if (!account) {
    throw new Error(
      `Store ${storeId} has no active ${provider} mapping. ` +
        `Add a row to fni.store_provider_accounts with this store's Dealer ID.`
    );
  }

  const acct = account as unknown as StoreProviderAccount;

  const { data: cred, error: credErr } = await supabase
    .schema("fni")
    .from("provider_credentials")
    .select("*")
    .eq("id", acct.credential_id)
    .eq("active", true)
    .maybeSingle();

  if (credErr) {
    throw new Error(`Failed to read ${provider} credential ${acct.credential_id}: ${credErr.message}`);
  }
  if (!cred) {
    throw new Error(
      `Store ${storeId} maps to ${provider} credential ${acct.credential_id}, which is missing or inactive.`
    );
  }

  const credentials = cred as unknown as TecAssuredCredentials;

  return {
    client: clientFor(credentials, supabase, acct.dealer_code),
    credentials,
    account: acct,
    dealerCode: acct.dealer_code,
  };
}

/**
 * The client for an account, with no store and therefore no Dealer ID.
 *
 * This is what fni-health-check uses to ask "does the login work", which is a
 * question about the account and not about any of its dealers.
 */
export async function createTecAssuredClientByCredentialId(
  credentialId: string,
  supabase: SupabaseClient
): Promise<{ client: TecAssuredClient; credentials: TecAssuredCredentials }> {
  const { data: cred, error } = await supabase
    .schema("fni")
    .from("provider_credentials")
    .select("*")
    .eq("id", credentialId)
    .maybeSingle();

  if (error || !cred) {
    throw new Error(`Credentials not found for ID ${credentialId}: ${error?.message ?? "no such row"}`);
  }

  const credentials = cred as unknown as TecAssuredCredentials;
  return { client: clientFor(credentials, supabase), credentials };
}

/** Every active store mapping on an account, for the two cron jobs. */
export async function activeAccountsForCredential(
  credentialId: string,
  supabase: SupabaseClient
): Promise<StoreProviderAccount[]> {
  const { data, error } = await supabase
    .schema("fni")
    .from("store_provider_accounts")
    .select("*")
    .eq("credential_id", credentialId)
    .eq("active", true);

  if (error) throw new Error(`Failed to list store mappings: ${error.message}`);
  return (data ?? []) as unknown as StoreProviderAccount[];
}
