// app/admin/page.tsx: the admin area opens on Sessions.

import { redirect } from "next/navigation";
import { ADMIN_HOME } from "@/lib/admin-sections";

export default function AdminIndex() {
  redirect(ADMIN_HOME);
}
