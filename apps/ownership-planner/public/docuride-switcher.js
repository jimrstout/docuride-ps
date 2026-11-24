// docuride-switcher.js
//
// The DocuRide app switcher: a slim rail down the left edge with one tile per
// DocuRide app the signed-in person is assigned to, so they can hop between
// HQ, DC, FX, PS, R&R and whatever comes next in one click. It shows only when
// they are assigned to two or more apps, and lists only those apps.
//
// The same file is in every DocuRide app repo (the reference copy is
// docuride-hq public/docuride-switcher.js; keep them identical, with
// test/docuride-switcher.test.mjs). A page turns it on with one tag:
//   <script src="/docuride-switcher.js" defer></script>
// Nothing else to wire up: it reads the one DocuRide sign-in (the shared
// docuride.com session cookie, see shared-session.ts / docuride-session.js),
// asks HQ's public.my_apps() which apps that person has, and keeps up with
// sign-ins and sign-outs in any app. Signed out, or one app: nothing shows.
//
// Which app is "here" comes from the page's address. The look (colors and
// icons) matches the HQ launcher. The list is cached for a few minutes per
// person in this tab, so moving between apps doesn't flash.
//
// The button at the bottom of the rail opens it over the page to show each
// app's name and what it is for, with an arrow on each to open it in a new
// tab. Every tile is a plain link, so Ctrl or Cmd click works too.
(function (root) {
  "use strict";

  var SUPABASE_URL = "https://fovccigwlcmmzfubpfny.supabase.co";
  // Public by design: it identifies the project and grants nothing alone.
  var PUBLISHABLE_KEY = "sb_publishable_s4cFTF1i1Wff1m3n7zmg5A_9re6X7yj";
  var SESSION_KEY = "sb-fovccigwlcmmzfubpfny-auth-token";
  var MAX_CHUNKS = 10;
  var CACHE_KEY = "docuride-switcher:v1";
  var CACHE_MS = 5 * 60 * 1000;
  var CHECK_MS = 3 * 1000; // only reads the cookie; it asks the server only when the person changes or the list is old
  var WIDTH = 60;
  var WIDE = 288; // the opened rail, laid over the page

  // The HQ launcher's colors and icons (docuride-hq app/hq-app.tsx LOOKS): each
  // app's own header mark, in its own colors. Keep the two lists the same.
  var DEFAULT_LOOK = { c1: "#4f5bf5", c2: "#8b5cf6", icon: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"] };
  var LOOKS = {
    HQ: { tag: "People, enterprises and who gets which app.", c1: "#6366f1", c2: "#a855f7", icon: ["M6 4h5.5a8 8 0 0 1 0 16H6z", "M10 9.5h2a2.5 2.5 0 0 1 0 5h-2"] },
    DC: { tag: "Deal documents, generated and checked.", c1: "#2563eb", c2: "#06b6d4", icon: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 13h6", "M9 17h4"] },
    FX: { tag: "Fixed ops: parts and service.", c1: "#f97316", c2: "#f59e0b", icon: ["M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5a2.1 2.1 0 0 0 3 3l5.8-5.8a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"] },
    PS: { tag: "Protection & Support.", c1: "#10b981", c2: "#14b8a6", icon: ["M4 16a8 8 0 1 1 16 0", "M12 16l4-5", "M4 20h16"] },
    "R&R Reporting": { tag: "Reports sent on to your DMS.", c1: "#e11d48", c2: "#f97316", icon: ["M3 21h18", "M6 17v-5", "M11 17V7", "M16 17v-8", "M21 17V4"] },
    MX: { tag: "Facilities, rental fleet and vehicle upkeep.", c1: "#0e9f8e", c2: "#0ea5e9", icon: ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"] },
    RT: { tag: "Reservations, renters and the rental fleet.", c1: "#eab308", c2: "#65a30d", icon: ["M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M8 2v4", "M16 2v4", "M3 10h18", "M12 12v8.5", "M14.25 13.25h-3a1.5 1.5 0 0 0 0 3h1.5a1.5 1.5 0 0 1 0 3h-3"] },
  };

  // ── pure parts (tested in test/docuride-switcher.test.mjs) ─────────────

  function lookOf(key) {
    return LOOKS[key] || DEFAULT_LOOK;
  }

  /** A line on what the app is for, shown when the rail is opened. */
  function tagOf(key) {
    return (LOOKS[key] && LOOKS[key].tag) || "";
  }

  function shortName(label) {
    return String(label).replace(/^DocuRide /, "");
  }

  function fromBase64Url(data) {
    var bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /** The shared session's access token and person, from document.cookie text; null when signed out or unreadable. */
  function readSession(cookieText) {
    var jar = {};
    String(cookieText || "").split(";").forEach(function (part) {
      var eq = part.indexOf("=");
      if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    });
    var data = "";
    for (var i = 0; i < MAX_CHUNKS; i++) {
      var piece = jar[SESSION_KEY + "." + i];
      if (piece === undefined) break;
      data += piece;
    }
    if (!data) return null;
    try {
      var s = JSON.parse(fromBase64Url(data));
      if (!s || typeof s.access_token !== "string" || !s.access_token) return null;
      var user = s.user && typeof s.user.id === "string" ? s.user.id : null;
      if (!user) return null;
      return { token: s.access_token, user: user, expiresAt: Number(s.expires_at) || 0 };
    } catch (e) {
      return null;
    }
  }

  /** True when the token has run out (or will within 30 seconds): the app it belongs to refreshes it, not us. */
  function tokenExpired(session, nowMs) {
    return session.expiresAt > 0 && session.expiresAt - 30 <= nowMs / 1000;
  }

  /** Clean rows from my_apps: an https address on docuride.com (or this page's own host) and a key. */
  function cleanApps(rows, hostname) {
    if (!Array.isArray(rows)) return [];
    var seen = {};
    return rows.filter(function (r) {
      if (!r || typeof r.key !== "string" || typeof r.url !== "string" || seen[r.key]) return false;
      var host;
      try {
        var u = new URL(r.url);
        if (u.protocol !== "https:") return false;
        host = u.hostname.toLowerCase();
      } catch (e) {
        return false;
      }
      if (!(host === "docuride.com" || /\.docuride\.com$/.test(host) || host === String(hostname).toLowerCase())) return false;
      seen[r.key] = true;
      return true;
    }).map(function (r) {
      return { key: r.key, label: typeof r.label === "string" && r.label ? r.label : r.key, url: r.url };
    });
  }

  /** The key of the app this page belongs to: the one whose address is on this host. */
  function currentKey(apps, hostname) {
    var host = String(hostname).toLowerCase();
    for (var i = 0; i < apps.length; i++) {
      try {
        if (new URL(apps[i].url).hostname.toLowerCase() === host) return apps[i].key;
      } catch (e) {
        /* skipped by cleanApps already */
      }
    }
    return null;
  }

  /** The rail shows only for two or more apps. */
  function shouldShow(apps) {
    return apps.length >= 2;
  }

  // ── the page ─────────────────────────────────────────────────────────

  var STYLE =
    ":host{all:initial}" +
    "*{box-sizing:border-box}" +
    ".rail{position:fixed;z-index:2147483000;left:0;top:0;bottom:0;width:" + WIDTH + "px;display:flex;flex-direction:column;padding:14px 10px 10px;overflow:hidden;" +
    "background:linear-gradient(180deg,rgba(13,17,32,.97),rgba(7,10,20,.97));border-right:1px solid rgba(255,255,255,.08);" +
    "box-shadow:1px 0 24px rgba(0,0,0,.25);transition:width .18s ease,box-shadow .18s;font-family:'Plus Jakarta Sans Variable','Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',sans-serif}" +
    ".rail.wide{width:" + WIDE + "px;background:#0a0d1a;box-shadow:12px 0 48px rgba(0,0,0,.45)}" +
    ".list{display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:none}" +
    ".item{position:relative;display:flex;align-items:center;gap:4px;border-radius:13px}" +
    ".app{position:relative;display:flex;align-items:center;gap:12px;flex:1;min-width:0;border-radius:12px;outline:none;color:#f5f7ff;text-decoration:none;-webkit-tap-highlight-color:transparent}" +
    ".ico{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:12px;color:#fff;background:linear-gradient(135deg,var(--c1),var(--c2));" +
    "opacity:.72;filter:saturate(.85);transition:opacity .15s,transform .15s,filter .15s,box-shadow .15s}" +
    ".ico svg{width:20px;height:20px}" +
    ".app:hover .ico,.app:focus-visible .ico{opacity:1;filter:none;transform:translateY(-1px);box-shadow:0 6px 18px -6px var(--c1)}" +
    ".app:focus-visible .ico{box-shadow:0 0 0 2px #070a14,0 0 0 4px #fff}" +
    ".app[aria-current=page] .ico{opacity:1;filter:none;box-shadow:0 0 0 2px #070a14,0 0 0 4px var(--c1),0 8px 22px -8px var(--c1)}" +
    ".rail .app[aria-current=page]::before{content:'';position:absolute;left:-10px;top:9px;bottom:9px;width:4px;border-radius:0 4px 4px 0;background:linear-gradient(180deg,var(--c1),var(--c2))}" +
    ".tip{position:fixed;left:" + (WIDTH - 6) + "px;transform:translate(-4px,-50%);white-space:nowrap;pointer-events:none;opacity:0;" +
    "padding:6px 10px;border-radius:8px;font-size:13px;font-weight:600;letter-spacing:.01em;color:#f5f7ff;background:#151a2e;border:1px solid rgba(255,255,255,.1);" +
    "box-shadow:0 8px 24px rgba(0,0,0,.35);transition:opacity .12s,transform .12s}" +
    ".app:hover .tip,.app:focus-visible .tip{opacity:1;transform:translate(0,-50%)}" +
    ".here{display:block;font-size:11px;font-weight:500;color:#a5adcb;margin-top:1px}" +
    ".txt,.nt,.hint{display:none}" +
    ".wide .tip{display:none}" +
    ":is(.wide,.sheet) .item:hover,:is(.wide,.sheet) .item:focus-within{background:rgba(255,255,255,.06)}" +
    ":is(.wide,.sheet) .item:has(.app[aria-current=page]){background:rgba(255,255,255,.07)}" +
    ":is(.wide,.sheet) .app{padding:4px 0 4px 4px}" +
    ":is(.wide,.sheet) .txt{display:block;min-width:0;line-height:1.3}" +
    ".txt b{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700;white-space:nowrap}" +
    ".txt b i{font-style:normal;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#0d1120;background:#c7cde3;border-radius:5px;padding:1px 5px}" +
    ".txt small{display:block;margin-top:2px;font-size:12px;font-weight:500;color:#a5adcb}" +
    ":is(.wide,.sheet) .nt{display:grid;flex:none;place-items:center;width:32px;height:32px;margin-right:4px;border-radius:9px;color:#8a93b4;text-decoration:none;outline:none}" +
    ".nt:hover,.nt:focus-visible{color:#fff;background:rgba(255,255,255,.1)}" +
    ".nt:focus-visible{box-shadow:0 0 0 2px #fff}" +
    ".nt svg{width:16px;height:16px}" +
    ".toggle{flex:none;display:flex;align-items:center;gap:12px;width:100%;height:40px;margin-top:10px;padding:0 10px;border:0;border-radius:12px;" +
    "background:transparent;color:#8a93b4;font:inherit;font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer;-webkit-tap-highlight-color:transparent}" +
    ".toggle:hover,.toggle:focus-visible{color:#fff;background:rgba(255,255,255,.07);outline:none}" +
    ".toggle:focus-visible{box-shadow:0 0 0 2px #fff}" +
    ".toggle svg{flex:none;width:20px;height:20px;transition:transform .18s}" +
    ".wide .toggle svg{transform:rotate(180deg)}" +
    ".toggle span{display:none}.wide .toggle span{display:inline}" +
    ":is(.wide,.sheet) .hint{display:block;padding:10px 8px 2px;font-size:11.5px;line-height:1.45;color:#7b84a6}" +
    ".hint kbd{font:inherit;font-weight:700;color:#c7cde3}" +
    ".fab,.sheet{display:none}" +
    "@media (max-width:720px){" +
    ".rail{display:none}" +
    ".fab{display:grid;place-items:center;position:fixed;z-index:2147483000;left:14px;bottom:14px;width:46px;height:46px;border-radius:15px;border:1px solid rgba(255,255,255,.14);" +
    "color:#fff;background:linear-gradient(135deg,var(--c1),var(--c2));box-shadow:0 10px 28px -8px rgba(0,0,0,.55),0 6px 18px -8px var(--c1);cursor:pointer;-webkit-tap-highlight-color:transparent}" +
    ".fab svg{width:22px;height:22px}" +
    ".fab:focus-visible{outline:2px solid #fff;outline-offset:2px}" +
    ".sheet{position:fixed;z-index:2147483001;left:14px;bottom:70px;width:300px;max-width:calc(100vw - 28px);max-height:calc(100vh - 100px);overflow-y:auto;padding:8px;border-radius:16px;" +
    "background:#0d1120;border:1px solid rgba(255,255,255,.1);box-shadow:0 18px 48px rgba(0,0,0,.5);font-family:'Plus Jakarta Sans Variable','Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',sans-serif}" +
    ".sheet.open{display:flex;flex-direction:column;gap:2px}" +
    ".sheet .head{padding:6px 8px 8px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8a93b4}" +
    ".sheet .ico{width:36px;height:36px;border-radius:10px;opacity:1;filter:none}" +
    ".sheet .ico svg{width:18px;height:18px}" +
    ".sheet .nt{width:40px;height:40px}" +
    ".sheet .hint{display:none}" +
    "}" +
    "@media (prefers-reduced-motion:reduce){.rail,.ico,.tip,.toggle svg{transition:none}}" +
    "@media print{.rail,.fab,.sheet{display:none!important}}";

  // Room for the rail, set on the page itself (outside the shadow root). A page
  // with its own fixed left-hand panel moves it over by
  // var(--docuride-switcher-width, 0px).
  var PAGE_STYLE =
    "@media (min-width:721px){html.docuride-switcher-on{--docuride-switcher-width:" + WIDTH + "px}" +
    "html.docuride-switcher-on body{padding-left:" + WIDTH + "px!important}}" +
    "@media print{html.docuride-switcher-on{--docuride-switcher-width:0px}html.docuride-switcher-on body{padding-left:0!important}}";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var NEW_TAB_ICON = ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"];
  var OPEN_ICON = ["M6 17l5-5-5-5", "M13 17l5-5-5-5"];

  function svg(doc, paths) {
    var el = doc.createElementNS(SVG_NS, "svg");
    el.setAttribute("viewBox", "0 0 24 24");
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "currentColor");
    el.setAttribute("stroke-width", "1.9");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("aria-hidden", "true");
    paths.forEach(function (d) {
      var p = doc.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      el.appendChild(p);
    });
    return el;
  }

  function icon(doc, key) {
    var look = lookOf(key);
    var span = doc.createElement("span");
    span.className = "ico";
    span.style.setProperty("--c1", look.c1);
    span.style.setProperty("--c2", look.c2);
    span.appendChild(svg(doc, look.icon));
    return span;
  }

  function text(doc, tag, cls, value) {
    var el = doc.createElement(tag);
    el.className = cls;
    el.textContent = value;
    return el;
  }

  function mountInto(win, apps) {
    var doc = win.document;
    var here = currentKey(apps, win.location.hostname);
    var host = doc.createElement("docuride-switcher");
    var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var style = doc.createElement("style");
    style.textContent = STYLE;
    shadow.appendChild(style);

    // One app: its link (same tab) and, when the list is open, a small
    // button that opens it in a new tab. Ctrl or Cmd click, or a middle
    // click, opens a new tab anywhere, since every tile is a plain link.
    function item(a, withTip) {
      var name = shortName(a.label);
      var isHere = a.key === here;
      var wrap = doc.createElement("div");
      wrap.className = "item";
      var link = doc.createElement("a");
      link.className = "app";
      link.href = a.url;
      link.setAttribute("aria-label", name + (isHere ? " (this app)" : ""));
      if (isHere) link.setAttribute("aria-current", "page");
      link.appendChild(icon(doc, a.key));
      var txt = doc.createElement("span");
      txt.className = "txt";
      var b = text(doc, "b", "", name);
      if (isHere) b.appendChild(text(doc, "i", "", "Here"));
      txt.appendChild(b);
      if (tagOf(a.key)) txt.appendChild(text(doc, "small", "", tagOf(a.key)));
      link.appendChild(txt);
      if (withTip) {
        var tip = text(doc, "span", "tip", name);
        if (isHere) tip.appendChild(text(doc, "span", "here", "You're here"));
        link.appendChild(tip);
        link.addEventListener("mouseenter", function () {
          var r = link.getBoundingClientRect();
          tip.style.top = r.top + r.height / 2 + "px";
        });
        link.addEventListener("focus", function () {
          var r = link.getBoundingClientRect();
          tip.style.top = r.top + r.height / 2 + "px";
        });
      }
      wrap.appendChild(link);
      var nt = doc.createElement("a");
      nt.className = "nt";
      nt.href = a.url;
      nt.target = "_blank";
      nt.rel = "noopener";
      nt.title = "Open " + name + " in a new tab";
      nt.setAttribute("aria-label", "Open " + name + " in a new tab");
      nt.appendChild(svg(doc, NEW_TAB_ICON));
      wrap.appendChild(nt);
      return wrap;
    }

    function hint() {
      var p = doc.createElement("p");
      p.className = "hint";
      p.appendChild(doc.createTextNode("Click an app to go there, or its arrow to open it in a new tab. "));
      var k = doc.createElement("kbd");
      k.textContent = /Mac|iPhone|iPad/.test(win.navigator.platform || "") ? "\u2318 click" : "Ctrl click";
      p.appendChild(k);
      p.appendChild(doc.createTextNode(" works too."));
      return p;
    }

    // Wide screens: the rail. The button at the bottom opens it over the
    // page to show each app's name and what it is for.
    var rail = doc.createElement("nav");
    rail.className = "rail";
    rail.setAttribute("aria-label", "DocuRide apps");
    var list = doc.createElement("div");
    list.className = "list";
    apps.forEach(function (a) {
      list.appendChild(item(a, true));
    });
    rail.appendChild(list);
    rail.appendChild(hint());
    var toggle = doc.createElement("button");
    toggle.className = "toggle";
    toggle.type = "button";
    toggle.appendChild(svg(doc, OPEN_ICON));
    toggle.appendChild(text(doc, "span", "", "Close"));
    function setWide(wide) {
      rail.classList.toggle("wide", wide);
      toggle.setAttribute("aria-expanded", wide ? "true" : "false");
      toggle.setAttribute("aria-label", wide ? "Close the app list" : "Show app names");
      toggle.title = wide ? "" : "Show app names";
    }
    setWide(false);
    toggle.addEventListener("click", function () {
      setWide(!rail.classList.contains("wide"));
    });
    rail.appendChild(toggle);
    shadow.appendChild(rail);

    // Phones: a button in the corner that opens the list.
    var hereLook = lookOf(here || "");
    var fab = doc.createElement("button");
    fab.className = "fab";
    fab.type = "button";
    fab.setAttribute("aria-label", "Switch DocuRide app");
    fab.setAttribute("aria-expanded", "false");
    fab.style.setProperty("--c1", hereLook.c1);
    fab.style.setProperty("--c2", hereLook.c2);
    fab.appendChild(svg(doc, DEFAULT_LOOK.icon));
    var sheet = doc.createElement("nav");
    sheet.className = "sheet";
    sheet.setAttribute("aria-label", "DocuRide apps");
    sheet.appendChild(text(doc, "div", "head", "Your apps"));
    apps.forEach(function (a) {
      sheet.appendChild(item(a, false));
    });
    function setOpen(open) {
      sheet.classList.toggle("open", open);
      fab.setAttribute("aria-expanded", open ? "true" : "false");
    }
    fab.addEventListener("click", function (e) {
      e.stopPropagation();
      setOpen(!sheet.classList.contains("open"));
    });
    function onDocClick(e) {
      if (e.target !== host) {
        setOpen(false);
        setWide(false);
      }
    }
    function onKey(e) {
      if (e.key === "Escape") {
        setOpen(false);
        setWide(false);
      }
    }
    doc.addEventListener("click", onDocClick);
    doc.addEventListener("keydown", onKey);
    shadow.appendChild(sheet);
    shadow.appendChild(fab);

    doc.body.appendChild(host);
    doc.documentElement.classList.add("docuride-switcher-on");
    return function unmount() {
      doc.removeEventListener("click", onDocClick);
      doc.removeEventListener("keydown", onKey);
      if (host.parentNode) host.parentNode.removeChild(host);
      doc.documentElement.classList.remove("docuride-switcher-on");
    };
  }

  function readCache(win, user) {
    try {
      var c = JSON.parse(win.sessionStorage.getItem(CACHE_KEY) || "null");
      if (c && c.user === user && Date.now() - c.at < CACHE_MS && Array.isArray(c.apps)) return c.apps;
    } catch (e) {
      /* no cache: ask again */
    }
    return null;
  }

  function writeCache(win, user, apps) {
    try {
      win.sessionStorage.setItem(CACHE_KEY, JSON.stringify({ user: user, at: Date.now(), apps: apps }));
    } catch (e) {
      /* fine without it */
    }
  }

  function start(win) {
    var doc = win.document;
    var shownFor = null; // the person the rail is showing for, and their apps
    var unmount = null;
    var asking = null;

    function show(user, apps) {
      var sig = user + "|" + JSON.stringify(apps);
      if (shownFor === sig) return;
      hide();
      if (!shouldShow(apps)) {
        shownFor = sig;
        return;
      }
      unmount = mountInto(win, apps);
      shownFor = sig;
    }

    function hide() {
      if (unmount) unmount();
      unmount = null;
      shownFor = null;
    }

    function check() {
      var s = readSession(doc.cookie);
      if (!s) {
        hide();
        try {
          win.sessionStorage.removeItem(CACHE_KEY);
        } catch (e) {
          /* fine */
        }
        return;
      }
      if (shownFor && shownFor.indexOf(s.user + "|") !== 0) hide(); // someone else signed in
      var cached = readCache(win, s.user);
      if (cached) {
        show(s.user, cached);
        return;
      }
      if (asking === s.user || tokenExpired(s, Date.now())) return; // the app refreshes it; we look again shortly
      asking = s.user;
      win
        .fetch(SUPABASE_URL + "/rest/v1/rpc/my_apps", {
          method: "POST",
          headers: { apikey: PUBLISHABLE_KEY, Authorization: "Bearer " + s.token, "Content-Type": "application/json" },
          body: "{}",
        })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (rows) {
          if (rows === null) return; // try again on the next look
          var apps = cleanApps(rows, win.location.hostname);
          writeCache(win, s.user, apps);
          var now = readSession(doc.cookie);
          if (now && now.user === s.user) show(s.user, apps);
        })
        .catch(function () {
          /* offline or blocked: no rail, nothing breaks */
        })
        .then(function () {
          asking = null;
        });
    }

    function ready() {
      check();
      win.setInterval(check, CHECK_MS);
      win.addEventListener("focus", check);
      doc.addEventListener("visibilitychange", function () {
        if (doc.visibilityState === "visible") check();
      });
    }

    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", ready);
    else ready();
  }

  var api = {
    readSession: readSession,
    tokenExpired: tokenExpired,
    tagOf: tagOf,
    cleanApps: cleanApps,
    currentKey: currentKey,
    shouldShow: shouldShow,
    shortName: shortName,
    lookOf: lookOf,
  };
  root.DocuRideSwitcher = api;

  if (typeof root.document !== "undefined" && root.document && root.location && !root.__docurideSwitcherStarted) {
    root.__docurideSwitcherStarted = true;
    var pageStyle = root.document.createElement("style");
    pageStyle.textContent = PAGE_STYLE;
    (root.document.head || root.document.documentElement).appendChild(pageStyle);
    start(root);
  }
})(typeof window !== "undefined" ? window : globalThis);
