import { useEffect, useRef, useState } from "react";
import { postMessage } from "./vscode";
import { relayHandoff, watchFrameLoad } from "./relay";

/** Initial catalog URL, written by the extension into `#root[data-src]`. */
function initialSrc(): string | undefined {
  return document.getElementById("root")?.dataset.src || undefined;
}

/**
 * Accept a navigate message only if it keeps the frame on the same origin.
 * The CSP frame-src already blocks other origins; this keeps the error out of the console.
 */
export function nextSrc(current: string, message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { type, src } = message as { type?: unknown; src?: unknown };
  if (type !== "blockbase:navigate" || typeof src !== "string") return undefined;
  try {
    return new URL(src).origin === new URL(current).origin ? src : undefined;
  } catch {
    return undefined;
  }
}

/** Frames the local catalog page. The extension moves it between blocks by changing the hash. */
export function App() {
  // State only seeds the first render. The catalog page changes its own hash as the user
  // navigates, so later deep links set the frame's src directly, even to an equal value.
  const [src] = useState(initialSrc);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const el = frame.current;
      if (!el) return;
      // Messages from the framed page are never navigation commands.
      if (event.source === el.contentWindow) return;
      const next = src ? nextSrc(src, event.data) : undefined;
      if (next) el.src = next;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src]);

  // Pass a copy-handoff request from the catalog page on to the extension. Only the object
  // `relayHandoff` returns is posted, never the page's own message.
  useEffect(() => {
    if (!src) return;
    const catalogOrigin = new URL(src).origin;
    const onMessage = (event: MessageEvent) => {
      const relayed = relayHandoff(event, catalogOrigin, frame.current?.contentWindow);
      if (relayed) postMessage(relayed);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src]);

  // Ask the extension to re-check the service when the frame errors or never loads.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    return watchFrameLoad(el, postMessage);
  }, [src]);

  if (!src) {
    return (
      <main className="bb-empty">
        <h1>Blockbase</h1>
        <p>No catalog address. Run "Blockbase: Open Catalog" again.</p>
      </main>
    );
  }
  return (
    <iframe
      ref={frame}
      className="bb-frame"
      title="Blockbase catalog"
      src={src}
      allow="clipboard-write; clipboard-read"
    />
  );
}
