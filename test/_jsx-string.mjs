// A JSX runtime that renders to an HTML string, for tests.
//
// The planner's components are TSX and React is not a dependency of the test
// suite. TypeScript (which is) transpiles a component with this as its JSX
// runtime, and the component's markup comes out as a string a test can read.
// Enough of React's rules for static markup: className, fragments, arrays,
// and null, undefined and booleans rendering as nothing.

export const Fragment = Symbol("Fragment");

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

/** Rendered markup, told apart from text so only text is escaped. */
class Html {
  constructor(html) { this.html = html; }
  toString() { return this.html; }
}

function children(c) {
  if (c === null || c === undefined || typeof c === "boolean") return "";
  if (Array.isArray(c)) return c.map(children).join("");
  if (c instanceof Html) return c.html;
  return esc(c);
}

export function jsx(type, props) {
  const { children: kids, ...rest } = props ?? {};
  if (type === Fragment) return new Html(children(kids));
  if (typeof type === "function") return new Html(children(type({ ...rest, children: kids })));

  const attrs = Object.entries(rest)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => ` ${k === "className" ? "class" : k}="${esc(v === true ? "" : v)}"`)
    .join("");
  return new Html(`<${type}${attrs}>${children(kids)}</${type}>`);
}

export const jsxs = jsx;

/** The markup an element renders to. */
export function render(el) {
  return children(el);
}
