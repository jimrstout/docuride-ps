// _shared/submit-parties.ts
//
// The keys a submit adds to the quote for the people on the contract, beyond
// buyerFirstName, buyerLastName and buyerAddress. Read from the contract
// parties as they stand: the staff value over the CRM value, and blank for a
// party staff removed (applyStaffEdits, _shared/contract-parties.ts).
//
// TecAssured documents none of these. The field probe found them on the
// Riders Advantage contract (docs/multi-provider.md, section 16):
//
//   cobuyerFirstName / cobuyerLastName   the second contract holder line
//                                        (VLBT3440876-42153, VLBT3440876-42274)
//
// Pure, so a Node test can hold it.

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/**
 * cobuyerFirstName and cobuyerLastName, or nothing when there is no co-buyer.
 *
 * A Company co-buyer prints by its business name, the name the contract
 * parties lead with for a business (contractParties' heading): the name goes
 * in cobuyerLastName and cobuyerFirstName is left empty. The buyer has no
 * company rule of its own on the submit (it sends first and last name only),
 * so this is the rule. A person with no first or last name prints by the name
 * as it prints, the same fallback the heading uses.
 */
export function cobuyerKeys(party: Record<string, unknown>): Record<string, string> {
  const display = text(party.cobuyer_display_name);
  if (text(party.cobuyer_type) === "Company") {
    return display ? { cobuyerFirstName: "", cobuyerLastName: display } : {};
  }
  const first = text(party.cobuyer_first_name);
  const last = text(party.cobuyer_last_name);
  if (first || last) return { cobuyerFirstName: first, cobuyerLastName: last };
  return display ? { cobuyerFirstName: "", cobuyerLastName: display } : {};
}
