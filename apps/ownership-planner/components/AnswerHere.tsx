"use client";

// components/AnswerHere.tsx: a Details action that updates the page from its own answer.
//
// Every action fni-session-verify takes answers with the whole sheet, built by
// the function Details loads with (lib/details-offer.ts sheetFromReply). The
// page puts that sheet up in place of drawing itself again, which read the
// deal and ran the DX1 check a second time and could leave the busy state up
// for 90 seconds when Next dropped the redraw (#148, deal 07982). Details
// provides the wrapper; a form deeper down (the buyer, co-buyer and
// lienholder panels) takes it from here, marks itself
// data-working-redraw="none", and posts through it.

import { createContext, useContext } from "react";
import { useRouter } from "next/navigation";
import type { SheetAnswer } from "@/app/console-actions";

export type SheetAction = (fd: FormData) => Promise<SheetAnswer>;
export type Here = (action: SheetAction) => (fd: FormData) => Promise<void>;

const HereContext = createContext<Here | null>(null);

export const AnswerHereProvider = HereContext.Provider;

/** The page's wrapper; outside Details, the action and then a fresh draw of the page, as before. */
export function useHere(): Here {
  const here = useContext(HereContext);
  const router = useRouter();
  return here ?? ((action) => async (fd) => {
    await action(fd);
    router.refresh();
  });
}
