// The conventional menu's package columns, per menu template (migration
// 0042): two to five, each with a name, an order, preset categories and a
// starting coverage level, and a default layout until someone saves one.
// Mock data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_COLUMNS,
  LEVELS,
  MAX_COLUMNS,
  MIN_COLUMNS,
  columnsFor,
  levelIndex,
  parseColumns,
} from "../supabase/functions/_shared/menu-columns.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const col = (name, cats = [], level = "Lowest") => ({ name, preset_categories: cats, starting_level: level });

test("a new template works before anyone edits it: the default layout", () => {
  assert.deepEqual(DEFAULT_COLUMNS.map((c) => [c.name, c.starting_level]), [
    ["Platinum", "Highest"], ["Gold", "Middle"], ["Silver", "Lowest"], ["Basic", "Lowest"],
  ]);
  assert.deepEqual(DEFAULT_COLUMNS[3].preset_categories, ["Mechanical Protection"]);
  const none = columnsFor([]);
  assert.equal(none.is_default, true);
  assert.equal(none.columns.length, 4);
  // A copy, so a caller cannot change the default for everyone.
  none.columns[0].preset_categories.push("Other");
  assert.ok(!DEFAULT_COLUMNS[0].preset_categories.includes("Other"));
});

test("saved columns come back in their order", () => {
  const got = columnsFor([
    { position: 2, name: "Basic", preset_categories: ["Mechanical Protection"], starting_level: "Lowest" },
    { position: 1, name: "Premium", preset_categories: ["Theft", "Not a category"], starting_level: "Highest" },
  ]);
  assert.equal(got.is_default, false);
  assert.deepEqual(got.columns.map((c) => c.name), ["Premium", "Basic"]);
  assert.deepEqual(got.columns[0].preset_categories, ["Theft"]);
});

test("two to five columns; a blank name is a column not in use", () => {
  assert.equal(MIN_COLUMNS, 2);
  assert.equal(MAX_COLUMNS, 5);
  const ok = parseColumns([col("Gold", ["Theft"], "Middle"), col(""), col("Basic"), col("  "), col("")]);
  assert.deepEqual(ok, { columns: [col("Gold", ["Theft"], "Middle"), col("Basic")] });
  assert.deepEqual(parseColumns([col("Only one")]), { errors: ["A menu has two to five columns. This one has 1."] });
  const six = parseColumns(["A", "B", "C", "D", "E", "F"].map((n) => col(n)));
  assert.match(six.errors.join(" "), /This one has 6\./);
  assert.deepEqual(parseColumns("nope"), { errors: ["The columns are missing."] });
});

test("categories and levels are the words people read, and names are unique", () => {
  const bad = parseColumns([col("Gold", ["Theft", "Lasers"]), col("Basic", [], "Top")]);
  assert.deepEqual(bad.errors, [
    "Gold names a category that does not exist: Lasers.",
    "Basic's starting coverage level must be Lowest, Middle or Highest.",
  ]);
  assert.match(parseColumns([col("Gold"), col("gold")]).errors.join(" "), /Two columns cannot share a name: gold\./);
  // A missing level is Lowest.
  assert.equal(parseColumns([{ name: "A" }, { name: "B", starting_level: "" }]).columns[1].starting_level, "Lowest");
  assert.deepEqual(LEVELS, ["Lowest", "Middle", "Highest"]);
});

test("a coverage level picks a tier, cheapest first", () => {
  assert.equal(levelIndex("Lowest", 4), 0);
  assert.equal(levelIndex("Highest", 4), 3);
  assert.equal(levelIndex("Middle", 4), 1);
  assert.equal(levelIndex("Middle", 3), 1);
  assert.equal(levelIndex("Middle", 2), 0);
  for (const l of LEVELS) assert.equal(levelIndex(l, 1), 0);
});

test("the save goes through the one database function that checks two to five", () => {
  const t = read("supabase/functions/fni-admin-settings/templates.ts");
  assert.match(t, /case "save_columns": \{\s*const templateId = await ownTemplate\(body\.template_id\);/);
  assert.match(t, /\.rpc\("save_menu_columns", \{ p_template_id: templateId, p_columns: parsed\.columns, p_updated_by: by \}\)/);
  const m = read("supabase/migrations/0042_conventional_menu.sql");
  assert.match(m, /if n < 2 or n > 5 then\s*raise exception 'A menu has two to five columns\. This one has %\.', n;/);
});

test("staff configure the columns in Menus, and see which products need a description", () => {
  const page = read("apps/ownership-planner/app/admin/menus/page.tsx");
  assert.match(page, /<ColumnsPanel t=\{t\} editing=\{params\.columns !== undefined\} \/>/);
  assert.match(page, /const COLUMN_ROWS = \[1, 2, 3, 4, 5\];/);
  assert.match(page, /name=\{`col_\$\{n\}_categories`\}/);
  assert.match(page, /<h2 id="needs-title">Products that need a description<\/h2>/);
  assert.match(page, /href=\{`\/admin\/providers\/wording\?provider=\$\{r\.provider_id\}&product=\$\{r\.id\}`\}/);
  const t = read("supabase/functions/fni-admin-settings/templates.ts");
  assert.match(t, /\.from\("product_catalog_presentable"\)[\s\S]*?\.eq\("is_presentable", false\);/);
  const actions = read("apps/ownership-planner/app/console-actions.ts");
  assert.match(actions, /action: "save_columns", template_id: templateId, columns, updated_by: by/);
  assert.doesNotMatch(page, /—/);
});
