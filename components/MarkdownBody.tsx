"use client";

import { Children, cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { resolveLocalFileHref } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { normalizeDisplayMath, useMarkdownPlugins } from "../lib/markdown";
import { markdownCodeRenderer } from "./MarkdownCode";
import { ClickableImage } from "./ImageLightbox";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

/** Slowest cadence at which a growing block re-parses while it streams. The
 *  SSE coalescer delivers updates at display rate, and normalizeDisplayMath +
 *  the whole remark→rehype→react-markdown pass over the accumulated answer is
 *  a 10–40ms task on a long one — the frame budget is gone before layout. */
const STREAMING_PARSE_INTERVAL_MS = 100;

/**
 * The text this block should parse right now: the live text while settled, or
 * a ≤10 Hz sample of it while streaming. Never withholds the final text —
 * `isStreaming` is false the moment the message settles, so the last update
 * always renders in full.
 */
function useParseSource(text: string, isStreaming: boolean | undefined): string {
  const [sampled, setSampled] = useState(text);
  const latestRef = useRef(text);
  const lastFlushRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Written after commit, never during render, so a trailing flush can only
    // ever publish text that was actually committed.
    latestRef.current = text;
    if (!isStreaming) return;
    const flush = () => {
      lastFlushRef.current = Date.now();
      setSampled((prev) => (prev === latestRef.current ? prev : latestRef.current));
    };
    const elapsed = Date.now() - lastFlushRef.current;
    if (elapsed >= STREAMING_PARSE_INTERVAL_MS) {
      flush();
      return;
    }
    // A trailing flush is already pending; it will pick up this text too.
    if (timerRef.current !== null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, STREAMING_PARSE_INTERVAL_MS - elapsed);
  }, [text, isStreaming]);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  return isStreaming ? sampled : text;
}

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile }: MarkdownBodyProps) {
  const parseSource = useParseSource(children, isStreaming);
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(parseSource), [parseSource]);
  const { remarkPlugins, rehypePlugins } = useMarkdownPlugins(normalizedMarkdown);

  // Rebuilt only when its captured props change, not on every render.
  const components = useMemo<Components>(() => {
    const imgComponent = ({ src, alt, ...imgProps }: ComponentProps<"img"> & { node?: unknown }) => {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete (imgProps as { node?: unknown }).node;
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      const imageSrc = filePath
        ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
        : src;
      // Dynamic local paths are served directly by the file API.
      return <ClickableImage src={imageSrc} alt={alt ?? ""} loading="lazy" {...imgProps} />;
    };

    /**
     * Split link children into linked text and previewable images. Images may
     * sit directly or wrapped in formatting (`[**![img](x)**](url)`); a
     * <button> can never nest inside an <a>, so image content is extracted
     * while text (with its formatting) stays linked.
     */
    const isElementWithChildren = (value: unknown): value is ReactElement<{ children?: ReactNode }> => isValidElement(value);
    const partitionLinkContent = (node: ReactNode): { textParts: ReactNode[]; imageParts: ReactNode[] } => {
      const textParts: ReactNode[] = [];
      const imageParts: ReactNode[] = [];
      for (const child of Children.toArray(node)) {
        if (!isElementWithChildren(child)) {
          textParts.push(child);
          continue;
        }
        if (child.type === imgComponent) {
          imageParts.push(child);
          continue;
        }
        const sub = partitionLinkContent(child.props.children);
        if (sub.imageParts.length === 0) {
          textParts.push(child);
        } else if (sub.textParts.length === 0) {
          // Formatting wrapper containing only images moves to the previews.
          imageParts.push(child);
        } else {
          // Mixed wrapper: keep the wrapper with its text, extract the images.
          textParts.push(cloneElement(child, undefined, sub.textParts));
          imageParts.push(...sub.imageParts);
        }
      }
      return { textParts, imageParts };
    };
    /** True when any text part carries non-whitespace content. */
    const hasMeaningfulText = (parts: ReactNode[]): boolean =>
      parts.some((part) => {
        if (typeof part === "string") return part.trim().length > 0;
        if (typeof part === "number") return true;
        if (isElementWithChildren(part)) return hasMeaningfulText(Children.toArray(part.props.children));
        return false;
      });

    return {
    code: markdownCodeRenderer({ isStreaming, inlineClassName: "markdown-inline-code" }),
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const { textParts, imageParts } = partitionLinkContent(children);
      // A <button> cannot nest inside an <a>. Pure image links (direct or
      // wrapped in formatting, possibly with surrounding whitespace) render
      // only the previews — the lightbox supersedes the link. Mixed links
      // keep their text linked and render image previews beside the anchor.
      if (imageParts.length > 0 && !hasMeaningfulText(textParts)) {
        return <>{children}</>;
      }
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (filePath && openFile) {
        const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
          if (event.defaultPrevented || event.button !== 0) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const target = event.currentTarget.getAttribute("target");
          if (target && target !== "_self") return;
          event.preventDefault();
          openFile(filePath);
        };
        const anchor = <a href={href} {...props} onClick={handleClick}>{textParts}</a>;
        return imageParts.length > 0 ? <>{anchor}{imageParts}</> : anchor;
      }

      const anchor = (
        <a href={href} {...props} target="_blank" rel="noopener noreferrer">
          {textParts}
        </a>
      );
      return imageParts.length > 0 ? <>{anchor}{imageParts}</> : anchor;
    },
    img: imgComponent,
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
    };
  }, [isStreaming, cwd, onOpenFile]);

  // Held by identity so a re-render that changed nothing the parse depends on
  // (a re-render between two streaming samples, a parent state change) skips
  // the whole markdown subtree instead of re-parsing and re-reconciling it.
  const parsed = useMemo(() => (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {normalizedMarkdown}
    </ReactMarkdown>
  ), [remarkPlugins, rehypePlugins, components, normalizedMarkdown]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      {parsed}
    </div>
  );
}
