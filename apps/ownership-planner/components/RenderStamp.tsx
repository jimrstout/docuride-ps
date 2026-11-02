// components/RenderStamp.tsx: a hidden marker, new on every server render.
//
// Details' busy state waits for it to change before it ends, so the spinner
// and the disabled buttons stay up until the page the action answered with is
// actually on the screen (components/Working.tsx, lib/working.ts). A server
// component: the value is made where the page is rendered, never in the
// browser.

import { randomUUID } from "node:crypto";
import { RENDER_STAMP_ATTR } from "@/lib/working";

export default function RenderStamp() {
  return <span hidden {...{ [RENDER_STAMP_ATTR]: randomUUID() }} />;
}
