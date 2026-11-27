import { handleWirelessShell } from "@/lib/devices/wireless-service-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return handleWirelessShell(request);
}
