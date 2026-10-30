// app/admin/menus/page.tsx: which products a deal is offered.
//
// A menu template matches deals by store, deal type, vehicle type, New or Used
// and make (an empty choice means any). The most specific matching menu wins,
// then the higher priority, then the most recently changed. "All deals" has no
// conditions, so it is the menu for every deal nothing else matches.
//
// A menu's slots are its decisions, in order. Side by Side shows every product
// in the slot that got an offer, together, the way a tier choice reads (Bronze,
// Silver, Gold). Best Match shows the first product in the slot's order that
// got an offer, which is how one provider is preferred over another. A slot
// with no offers is not shown to the customer.
//
// Nothing is deleted: a menu is switched off, and a slot with no products is
// not shown. No JavaScript: ?template=<id> opens a menu, ?slot=<id> or
// ?addslot=1 opens the slot form, ?new=1 the new-menu form, ?columns=1 the
// menu columns form.
//
// ── Menu columns (the conventional menu) ────────────────────────────────
// Each menu also has two to five package columns for the conventional menu:
// a name, an order, the product categories each starts checked, and the
// coverage level its products start at. Until some are saved it uses the
// default layout (supabase/functions/_shared/menu-columns.ts). Products with
// no approved description are listed here so staff can write one; the
// conventional menu still shows them, under the provider's product name.

import Link from "next/link";
import PendingButton from "@/components/PendingButton";
import { Working } from "@/components/Working";
import { currentOperator } from "@/lib/admin-session";
import { edge, EdgeError } from "@/lib/edge";
import type { TemplateRow, TemplateSlotRow, TemplatesPayload } from "@/lib/types";
import { moveSlot, saveMenuColumns, saveSlot, saveTemplate } from "@/app/console-actions";
import ProgramLabel from "@/components/admin/ProgramLabel";
import { Badge, Notice, PageHead } from "@/components/admin/Parts";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

const CATEGORIES = ["Mechanical Protection", "Maintenance", "Tire and Wheel", "Theft", "Battery", "Appearance", "Other"];
const LEVELS = ["Lowest", "Middle", "Highest"] as const;
const COLUMN_ROWS = [1, 2, 3, 4, 5];

function notice(params: Params): { tone: "good" | "warn"; text: string } | null {
  if (params.saved !== undefined || params.moved !== undefined) {
    return { tone: "good", text: "Saved. It applies to the next deal rated." };
  }
  if (typeof params.refused === "string") return { tone: "warn", text: params.refused };
  if (params.savefailed !== undefined) return { tone: "warn", text: "That could not be saved just now. Nothing was changed. Try again shortly." };
  return null;
}

function TemplateForm({ t, payload }: { t: TemplateRow | null; payload: TemplatesPayload }) {
  const has = (list: string[] | undefined, v: string) => (list ?? []).includes(v);
  return (
    <form action={saveTemplate} className="ad-editor-fields">
      <Working />
      {t ? <input type="hidden" name="template_id" value={t.id} /> : null}
      <label className="ad-field">
        <span>Name</span>
        <input name="name" defaultValue={t?.name ?? ""} placeholder="New Can-Am" required />
      </label>
      <label className="ad-field">
        <span>Priority (higher wins a tie)</span>
        <input name="priority" inputMode="numeric" defaultValue={String(t?.priority ?? 0)} />
      </label>
      <label className="ad-field ad-field--wide">
        <span>What it is for</span>
        <input name="description" defaultValue={t?.description ?? ""} />
      </label>
      <label className="ad-field ad-field--wide">
        <span>Makes (empty for any)</span>
        <input name="makes" defaultValue={t?.makes.join(", ") ?? ""} placeholder="Can-Am" />
      </label>
      <fieldset className="ad-fieldset">
        <legend>New or Used (none ticked for either)</legend>
        {["New", "Used"].map((c) => (
          <label key={c} className="ad-check"><input type="checkbox" name="conditions" value={c} defaultChecked={has(t?.conditions, c)} /> {c}</label>
        ))}
      </fieldset>
      <fieldset className="ad-fieldset">
        <legend>Deal type (none ticked for either)</legend>
        {[["Loan", "Financed"], ["Cash", "Cash"]].map(([v, label]) => (
          <label key={v} className="ad-check"><input type="checkbox" name="deal_types" value={v} defaultChecked={has(t?.deal_types, v)} /> {label}</label>
        ))}
      </fieldset>
      <fieldset className="ad-fieldset ad-field--wide">
        <legend>Vehicle types (none ticked for any)</legend>
        {payload.vehicle_types.map((v) => (
          <label key={v} className="ad-check"><input type="checkbox" name="vehicle_types" value={v} defaultChecked={has(t?.vehicle_types, v)} /> {v}</label>
        ))}
      </fieldset>
      <fieldset className="ad-fieldset ad-field--wide">
        <legend>Stores (none ticked for every store)</legend>
        {payload.stores.map((s) => (
          <label key={s.id} className="ad-check"><input type="checkbox" name="store_ids" value={s.id} defaultChecked={has(t?.store_ids, s.id)} /> {s.name}</label>
        ))}
      </fieldset>
      <label className="ad-check">
        <input type="checkbox" name="active" defaultChecked={t?.active ?? true} /> Active
      </label>
      <div className="ad-editor-actions ad-field--wide">
        <PendingButton className="ad-btn ad-btn--primary" pending="Saving the menu...">{t ? "Save menu" : "Create menu"}</PendingButton>
        <Link href={t ? `/admin/menus?template=${t.id}` : "/admin/menus"} prefetch={false} className="ad-btn ad-btn--secondary">Cancel</Link>
      </div>
    </form>
  );
}

function SlotForm({ t, slot, payload }: { t: TemplateRow; slot: TemplateSlotRow | null; payload: TemplatesPayload }) {
  const order = (id: string) => {
    const i = slot?.product_ids.indexOf(id) ?? -1;
    return i >= 0 ? String(i + 1) : "";
  };
  return (
    <section className="ad-panel ad-editor" aria-labelledby="slot-form">
      <div className="ad-panel-head"><h2 id="slot-form">{slot ? `Edit "${slot.title}"` : "Add a slot"}</h2></div>
      <div className="ad-panel-body">
        <form action={saveSlot} className="ad-editor-fields">
          <Working />
          <input type="hidden" name="template_id" value={t.id} />
          {slot ? <input type="hidden" name="slot_id" value={slot.id} /> : null}
          <label className="ad-field">
            <span>Title</span>
            <input name="title" defaultValue={slot?.title ?? ""} placeholder="Mechanical Protection" required />
          </label>
          <label className="ad-field">
            <span>Show</span>
            <select name="mode" defaultValue={slot?.mode ?? "Side by Side"}>
              <option value="Side by Side">Side by Side: every product that got an offer</option>
              <option value="Best Match">Best Match: the first in order that got an offer</option>
            </select>
          </label>
          <label className="ad-field">
            <span>Category</span>
            <select name="category" defaultValue={slot?.category ?? ""}>
              <option value="">None</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <div className="ad-field--wide">
            <p className="ad-help">
              Number the products in this slot in the order they are preferred. Leave a product blank to keep it out.
            </p>
            <div className="ad-scroll">
              <table className="ad-table">
                <thead>
                  <tr>
                    <th scope="col" className="num">Order</th>
                    <th scope="col">Product</th>
                    <th scope="col">Provider</th>
                    <th scope="col">Category</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.products.map((p) => (
                    <tr key={p.id}>
                      <td className="num">
                        <input className="ad-order" name={`order_${p.id}`} inputMode="numeric" defaultValue={order(p.id)} aria-label={`Order for ${p.name}`} />
                      </td>
                      <td>
                        {p.name} <ProgramLabel name={p.program} />
                        <small>{p.code}</small>
                      </td>
                      <td>{p.provider_name}</td>
                      <td>{p.category}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="ad-editor-actions ad-field--wide">
            <PendingButton className="ad-btn ad-btn--primary" pending="Saving the slot...">{slot ? "Save slot" : "Add slot"}</PendingButton>
            <Link href={`/admin/menus?template=${t.id}`} prefetch={false} className="ad-btn ad-btn--secondary">Cancel</Link>
          </div>
        </form>
      </div>
    </section>
  );
}

/** The menu's conventional columns, and the form that changes them. */
function ColumnsPanel({ t, editing }: { t: TemplateRow; editing: boolean }) {
  const { columns, is_default } = t.menu_columns;
  return (
    <section className="ad-panel" aria-labelledby="columns-title">
      <div className="ad-panel-head">
        <h2 id="columns-title">Menu columns, left to right {is_default ? <Badge>Default layout</Badge> : null}</h2>
        {editing ? null : (
          <Link href={`/admin/menus?template=${t.id}&columns=1`} prefetch={false} className="ad-btn ad-btn--secondary">Edit columns</Link>
        )}
      </div>
      {editing ? (
        <div className="ad-panel-body">
          <form action={saveMenuColumns} className="ad-editor-fields">
            <Working />
            <input type="hidden" name="template_id" value={t.id} />
            <p className="ad-help ad-field--wide">
              Two to five columns. Leave a name blank to leave that column out. Products in the ticked
              categories start checked in that column; a category with no rated product on a deal is simply
              left out of it.
            </p>
            {COLUMN_ROWS.map((n) => {
              const c = columns[n - 1];
              return (
                <fieldset key={n} className="ad-fieldset ad-field--wide">
                  <legend>Column {n}</legend>
                  <label className="ad-field">
                    <span>Name</span>
                    <input name={`col_${n}_name`} defaultValue={c?.name ?? ""} maxLength={40} placeholder={n <= 2 ? "Required" : "Not used"} />
                  </label>
                  <label className="ad-field">
                    <span>Starting coverage level</span>
                    <select name={`col_${n}_level`} defaultValue={c?.starting_level ?? "Lowest"}>
                      {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </label>
                  <div className="ad-field--wide">
                    {CATEGORIES.map((cat) => (
                      <label key={cat} className="ad-check">
                        <input type="checkbox" name={`col_${n}_categories`} value={cat} defaultChecked={c?.preset_categories.includes(cat) ?? false} /> {cat}
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })}
            <div className="ad-editor-actions ad-field--wide">
              <PendingButton className="ad-btn ad-btn--primary" pending="Saving the columns...">Save columns</PendingButton>
              <Link href={`/admin/menus?template=${t.id}`} prefetch={false} className="ad-btn ad-btn--secondary">Cancel</Link>
            </div>
          </form>
        </div>
      ) : (
        <div className="ad-scroll">
          <table className="ad-table">
            <thead>
              <tr>
                <th scope="col" className="num">#</th>
                <th scope="col">Column</th>
                <th scope="col">Starts checked</th>
                <th scope="col">Starting coverage level</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c, i) => (
                <tr key={c.name}>
                  <td className="num">{i + 1}</td>
                  <td className="ad-strong">{c.name}</td>
                  <td>{c.preset_categories.length > 0 ? c.preset_categories.join(", ") : "Nothing"}</td>
                  <td>{c.starting_level}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Catalog products with no approved description yet, for staff to write one. */
function NeedsDescription({ payload }: { payload: TemplatesPayload }) {
  const rows = payload.needs_description ?? [];
  return (
    <section className="ad-panel" aria-labelledby="needs-title">
      <div className="ad-panel-head"><h2 id="needs-title">Products that need a description</h2></div>
      <div className="ad-panel-body">
        <p className="ad-help">
          The Ownership Planner does not show these until their description is approved. The conventional menu
          shows them under the provider&apos;s product name.
        </p>
      </div>
      <div className="ad-scroll">
        <table className="ad-table">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">Provider</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={3} className="ad-empty">Every product has an approved description.</td></tr>
            ) : null}
            {rows.map((r) => (
              <tr key={r.id}>
                <td><span className="ad-strong">{r.name}</span><small>{r.code}</small></td>
                <td>{r.provider_name}</td>
                <td className="num">
                  <Link href={`/admin/providers/wording?provider=${r.provider_id}&product=${r.id}`} prefetch={false} className="ad-btn ad-btn--secondary">
                    Write description
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MenuDetail({ t, payload, params }: { t: TemplateRow; payload: TemplatesPayload; params: Params }) {
  const name = (id: string) => payload.products.find((p) => p.id === id);
  const slotId = one(params.slot);
  const slot = slotId ? t.slots.find((s) => s.id === slotId) ?? null : null;
  const addingSlot = params.addslot !== undefined;
  const editing = params.edit !== undefined;

  return (
    <>
      <section className="ad-panel" aria-labelledby="menu-title">
        <div className="ad-panel-head">
          <h2 id="menu-title">{t.name} {t.active ? null : <Badge>Off</Badge>}</h2>
          <Link href={`/admin/menus?template=${t.id}&edit=1`} prefetch={false} className="ad-btn ad-btn--secondary">Edit conditions</Link>
        </div>
        <div className="ad-panel-body">
          <p>{t.conditions_line}. Priority {t.priority}.</p>
          {t.description ? <p className="ad-help">{t.description}</p> : null}
          {editing ? <TemplateForm t={t} payload={payload} /> : null}
        </div>
      </section>

      <section className="ad-panel" aria-labelledby="slots-title">
        <div className="ad-panel-head">
          <h2 id="slots-title">Slots, in the order the customer sees them</h2>
          <Link href={`/admin/menus?template=${t.id}&addslot=1`} prefetch={false} className="ad-btn ad-btn--secondary">Add a slot</Link>
        </div>
        <div className="ad-scroll">
          <table className="ad-table">
            <thead>
              <tr>
                <th scope="col" className="num">#</th>
                <th scope="col">Slot</th>
                <th scope="col">Show</th>
                <th scope="col">Products, in order</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {t.slots.length === 0 ? (
                <tr><td colSpan={5} className="ad-empty">No slots yet, so this menu offers nothing.</td></tr>
              ) : null}
              {t.slots.map((s, i) => (
                <tr key={s.id}>
                  <td className="num">{i + 1}</td>
                  <td><span className="ad-strong">{s.title}</span>{s.category ? <small>{s.category}</small> : null}</td>
                  <td>{s.mode}</td>
                  <td>
                    {s.product_ids.length === 0 ? "None, so it is not shown" : (
                      <ul className="ad-plain">
                        {s.product_ids.map((id) => {
                          const p = name(id);
                          return (
                            <li key={id}>
                              {p ? <>{p.name} <ProgramLabel name={p.program} /><small>{p.provider_name}</small></> : "A product no longer in the catalog"}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </td>
                  <td className="num">
                    <div className="ad-actions">
                      {i > 0 ? (
                        <form action={moveSlot}>
                          <Working />
                          <input type="hidden" name="template_id" value={t.id} />
                          <input type="hidden" name="slot_id" value={s.id} />
                          <input type="hidden" name="direction" value="up" />
                          <PendingButton className="ad-btn ad-btn--secondary" pending="Moving..." aria-label={`Move ${s.title} up`}>Up</PendingButton>
                        </form>
                      ) : null}
                      {i < t.slots.length - 1 ? (
                        <form action={moveSlot}>
                          <Working />
                          <input type="hidden" name="template_id" value={t.id} />
                          <input type="hidden" name="slot_id" value={s.id} />
                          <input type="hidden" name="direction" value="down" />
                          <PendingButton className="ad-btn ad-btn--secondary" pending="Moving..." aria-label={`Move ${s.title} down`}>Down</PendingButton>
                        </form>
                      ) : null}
                      <Link href={`/admin/menus?template=${t.id}&slot=${s.id}`} prefetch={false} className="ad-btn ad-btn--secondary">Edit</Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {slot || addingSlot ? <SlotForm t={t} slot={slot} payload={payload} /> : null}

      <ColumnsPanel t={t} editing={params.columns !== undefined} />
    </>
  );
}

export default async function MenusPage({ searchParams }: { searchParams: Promise<Params> }) {
  const operator = await currentOperator();
  if (!operator) return null;
  const params = await searchParams;

  let payload: TemplatesPayload;
  try {
    payload = await edge.adminTemplates<TemplatesPayload>();
  } catch (err) {
    console.error("menus load failed:", err);
    const why = err instanceof EdgeError && err.status === 400 ? err.message : null;
    return (
      <>
        <PageHead title="Menus" subtitle="Which products a deal is offered." />
        <Notice tone="warn">{why ?? "Menus are unavailable right now. Try again shortly."}</Notice>
      </>
    );
  }

  const flash = notice(params);
  const open = payload.templates.find((t) => t.id === one(params.template)) ?? null;

  return (
    <>
      <PageHead title="Menus" subtitle="Which products a deal is offered.">
        <Link href="/admin/menus?new=1" prefetch={false} className="ad-btn ad-btn--primary">New menu</Link>
      </PageHead>
      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <nav className="ad-seg" aria-label="Menu">
        {payload.templates.map((t) => (
          <Link
            key={t.id}
            href={`/admin/menus?template=${t.id}`}
            prefetch={false}
            className={open?.id === t.id ? "is-here" : undefined}
            aria-current={open?.id === t.id ? "page" : undefined}
          >
            <span className={t.active ? "ad-dot ad-dot--good" : "ad-dot ad-dot--none"} aria-hidden="true" />
            <span>{t.name}</span>
          </Link>
        ))}
      </nav>

      {params.new !== undefined ? (
        <section className="ad-panel ad-editor" aria-labelledby="new-menu">
          <div className="ad-panel-head"><h2 id="new-menu">New menu</h2></div>
          <div className="ad-panel-body"><TemplateForm t={null} payload={payload} /></div>
        </section>
      ) : open ? (
        <MenuDetail t={open} payload={payload} params={params} />
      ) : (
        <section className="ad-panel" aria-label="Menus">
          <div className="ad-scroll">
            <table className="ad-table">
              <thead>
                <tr>
                  <th scope="col">Menu</th>
                  <th scope="col">Matches</th>
                  <th scope="col" className="num">Priority</th>
                  <th scope="col" className="num">Slots</th>
                </tr>
              </thead>
              <tbody>
                {payload.templates.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/admin/menus?template=${t.id}`} prefetch={false} className="ad-strong">{t.name}</Link>{" "}
                      {t.active ? null : <Badge>Off</Badge>}
                    </td>
                    <td>{t.conditions_line}</td>
                    <td className="num">{t.priority}</td>
                    <td className="num">{t.slots.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ad-panel-foot">
            <p className="ad-help">The most specific menu that matches a deal wins, then the higher priority, then the most recently changed.</p>
          </div>
        </section>
      )}

      {params.new === undefined && !open ? <NeedsDescription payload={payload} /> : null}
    </>
  );
}
