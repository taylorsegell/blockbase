interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

/** Send a message to the extension host; a no-op outside a webview (e.g. plain browser). */
export function postMessage(message: unknown): void {
  if (!api && typeof acquireVsCodeApi === "function") {
    api = acquireVsCodeApi();
  }
  api?.postMessage(message);
}
