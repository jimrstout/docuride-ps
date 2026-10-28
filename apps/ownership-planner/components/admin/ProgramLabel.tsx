// components/admin/ProgramLabel.tsx: TecAssured's program name, for staff.
//
// Our names are shared by twins: "Priority Maintenance, Bronze" is a UTV, an
// On-Road and an Off-Road MC program at TecAssured, and only the right one can
// be contracted for a vehicle. This small label says which. Staff screens
// only; the planner never shows it.

export default function ProgramLabel({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  return (
    <span className="prog-label" title="The provider's program name. Customers never see it.">
      {name}
    </span>
  );
}
