/**
 * Lets the catalog page ask its host (the VS Code panel) to copy a block's handoff.
 * The page is framed by the panel with `host=vscode`; anywhere else this does nothing.
 * Erasable TypeScript only and no imports, so Node can run it directly in tests.
 */
export interface HostWindow {
  location: { search: string };
  parent: { postMessage(message: unknown, targetOrigin: string): void };
}

/**
 * Posts `{ type: "blockbase:copy-handoff", componentId }` to the parent window and returns true,
 * but only when the page is framed and the query has `host=vscode`. The target origin is "*"
 * because the message carries only an id; the receiving relay checks who sent it.
 */
export function sendHandoffToHost(componentId: string, win?: HostWindow): boolean {
  const target = win ?? (globalThis as unknown as { window?: HostWindow }).window;
  if (!target) return false;
  if ((target.parent as unknown) === (target as unknown)) return false;
  if (new URLSearchParams(target.location.search).get('host') !== 'vscode') return false;
  target.parent.postMessage({ type: 'blockbase:copy-handoff', componentId }, '*');
  return true;
}
