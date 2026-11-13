import * as vscode from "vscode";

export function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

/** The catalog page to frame: its origin (the only allowed frame-src) and the first URL. */
export interface CatalogFrame {
  origin: string;
  src: string;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** HTML shell that loads the Vite bundle from dist/webview with a strict CSP. */
export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  nonce = createNonce(),
  frame?: CatalogFrame,
): string {
  const assets = vscode.Uri.joinPath(extensionUri, "dist", "webview", "assets");
  // Vite names the entry after webview-ui/index.html, so the bundle is index.js / index.css.
  const script = webview.asWebviewUri(vscode.Uri.joinPath(assets, "index.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(assets, "index.css"));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    ...(frame ? [`frame-src ${frame.origin}`] : []),
  ].join("; ");
  const dataSrc = frame ? ` data-src="${escapeAttr(frame.src)}"` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${style}" />
    <title>Blockbase</title>
  </head>
  <body>
    <div id="root"${dataSrc}></div>
    <script type="module" nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}
