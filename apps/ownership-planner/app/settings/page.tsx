// app/settings/page.tsx: moved to the admin area's Wording section.
//
// Kept as a redirect so bookmarks and old links still land in the right place.
// Any query string is carried across.

import { redirect } from "next/navigation";

export default async function Moved({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) params.append(k, one);
  }
  const query = params.toString();
  redirect(query ? `/admin/wording?${query}` : "/admin/wording");
}
