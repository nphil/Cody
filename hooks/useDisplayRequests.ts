"use client";

import { useEffect, useRef, useState } from "react";
import { usePageWake } from "@/hooks/usePageWake";
import { openLiveStream, type LiveStream } from "@/lib/live-stream";
import type { DisplayBusEvent, DisplayRequestV1 } from "@/lib/display/types";

export function useDisplayRequests(sessionId: string | null, onLiveRequest: (request: DisplayRequestV1) => void): DisplayRequestV1 | null {
  const [request, setRequest] = useState<DisplayRequestV1 | null>(null);
  const liveHandler = useRef(onLiveRequest);
  liveHandler.current = onLiveRequest;
  const streamRef = useRef<LiveStream | null>(null);

  useEffect(() => {
    setRequest(null);
    if (!sessionId) return;
    // No silence limit: the bus is quiet until the agent publishes something.
    const stream = openLiveStream({
      url: `/api/agent/${encodeURIComponent(sessionId)}/display/events`,
      onMessage: (message) => {
        try {
          const event = JSON.parse(message.data) as DisplayBusEvent;
          if ((event.type !== "snapshot" && event.type !== "request") || !("request" in event)) return;
          setRequest(event.request);
          if (event.type === "request" && event.request) liveHandler.current(event.request);
        } catch { /* malformed/reconnect frames are ignored */ }
      },
    });
    streamRef.current = stream;
    return () => {
      stream.close();
      if (streamRef.current === stream) streamRef.current = null;
    };
  }, [sessionId]);

  // A page that slept holds this stream open on paper only. A new connection
  // is greeted with the current request (a snapshot, which never re-runs the
  // live handler, so waking does not re-open the panel).
  usePageWake(() => streamRef.current?.reopen());

  return request;
}
