/**
 * Standalone "catalog page isn't running" HTML. The panel shows it in place of the iframe; each
 * button posts `{ type: "blockbase.service", action }` back to the extension.
 */
import type { ServiceState } from "./status";
import type { ServiceAction } from "./serviceRecovery";

export const SERVICE_MESSAGE_TYPE = "blockbase.service";

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function button(action: ServiceAction, label: string): string {
  return `<button data-action="${action}">${label}</button>`;
}

function body(state: ServiceState): string {
  switch (state.kind) {
    case "no-service":
      return `<h2>The catalog page isn't running</h2><p>No Blockbase service is installed.</p>${button("install", "Install service")}${button("runSession", "Run for this session")}`;
    case "installed-down":
      return `<h2>The catalog page isn't running</h2><p>The Blockbase service is installed but not answering.</p>${button("restart", "Restart")}`;
    case "starting":
      return `<h2>Starting the catalog page…</h2><p>This view reloads once the page answers.</p>`;
    case "unknown":
      return `<h2>Can't reach Blockbase</h2><p>${escape(state.reason)}</p>${button("retry", "Check again")}`;
    case "up":
      return `<h2>The catalog page is running</h2>`;
  }
}

export function renderNotRunningHtml(state: ServiceState, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>Blockbase</title>
</head>
<body>
${body(state)}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.querySelectorAll("button[data-action]").forEach((b) =>
  b.addEventListener("click", () => vscode.postMessage({ type: "${SERVICE_MESSAGE_TYPE}", action: b.dataset.action })));
</script>
</body>
</html>`;
}
