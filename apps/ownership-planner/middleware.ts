// middleware.ts: tells the admin layout which page was asked for.
//
// A Next layout is not given the request's path or query string. The admin
// layout needs both: the path, to highlight the section in the menu and to send
// someone back to it after signing in, and the query, to show the sign-in
// notices (?denied=1 and the rest) that the actions redirect with. Set here, on
// the request, and only for /admin. Whatever a client sent in these headers is
// overwritten, and the layout still validates the path before using it.

import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-admin-path", req.nextUrl.pathname);
  headers.set("x-admin-search", req.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/admin/:path*"] };
