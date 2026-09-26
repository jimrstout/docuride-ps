// app/settings/page.tsx — the settings the console can edit.
//
// Two things live here, and both were previously facts written into code:
//
//   The dealer group's customer-facing name. AppShell carried "All Seasons /
//   Powersports & Equipment" in the footer of every planner screen, which is a
//   fact about a business sitting in a React component.
//
//   The disappearing deductible sentence. It names the group and states an
//   amount, the amount comes off the chosen rate, and another group's terms may
//   be narrower. So it is a template with placeholders, and this is where it is
//   worded.
//
// Same door as the session browser: the sign-in check runs before anything is
// fetched, and every read and write goes through lib/edge.ts on the webhook
// secret. The browser holds no Supabase key here either.

import Link from "next/link";
import { redirect } from "next/navigation";
import { currentOperator } from "@/lib/admin-session";
import { edge } from "@/lib/edge";
import type { ConsoleSettingsPayload, ConsoleTemplateRow } from "@/lib/types";
import { saveSettings, signOut } from "../console-actions";

export const dynamic = "force-dynamic";

/** Human titles for the template keys. The key is a slug, not a label. */
const TEMPLATE_TITLES: Record<string, string> = {
  "deductible.disappearing": "Disappearing deductible",
};

const TEMPLATE_NOTES: Record<string, string> = {
  "deductible.disappearing":
    "Shown only for a rate the provider marks as a disappearing deductible. Rates with a plain deductible show the amount on its own.",
};

function notice(params: Record<string, string | string[] | undefined>): {
  tone: "ok" | "bad";
  text: string;
} | null {
  if (params.saved !== undefined) return { tone: "ok", text: "Saved." };
  if (typeof params.refused === "string") return { tone: "bad", text: params.refused };
  if (params.savefailed !== undefined) {
    return {
      tone: "bad",
      text: "That could not be saved just now. Nothing was changed. Try again shortly.",
    };
  }
  return null;
}

function TemplateField({ row }: { row: ConsoleTemplateRow }) {
  const title = TEMPLATE_TITLES[row.template_key] ?? row.template_key;
  const isOverride = row.source === "Tenant";

  return (
    <section className="setting">
      <div className="setting-head">
        <h2>{title}</h2>
        <span className={`tag ${isOverride ? "tag--live" : "tag--quiet"}`}>
          {row.source === "Tenant" ? "Your wording" : row.source}
        </span>
      </div>

      {TEMPLATE_NOTES[row.template_key] ? (
        <p className="setting-note">{TEMPLATE_NOTES[row.template_key]}</p>
      ) : null}

      <label className="setting-field">
        <span className="sr-only">{title} wording</span>
        <textarea
          name={`template:${row.template_key}`}
          rows={3}
          defaultValue={row.body ?? ""}
          spellCheck
        />
      </label>

      <p className="setting-help">
        Placeholders you can use:{" "}
        {row.allowed_placeholders.map((p, i) => (
          <span key={p}>
            {i > 0 ? ", " : ""}
            <code>{`{${p}}`}</code>
          </span>
        ))}
        . The amount comes from the rate the customer chose, so leave it as a
        placeholder and it stays correct if the amount changes.
      </p>

      {row.preview ? (
        <p className="setting-preview">
          <span>A customer reads</span>
          <q>{row.preview}</q>
          {row.preview_uses_sample_amount ? (
            <small>Using $100 as an example amount.</small>
          ) : null}
        </p>
      ) : (
        <p className="setting-preview setting-preview--empty">
          <span>A customer reads</span>
          <em>
            nothing. This line is left out until every placeholder has a value,
            which usually means the dealer group name above is still empty.
          </em>
        </p>
      )}

      {isOverride && row.platform_default ? (
        <p className="setting-help">
          Clear the box and save to go back to the standard wording:{" "}
          <q>{row.platform_default}</q>
        </p>
      ) : null}
    </section>
  );
}

async function Settings({ email, params }: {
  email: string;
  params: Record<string, string | string[] | undefined>;
}) {
  let payload: ConsoleSettingsPayload;
  try {
    payload = await edge.adminSettings<ConsoleSettingsPayload>();
  } catch (err) {
    console.error("console settings load failed:", err);
    return (
      <main className="console">
        <p className="console-empty">
          Settings are unavailable right now. Try again shortly.
        </p>
      </main>
    );
  }

  const flash = notice(params);

  return (
    <main className="console">
      <header className="console-head">
        <div>
          <p className="console-eyebrow">DocuRide PS</p>
          <h1 className="console-title">Settings</h1>
        </div>
        <form action={signOut} className="console-who">
          <span>{email}</span>
          <button type="submit" className="btn btn--quiet">
            Sign out
          </button>
        </form>
      </header>

      <nav className="console-tabs">
        <Link className="btn btn--quiet" href="/" prefetch={false}>
          Session browser
        </Link>
        <span className="console-tab-here">Settings</span>
      </nav>

      {flash ? (
        <p
          className={flash.tone === "ok" ? "console-flash" : "console-flash console-flash--bad"}
          role="status"
        >
          {flash.text}
        </p>
      ) : null}

      <p className="console-note">
        These are the words a buyer reads. Editing {payload.tenant.name}.
      </p>

      <form action={saveSettings} className="settings-form">
        <section className="setting">
          <div className="setting-head">
            <h2>Dealer group name</h2>
          </div>
          <p className="setting-note">
            How the group is named to a customer, for example ASP Group. This
            appears in the planner and in any wording below that refers to the
            group. It is not the administrative name.
          </p>
          <label className="setting-field">
            <span className="sr-only">Dealer group name</span>
            <input
              type="text"
              name="dealer_group_display_name"
              defaultValue={payload.tenant.dealer_group_display_name ?? ""}
              maxLength={120}
              autoComplete="off"
              placeholder="Not set"
            />
          </label>
          <p className="setting-help">
            Leave it empty and any sentence that names the group is left out
            rather than shown with a gap in it.
          </p>
        </section>

        {payload.templates.map((row) => (
          <TemplateField key={row.template_key} row={row} />
        ))}

        <div className="settings-actions">
          <button type="submit" className="btn btn--go">
            Save
          </button>
        </div>
      </form>
    </main>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const operator = await currentOperator();

  // The console's door is the session browser. Someone who is not signed in is
  // sent there to sign in rather than being shown a second sign-in form that
  // would then have to be kept in step with the first.
  if (!operator) redirect("/");

  return <Settings email={operator.email} params={await searchParams} />;
}
