// scripts/check-controls.mjs: every clickable control goes through the shared one.
//
// A button or link made any other way ships with no busy state: nothing shows
// the system is working, and people press it twice. So this fails the build
// if anything in app/ or components/ makes one without components/Control.tsx:
//   <button>, <a>, Next's <Link>, an onClick handler on anything, a submit,
//   button or image <input>, or a role="button" stand-in.
//
// It runs before every `next build` (package.json "prebuild", so a Vercel
// preview of a pull request that adds one fails) and in the repository's
// tests (test/controls-enforced.test.mjs, so CI fails too).
//
//   node scripts/check-controls.mjs          exits 1 and lists each one
//
// The one file allowed to make the real elements is components/Control.tsx.
// Comments do not count: only code.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED = new Set(["components/Control.tsx"]);

export const RULES = [
  { re: /<button\b/, say: "a <button>: use <Control> (components/Control.tsx)" },
  { re: /<a\b[\s>]/, say: "an <a> link: use <Control href=...>" },
  { re: /<Link\b|from\s+["']next\/link["']/, say: "Next's <Link>: use <Control href=...>" },
  { re: /\bonClick\s*=/, say: "an onClick handler: use <Control onPress=...>" },
  { re: /<input\b[^>]*\btype\s*=\s*["'](submit|button|image|reset)["']/, say: "a button <input>: use <Control type=\"submit\">" },
  { re: /\brole\s*=\s*["']button["']/, say: "a role=\"button\" stand-in: use <Control>" },
];

/** Code only: comments taken out, line count kept, so line numbers stay true. */
export function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

/** Every rule a source breaks, with its line. */
export function violations(source) {
  const lines = codeOnly(source).split("\n");
  const found = [];
  lines.forEach((line, i) => {
    for (const r of RULES) if (r.re.test(line)) found.push({ line: i + 1, say: r.say, text: line.trim().slice(0, 120) });
  });
  return found;
}

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx|ts|jsx|js)$/.test(f) ? [p] : [];
  });
}

/** Every breach in the app, as "file:line: what, and the code". */
export function checkApp(root = ROOT) {
  const out = [];
  for (const f of [...files(join(root, "app")), ...files(join(root, "components"))]) {
    const rel = relative(root, f).split("\\").join("/");
    if (ALLOWED.has(rel)) continue;
    for (const v of violations(readFileSync(f, "utf8"))) out.push(`${rel}:${v.line}: ${v.say}\n    ${v.text}`);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const found = checkApp();
  if (found.length > 0) {
    console.error(`Every button and link must go through components/Control.tsx, so it shows it is working when pressed.\n${found.length} control(s) bypass it:\n\n${found.join("\n")}`);
    process.exit(1);
  }
  console.log("Every button and link goes through components/Control.tsx.");
}
