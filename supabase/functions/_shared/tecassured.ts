// _shared/tecassured.ts
// TecAssured REST API client with PBKDF2 authentication and session caching.
//
// Brought into the repository on 2026-09-20. It had only ever been deployed out
// of band, which made fni-contract-documents un-deployable from a clean
// checkout: the function imports this module and nothing here provided it.
// fni-rate-vehicle, fni-contract-submit, fni-session-start, fni-health-check
// and fni-refresh-vehicle-types are still in that state.
//
// This is the version currently deployed, with one type-only change:
// getContractDocument and voidContract take `string | number` for productId
// rather than `number`. fni.agreement_products.provider_product_id is text, and
// whether TecAssured wants a numeric id or the product code is one of the
// things that cannot be settled until credentials arrive -- so the value is
// passed through as it is stored rather than coerced into a shape we are only
// guessing at. No runtime behaviour changes.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface TecAssuredCredentials {
  id: string;
  store_id: string;
  provider: string;
  username: string;
  password_encrypted: string;
  api_base_url: string;
  dealer_code: string | null;
  session_id_cached: string | null;
  session_expires_at: string | null;
  vehicle_types_cache: unknown | null;
  vehicle_types_cached_at: string | null;
}
export interface LoginRequestResponse { nonce: string; digest: string; salt: string; }
export interface LoginAssertionResponse { fullName: string; sessionId: string; identifier: number; }
export interface AuthResult { sessionId: string; fromCache: boolean; }

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function generatePBKDF2Token(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: hexToBytes(salt), iterations: 1000, hash: "SHA-1" }, keyMaterial, 64 * 8);
  return bytesToHex(new Uint8Array(derivedBits));
}

export class TecAssuredClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private credentialId: string;
  private supabase: SupabaseClient;
  private _sessionId: string | null = null;

  constructor(credentials: TecAssuredCredentials, supabase: SupabaseClient) {
    this.baseUrl = credentials.api_base_url.replace(/\/+$/, "");
    this.username = credentials.username;
    this.password = credentials.password_encrypted;
    this.credentialId = credentials.id;
    this.supabase = supabase;
    this._sessionId = credentials.session_id_cached;
  }

  get sessionId(): string | null { return this._sessionId; }

  private isCachedSessionValid(expiresAt: string | null): boolean {
    if (!this._sessionId || !expiresAt) return false;
    return new Date(expiresAt) > new Date();
  }

  async authenticate(): Promise<AuthResult> {
    const loginReqRes = await fetch(`${this.baseUrl}/auth/loginrequest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: this.username }) });
    if (!loginReqRes.ok) { const text = await loginReqRes.text(); throw new Error(`TecAssured loginrequest failed (${loginReqRes.status}): ${text}`); }
    const loginReq: LoginRequestResponse = await loginReqRes.json();
    const token = await generatePBKDF2Token(this.password, loginReq.salt);
    const assertRes = await fetch(`${this.baseUrl}/auth/loginassertion`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce: loginReq.nonce, token }) });
    if (!assertRes.ok) { const text = await assertRes.text(); throw new Error(`TecAssured loginassertion failed (${assertRes.status}): ${text}`); }
    const assertion: LoginAssertionResponse = await assertRes.json();
    if (assertion.identifier === -1) throw new Error("TecAssured authentication failed: invalid credentials");
    this._sessionId = assertion.sessionId;
    const expiresAt = new Date(Date.now() + 25 * 60 * 1000).toISOString();
    await this.supabase.schema("fni").from("provider_credentials").update({ session_id_cached: this._sessionId, session_expires_at: expiresAt }).eq("id", this.credentialId);
    return { sessionId: this._sessionId, fromCache: false };
  }

  async getSession(credentials: TecAssuredCredentials): Promise<AuthResult> {
    if (this.isCachedSessionValid(credentials.session_expires_at)) return { sessionId: this._sessionId!, fromCache: true };
    return await this.authenticate();
  }

  async invalidateSession(): Promise<void> {
    this._sessionId = null;
    await this.supabase.schema("fni").from("provider_credentials").update({ session_id_cached: null, session_expires_at: null }).eq("id", this.credentialId);
  }

  async apiCall<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    if (!this._sessionId) await this.authenticate();
    const url = `${this.baseUrl}${path}`;
    const payload = body ? { ...body, sessionId: this._sessionId } : { sessionId: this._sessionId };
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (res.status === 401 || res.status === 403) {
      await this.invalidateSession();
      await this.authenticate();
      const retryPayload = body ? { ...body, sessionId: this._sessionId } : { sessionId: this._sessionId };
      const retryRes = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(retryPayload) });
      if (!retryRes.ok) { const text = await retryRes.text(); throw new Error(`TecAssured API call failed after re-auth (${retryRes.status}): ${text}`); }
      return await retryRes.json();
    }
    if (!res.ok) { const text = await res.text(); throw new Error(`TecAssured API call failed (${res.status}): ${text}`); }
    return await res.json();
  }

  async getVehicleTypes(dealerCode: string): Promise<unknown> { return await this.apiCall("POST", "/rate/vehicletypes", { dealerCode }); }
  async getVehicleInputProperties(dealerCode: string, vtype: string): Promise<unknown> { return await this.apiCall("POST", "/rate/requiredproperties", { dealerCode, vtype }); }
  async rateVehicle(rateRequest: Record<string, unknown>): Promise<unknown> { return await this.apiCall("POST", "/rate", rateRequest); }
  async submitContract(submitRequest: Record<string, unknown>): Promise<unknown> { return await this.apiCall("POST", "/contract/submit", submitRequest); }
  async getContractDocument(dealerCode: string, productId: string | number, contractNumber: string): Promise<unknown> { return await this.apiCall("POST", "/contract/document", { dealerCode, productId, contractNumber }); }
  async voidContract(dealerCode: string, productId: string | number, contractNumber: string): Promise<unknown> { return await this.apiCall("POST", "/contract/void", { dealerCode, productId, contractNumber }); }
}

export async function createTecAssuredClient(storeId: string, supabase: SupabaseClient): Promise<{ client: TecAssuredClient; credentials: TecAssuredCredentials }> {
  const { data: credentials, error } = await supabase.schema("fni").from("provider_credentials").select("*").eq("store_id", storeId).eq("provider", "TecAssured").single();
  if (error || !credentials) throw new Error(`No TecAssured credentials found for store ${storeId}: ${error?.message}`);
  return { client: new TecAssuredClient(credentials as TecAssuredCredentials, supabase), credentials: credentials as TecAssuredCredentials };
}

export async function createTecAssuredClientByCredentialId(credentialId: string, supabase: SupabaseClient): Promise<{ client: TecAssuredClient; credentials: TecAssuredCredentials }> {
  const { data: credentials, error } = await supabase.schema("fni").from("provider_credentials").select("*").eq("id", credentialId).single();
  if (error || !credentials) throw new Error(`Credentials not found for ID ${credentialId}: ${error?.message}`);
  return { client: new TecAssuredClient(credentials as TecAssuredCredentials, supabase), credentials: credentials as TecAssuredCredentials };
}
