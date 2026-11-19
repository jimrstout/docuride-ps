// docuride-session.js
//
// One DocuRide sign-in for every app. Supabase normally keeps the session in
// localStorage, which each subdomain has its own copy of. This keeps it in a
// cookie for the whole docuride.com domain instead, so HQ, FX, DC, R&R, PS and
// every other DocuRide app read and refresh the same session. Signing out
// anywhere signs out everywhere.
//
// Plain-script copy of app/lib/shared-session.ts in docuride-hq (same cookie,
// same rules). Keep them in step. Use:
//   supabase.createClient(URL, KEY, { auth: { storage: DocuRideSession.browserSessionStorage() } })
//
// The cookie holds what localStorage held before: the session tokens, readable
// by the page's own script (Supabase needs that). Secure and SameSite=Lax.
// Off docuride.com (localhost, Vercel previews) it stays on that one host.
(function (root) {
  "use strict";
  var CHUNK = 3500;
  var MAX_CHUNKS = 10;
  var MAX_AGE = 60 * 60 * 24 * 400;

  function sharedDomain(hostname) {
    var host = String(hostname).toLowerCase();
    return host === "docuride.com" || /\.docuride\.com$/.test(host) ? "docuride.com" : null;
  }

  function toBase64Url(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(data) {
    var bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function readCookies(doc) {
    var jar = new Map();
    doc.cookie.split(";").forEach(function (part) {
      var eq = part.indexOf("=");
      if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    });
    return jar;
  }

  function createSharedSessionStorage(options) {
    var doc = options.doc;
    var legacy = options.legacy || null;
    var domain = sharedDomain(options.hostname);
    function attrs(maxAge) {
      return "; Path=/; Max-Age=" + maxAge + "; SameSite=Lax" + (domain ? "; Domain=" + domain : "") + (options.secure ? "; Secure" : "");
    }
    function read(key) {
      var jar = readCookies(doc);
      var data = "";
      for (var i = 0; i < MAX_CHUNKS; i++) {
        var part = jar.get(key + "." + i);
        if (part === undefined) break;
        data += part;
      }
      if (!data) return null;
      try {
        return fromBase64Url(data);
      } catch (e) {
        return null;
      }
    }
    function clear(key, from) {
      var jar = readCookies(doc);
      for (var i = from || 0; i < MAX_CHUNKS; i++) {
        if (jar.has(key + "." + i)) doc.cookie = key + "." + i + "=" + attrs(0);
      }
    }
    function write(key, value) {
      var data = toBase64Url(value);
      var parts = Math.ceil(data.length / CHUNK);
      if (parts > MAX_CHUNKS) throw new Error("Session too large to share");
      for (var i = 0; i < parts; i++) doc.cookie = key + "." + i + "=" + data.slice(i * CHUNK, (i + 1) * CHUNK) + attrs(MAX_AGE);
      clear(key, parts);
    }
    return {
      getItem: function (key) {
        var value = read(key);
        if (value !== null) return value;
        // Signed in before sessions were shared: move that session into the cookie.
        var old = legacy ? legacy.getItem(key) : null;
        if (old !== null && old !== undefined) {
          write(key, old);
          legacy.removeItem(key);
          return old;
        }
        return null;
      },
      setItem: function (key, value) { write(key, value); },
      removeItem: function (key) {
        clear(key, 0);
        if (legacy) legacy.removeItem(key);
      },
    };
  }

  function browserSessionStorage() {
    if (typeof document === "undefined" || typeof window === "undefined") return undefined;
    var legacy = null;
    try { legacy = window.localStorage; } catch (e) { legacy = null; }
    return createSharedSessionStorage({
      doc: document,
      hostname: window.location.hostname,
      secure: window.location.protocol === "https:",
      legacy: legacy,
    });
  }

  /** Signed in or out in another DocuRide app while this page sat in the background? Reload when it comes back. */
  function followOtherApps(sb, current) {
    function check() {
      if (document.visibilityState !== "visible") return;
      sb.auth.getSession().then(function (r) {
        var now = r && r.data && r.data.session && r.data.session.user ? r.data.session.user.id : null;
        var mine = current() && current().user ? current().user.id : null;
        if (now !== mine) location.reload();
      });
    }
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
  }

  var api = { sharedDomain: sharedDomain, createSharedSessionStorage: createSharedSessionStorage, browserSessionStorage: browserSessionStorage, followOtherApps: followOtherApps };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DocuRideSession = api;
})(typeof window !== "undefined" ? window : globalThis);
