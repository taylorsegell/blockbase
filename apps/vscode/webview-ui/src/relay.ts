/**
 * Pure helpers for the webview. They import nothing so vitest can run them in plain Node.
 */

/** How long the catalog frame gets to fire `load` before the webview reports it as failed. */
export const FRAME_LOAD_TIMEOUT_MS = 10_000;

/** The slice of an iframe element that `watchFrameLoad` needs. */
export interface FrameEvents {
  addEventListener(type: "load" | "error", listener: () => void): void;
  removeEventListener(type: "load" | "error", listener: () => void): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers = (): Timers => ({
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

/**
 * Posts `{ type: "blockbase:frame-error" }` once if the frame fires `error`, or if `load` has not
 * fired within `ms`. Does nothing once `load` fires. Returns a cleanup function.
 *
 * This is approximate by design: a refused connection can still fire `load` on the browser's
 * error page, so the extension's own status check before loading stays the main guard.
 */
export function watchFrameLoad(
  frame: FrameEvents,
  post: (message: { type: "blockbase:frame-error" }) => void,
  timers: Timers = realTimers(),
  ms: number = FRAME_LOAD_TIMEOUT_MS,
): () => void {
  let settled = false;
  let timer: unknown;

  const cleanup = () => {
    settled = true;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    frame.removeEventListener("load", onLoad);
    frame.removeEventListener("error", onError);
  };
  const onLoad = () => {
    if (!settled) cleanup();
  };
  const onError = () => {
    if (settled) return;
    cleanup();
    post({ type: "blockbase:frame-error" });
  };

  frame.addEventListener("load", onLoad);
  frame.addEventListener("error", onError);
  timer = timers.setTimeout(onError, ms);
  return cleanup;
}

/** Page -> webview -> host: copy the handoff for this component. */
export const COPY_HANDOFF_TYPE = "blockbase:copy-handoff";

/** Same pattern as `HANDOFF_ID_PATTERN` in src/panel/catalogPanel.ts (webview code cannot import extension code). */
export const HANDOFF_ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,200}$/;

export interface CopyHandoffMessage {
  type: "blockbase:copy-handoff";
  componentId: string;
}

/**
 * Returns the one message the webview may pass to the extension, or undefined. Accepts only the
 * catalog origin, the catalog iframe's own window, the exact type and a bounded id. The result is
 * a new object, never the page's own data.
 */
export function relayHandoff(
  event: { origin: string; source: unknown; data: unknown },
  catalogOrigin: string,
  frameWindow: unknown,
): CopyHandoffMessage | undefined {
  if (event.origin !== catalogOrigin) return undefined;
  if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow) return undefined;
  if (typeof event.data !== "object" || event.data === null) return undefined;
  const { type, componentId } = event.data as { type?: unknown; componentId?: unknown };
  if (type !== COPY_HANDOFF_TYPE) return undefined;
  if (typeof componentId !== "string" || !HANDOFF_ID_PATTERN.test(componentId)) return undefined;
  return { type: COPY_HANDOFF_TYPE, componentId };
}
