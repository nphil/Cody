import type { Metadata } from "next";
import { DisplayWindow } from "@/components/DisplayWindow";

export const metadata: Metadata = { title: "Display · Cody" };

/** Same-origin pop-out target for the streamed surface. The id is the session
 *  whose latest display request is streamed; the auth perimeter in proxy.ts
 *  gates this route like every other page, and the display socket re-checks
 *  session ownership on upgrade. */
export default async function DisplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DisplayWindow sessionId={id} />;
}
