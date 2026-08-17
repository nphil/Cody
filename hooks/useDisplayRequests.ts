"use client";

import { useEffect, useRef, useState } from "react";
import type { DisplayBusEvent, DisplayRequestV1 } from "@/lib/display/types";

export function useDisplayRequests(sessionId: string | null, onLiveRequest: (request: DisplayRequestV1) => void): DisplayRequestV1 | null {
  const [request, setRequest] = useState<DisplayRequestV1 | null>(null);
  const liveHandler = useRef(onLiveRequest);
  liveHandler.current = onLiveRequest;

  useEffect(() => {
    setRequest(null);
    if (!sessionId) return;
    const source = new EventSource(`/api/agent/${encodeURIComponent(sessionId)}/display/events`);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as DisplayBusEvent;
        if ((event.type !== "snapshot" && event.type !== "request") || !("request" in event)) return;
        setRequest(event.request);
        if (event.type === "request" && event.request) liveHandler.current(event.request);
      } catch { /* malformed/reconnect frames are ignored */ }
    };
    return () => source.close();
  }, [sessionId]);

  return request;
}
