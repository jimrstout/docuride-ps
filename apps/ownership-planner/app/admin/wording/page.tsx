// app/admin/wording/page.tsx: the words a buyer reads, as the console edits them.
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
// Behind the admin layout's sign-in: the check runs before anything is fetched, and every read and write goes through lib/edge.ts on the webhook
// secret. The browser holds no Supabase key here either.

import { currentOperator } from "@/lib/admin-session";
import { edge } from "@/lib/edge";
import type { ConsoleSettingsPayload, ConsoleTemplateRow } from "@/lib/types";
import { saveSettings } from "@/app/console-actions";
import { Badge, Notice, PageHead } from "@/components/admin/Parts";

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
  tone: "good" | "warn";
  text: string;
} | null {
  if (params.saved !== undefined) return { tone: "good", text: "Saved." };
  if (typeof params.refused === "string") return { tone: "warn", text: params.refused };
  if (params.savefailed !== undefined) {
    return {
      tone: "warn",
      text: "That could not be saved just now. Nothing was changed. Try again shortly.",
    };
  }
  return null;
}

function TemplateField({ row }: { row: ConsoleTemplateRow }) {
  const title = TEMPLATE_TITLES[row.template_key] ?? row.template_key;
  const isOverride = row.source === "Tenant";
  const id = `template-${row.template_key.replace(/[^a-z0-9]+/gi, "-")}`;

  return (
    <section className="ad-panel">
      <div className="ad-panel-head">
        <h2>
          <label htmlFor={id}>{title}</label>
        </h2>
        <Badge tone={isOverride ? "good" : "plain"}>
          {row.source === "Tenant" ? "Your wording" : row.source}
        </Badge>
      </div>
      <div className="ad-panel-body">
        {TEMPLATE_NOTES[row.template_key] ? (
          <p className="ad-help">{TEMPLATE_NOTES[row.template_key]}</p>
        ) : null}

        <textarea
          id={id}
          name={`template:${row.template_key}`}
          rows={3}
          defaultValue={row.body ?? ""}
          spellCheck
        />

        <p className="ad-help">
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
          <div className="ad-quote">
            <span className="ad-quote-label">A customer reads</span>
            <q>{row.preview}</q>
            {row.preview_uses_sample_amount ? (
              <span className="ad-help">Using $100 as an example amount.</span>
            ) : null}
          </div>
        ) : (
          <div className="ad-quote">
            <span className="ad-quote-label">A customer reads</span>
            <span className="ad-help">
              Nothing. This line is left out until every placeholder has a value,
              which usually means the dealer group name above is still empty.
            </span>
          </div>
        )}

        {isOverride && row.platform_default ? (
          <p className="ad-help">
            Clear the box and save to go back to the standard wording:{" "}
            <q>{row.platform_default}</q>
          </p>
        ) : null}
      </div>
    </section>
  );
}

async function Settings({ params }: {
  params: Record<string, string | string[] | undefined>;
}) {
  let payload: ConsoleSettingsPayload;
  try {
    payload = await edge.adminSettings<ConsoleSettingsPayload>();
  } catch (err) {
    console.error("console settings load failed:", err);
    return (
      <>
        <PageHead title="Wording" subtitle="The words a customer reads in the planner." />
        <Notice tone="warn">Wording is unavailable right now. Try again shortly.</Notice>
      </>
    );
  }

  const flash = notice(params);

  return (
    <>
      <PageHead title="Wording" subtitle="The words a customer reads in the planner.">
        <span className="ad-help">Editing {payload.tenant.name}</span>
      </PageHead>

      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <form action={saveSettings} className="ad-form">
        <section className="ad-panel">
          <div className="ad-panel-head">
            <h2>
              <label htmlFor="dealer-group-name">Dealer group name</label>
            </h2>
          </div>
          <div className="ad-panel-body">
            <p className="ad-help">
              How the group is named to a customer, for example ASP Group. This
              appears in the planner and in any wording below that refers to the
              group. It is not the administrative name.
            </p>
            <input
              id="dealer-group-name"
              type="text"
              name="dealer_group_display_name"
              defaultValue={payload.tenant.dealer_group_display_name ?? ""}
              maxLength={120}
              autoComplete="off"
              placeholder="Not set"
            />
            <p className="ad-help">
              Leave it empty and any sentence that names the group is left out
              rather than shown with a gap in it.
            </p>
          </div>
        </section>

        {payload.templates.map((row) => (
          <TemplateField key={row.template_key} row={row} />
        ))}

        <div className="ad-form-actions">
          <button type="submit" className="ad-btn ad-btn--primary">
            Save
          </button>
        </div>
      </form>
    </>
  );
}

export default async function WordingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The layout shows the sign-in form to anyone not signed in. Checked here as
  // well, from the same cached answer, so nothing is fetched for them.
  const operator = await currentOperator();
  if (!operator) return null;

  return <Settings params={await searchParams} />;
}
