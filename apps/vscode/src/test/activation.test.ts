import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { activate } from "../extension";
import { CATALOG_VIEW_ID, COMMANDS, CONFIG_SECTION, CONTEXT_KEYS, SETTINGS, VIEW_CONTAINER_ID } from "../config";
import { getWebviewHtml } from "../panel/getWebviewHtml";
import { fakeRunner, ok, recorded } from "./fakeCli";

const mock = vscode as unknown as typeof import("./mocks/vscode");
const manifest = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));

const runner = () =>
  fakeRunner({
    "catalog list": recorded.list(),
    "catalog locate": recorded.locate(),
    "ui status": ok(JSON.stringify({ ok: true, data: { running: true, url: "http://127.0.0.1:5000" } })),
  });

function fakeContext() {
  return { subscriptions: [] as { dispose(): void }[], extensionUri: mock.Uri.file("/ext") };
}

describe("activation", () => {
  beforeEach(() => {
    mock.reset();
    mock.registered.watchers.length = 0;
    // Never read the real ~/.blocks service inventory from tests.
    mock.configValues.set("blockbase.port", 5000);
  });

  it("registers the sidebar view and every contributed command", () => {
    const ctx = fakeContext();
    activate(ctx as unknown as import("vscode").ExtensionContext, runner());
    expect(mock.registered.treeViews).toEqual([CATALOG_VIEW_ID]);
    expect([...mock.registered.commands.keys()].sort()).toEqual(Object.values(COMMANDS).sort());
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
  });

  it("opens the catalog panel from its command", async () => {
    activate(fakeContext() as unknown as import("vscode").ExtensionContext, runner());
    await mock.registered.commands.get(COMMANDS.openPanel)?.();
    expect(mock.registered.panels).toEqual(["blockbase.catalogPanel"]);
  });
});

describe("manifest", () => {
  it("has the id arkitect.blockbase", () => {
    expect(`${manifest.publisher}.${manifest.name}`).toBe("arkitect.blockbase");
  });

  it("contributes the ids the code uses", () => {
    expect(manifest.contributes.viewsContainers.activitybar[0].id).toBe(VIEW_CONTAINER_ID);
    expect(manifest.contributes.views[VIEW_CONTAINER_ID][0].id).toBe(CATALOG_VIEW_ID);
    const ids = manifest.contributes.commands.map((c: { command: string }) => c.command).sort();
    expect(ids).toEqual(Object.values(COMMANDS).sort());
    const settings = Object.keys(manifest.contributes.configuration.properties).sort();
    expect(settings).toEqual(Object.values(SETTINGS).map((s) => `${CONFIG_SECTION}.${s}`).sort());
  });

  it("shows install instructions only when the CLI is missing", () => {
    const welcome = manifest.contributes.viewsWelcome as Array<{ when?: string; contents: string }>;
    const missing = welcome.find((entry) => entry.when === `${CONTEXT_KEYS.cliMissing}`);
    expect(missing?.contents).toContain("npm install -g @blockbase/cli");
    expect(welcome.find((entry) => entry.when === `!${CONTEXT_KEYS.cliMissing}`)).toBeDefined();
  });
});

describe("getWebviewHtml", () => {
  it("uses a nonce-locked CSP", () => {
    const webview = { cspSource: "vscode-resource:", asWebviewUri: (u: unknown) => u };
    const html = getWebviewHtml(webview as never, mock.Uri.file("/ext") as never, "abc");
    expect(html).toContain("script-src 'nonce-abc'");
    expect(html).toContain('nonce="abc"');
  });
});
