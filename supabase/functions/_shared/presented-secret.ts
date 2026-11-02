// _shared/presented-secret.ts: where a caller's shared secret is read from.
//
// Pure, so a Node test can hold it (_shared/supabase.ts reads Deno.env as it
// loads, which Node cannot).

/**
 * The shared secret a caller presented: the x-webhook-secret header first,
 * then the ?secret= address form.
 *
 * Header first, so a caller moving to the header works the moment it sends
 * one, even while an old ?secret= is still in its address: the address form
 * used to be read first in eight functions, and a stale value there would
 * have failed a request whose header was right. The address form still works
 * for now; turning it off, and replacing the secrets it exposed, wait for
 * Jim (docs/secrets-in-web-addresses.md).
 */
export function presentedSecret(req: Request): string | null {
  const header = req.headers.get("x-webhook-secret");
  if (header !== null && header !== "") return header;
  return new URL(req.url).searchParams.get("secret");
}

/** Which form a caller used, for a log line. Never the value. */
export function secretForm(req: Request): "header" | "address" | "none" {
  const header = req.headers.get("x-webhook-secret");
  if (header !== null && header !== "") return "header";
  return new URL(req.url).searchParams.get("secret") ? "address" : "none";
}
