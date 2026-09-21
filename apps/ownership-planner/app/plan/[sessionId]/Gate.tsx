// The states where there is no plan to show.
//
// An expired link and a mistyped one are ordinary events rather than faults, so
// they read like it: no error colour, no apology, and a next step the customer
// can actually take. They sit in the same shell as the planner so a bad link
// still lands somewhere that plainly belongs to the same application.

import AppShell from "@/components/AppShell";

export default function Gate({ title, body }: { title: string; body: string }) {
  return (
    <AppShell>
      <div className="gate">
        <div className="gate-card">
          <p className="eyebrow eyebrow--rule">Ownership planner</p>
          <h1 className="display display--sm">{title}</h1>
          <p className="lede">{body}</p>
        </div>
      </div>
    </AppShell>
  );
}
