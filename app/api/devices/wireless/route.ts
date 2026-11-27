import { handleWirelessGet, handleWirelessPost } from "@/lib/devices/wireless-service-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Response {
  return handleWirelessGet(request);
}

export function POST(request: Request): Promise<Response> {
  return handleWirelessPost(request);
}
