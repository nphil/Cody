"use client";

import { memo, useId, useState } from "react";
import { Activity, ChevronDown } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { AgentMessage, ImageContent } from "@/lib/types";
import { ClickableImage } from "./ImageLightbox";
import { imageSource } from "./MessageView";

const ActivityImage = memo(function ActivityImage({ image }: { image: ImageContent }) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);
  const src = imageSource(image);
  return (
    <div>
      {src && <ClickableImage src={src} alt={t("chatWindow.backgroundImage")} className="background-activity__image" />}
      <button type="button" className="background-activity__raw-toggle" aria-expanded={showRaw} onClick={() => setShowRaw((open) => !open)}>
        {t(showRaw ? "chatWindow.hideRawImage" : "chatWindow.showRawImage")}
      </button>
      {showRaw && <pre>{JSON.stringify(image, null, 2)}</pre>}
    </div>
  );
});

const ActivityEvent = memo(function ActivityEvent({ message }: { message: AgentMessage }) {
  const { content, ...metadata } = message as AgentMessage & { content?: unknown };
  return (
    <div className="background-activity__event">
      {typeof content === "string" ? <pre>{content}</pre> : Array.isArray(content) ? content.map((block: unknown, index: number) => {
        if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
          const extra = Object.fromEntries(Object.entries(block).filter(([key]) => key !== "type" && key !== "text"));
          return <div key={index}><pre>{block.text}</pre>{Object.keys(extra).length > 0 && <pre>{JSON.stringify(extra, null, 2)}</pre>}</div>;
        }
        if (block && typeof block === "object" && "type" in block && block.type === "image") {
          return <ActivityImage key={index} image={block as ImageContent} />;
        }
        return <pre key={index}>{JSON.stringify(block, null, 2)}</pre>;
      }) : content !== undefined ? <pre>{JSON.stringify(content, null, 2)}</pre> : null}
      <pre>{JSON.stringify(metadata, null, 2)}</pre>
    </div>
  );
});

/** Internal events remain unparsed and unmounted until the reader asks for them. */
export function BackgroundActivity({ messages, indices, needsReview = false }: { messages: AgentMessage[]; indices: number[]; needsReview?: boolean }) {
  const { t, tn } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  return (
    <div className="background-activity">
      <button type="button" className="background-activity__toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((open) => !open)}>
        <Activity size={14} aria-hidden="true" />
        <span>{t("chatWindow.backgroundActivity")} · {tn("chatWindow.backgroundEventCount", indices.length)}</span>
        {needsReview && <span className="background-activity__review">{t("chatWindow.reviewBackgroundResults")}</span>}
        <ChevronDown size={14} aria-hidden="true" className="background-activity__chevron" />
      </button>
      {expanded && (
        <div id={detailsId} className="background-activity__details">
          {indices.map((index) => <ActivityEvent key={index} message={messages[index]} />)}
        </div>
      )}
    </div>
  );
}
