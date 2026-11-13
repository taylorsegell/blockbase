import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { COMMANDS } from "../config";
import { activate } from "../extension";
import { CatalogPanel } from "../panel/catalogPanel";
import { buildCatalogUrl, catalogHash, parseCatalogTarget } from "../panel/catalogUrl";
import { getWebviewHtml } from "../panel/getWebviewHtml";
import { DEFAULT_UI_PORT, resolveCatalogPort } from "../panel/resolvePort";
import { fakeRunner, ok, recorded } from "./fakeCli";

const mock = vscode as unknown as typeof import("./mocks/vscode");

describe("catalogHash", () => {
  it("routes blocks, collections and home the way the catalog page does", () => {
    expect(catalogHash(undefined)).toBe("home");
    expect(catalogHash({ blockId: "acme/button" })).toBe("block/acme%2Fbutton");
    expect(catalogHash({ collectionId: "my set" })).toBe("collection/my%20set");
    expect(catalogHash({ categoryId: "ai-parts" })).toBe("category/ai-parts");
    expect(catalogHash({ bucketId: "a/b" })).toBe("bucket/a%2Fb");
  });
});

describe("parseCatalogTarget", () => {
  it("accepts block, collection, category and bucket targets and ignores anything else", () => {
    expect(parseCatalogTarget({ blockId: "a" })).toEqual({ blockId: "a" });
    expect(parseCatalogTarget({ collectionId: "c" })).toEqual({ collectionId: "c" });
    expect(parseCatalogTarget({ categoryId: "heroes" })).toEqual({ categoryId: "heroes" });
    expect(parseCatalogTarget({ bucketId: "brick" })).toEqual({ bucketId: "brick" });
    expect(parseCatalogTarget({ categoryId: "" })).toBeUndefined();
    expect(parseCatalogTarget({ bucketId: 1 })).toBeUndefined();
    expect(parseCatalogTarget(undefined)).toBeUndefined();
    expect(parseCatalogTarget({ blockId: "" })).toBeUndefined();
    expect(parseCatalogTarget({ blockId: 3 })).toBeUndefined();
    expect(parseCatalogTarget("a")).toBeUndefined();
  });
});

describe("buildCatalogUrl", () => {
  it("points at 127.0.0.1 with embedded mode, the IDE theme and the route hash", () => {
    const url = buildCatalogUrl({ port: 5000, theme: "light", target: { blockId: "x" } });
    expect(url).toBe("http://127.0.0.1:5000/?embedded=1&host=vscode&theme=light#block/x");
  });

  it("rejects ports outside 1-65535", () => {
    expect(() => buildCatalogUrl({ port: 0, theme: "dark" })).toThrow();
    expect(() => buildCatalogUrl({ port: 70000, theme: "dark" })).toThrow();
  });
});

describe("resolveCatalogPort", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bb-ext-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prefers the setting, then the service inventory, then the default", () => {
    expect(resolveCatalogPort({ setting: 0, catalogRoot: dir })).toBe(DEFAULT_UI_PORT);
    writeFileSync(path.join(dir, ".blockbase-service.json"), JSON.stringify({ port: 51234 }));
    expect(resolveCatalogPort({ setting: 0, catalogRoot: dir })).toBe(51234);
    expect(resolveCatalogPort({ setting: 40000, catalogRoot: dir })).toBe(40000);
  });

  it("falls back to the default on a broken inventory", () => {
    writeFileSync(path.join(dir, ".blockbase-service.json"), "{nope");
    expect(resolveCatalogPort({ setting: 0, catalogRoot: dir })).toBe(DEFAULT_UI_PORT);
    writeFileSync(path.join(dir, ".blockbase-service.json"), JSON.stringify({ port: "1" }));
    expect(resolveCatalogPort({ setting: 0, catalogRoot: dir })).toBe(DEFAULT_UI_PORT);
  });
});

describe("getWebviewHtml with a catalog frame", () => {
  it("allows framing only the catalog origin and hands the src to the webview", () => {
    const webview = { cspSource: "vscode-resource:", asWebviewUri: (u: unknown) => u };
    const html = getWebviewHtml(webview as never, mock.Uri.file("/ext") as never, "abc", {
      origin: "http://127.0.0.1:5000",
      src: "http://127.0.0.1:5000/?embedded=1#home",
    });
    expect(html).toContain("frame-src http://127.0.0.1:5000");
    expect(html).toContain('data-src="http://127.0.0.1:5000/?embedded=1#home"');
  });
});

describe("CatalogPanel", () => {
  beforeEach(() => {
    mock.reset();
  });

  function panel() {
    return new CatalogPanel(mock.Uri.file("/ext") as never, () => 5000);
  }

  it("reuses one panel and navigates it by hash", async () => {
    const p = panel();
    await p.show();
    await p.show({ blockId: "b1" });
    await p.show({ collectionId: "c1" });
    expect(mock.registered.panels).toHaveLength(1);
    const last = mock.lastPanel();
    expect(last.revealCount).toBe(2);
    expect(last.webview.html).toContain("#home");
    expect(last.posted).toEqual([
      { type: "blockbase:navigate", src: "http://127.0.0.1:5000/?embedded=1&host=vscode&theme=dark#block/b1" },
      { type: "blockbase:navigate", src: "http://127.0.0.1:5000/?embedded=1&host=vscode&theme=dark#collection/c1" },
    ]);
  });

  it("keeps focus where it is when asked to preserve it, and takes focus otherwise", async () => {
    const p = panel();
    await p.show({ blockId: "b1" }, { preserveFocus: true });
    expect(mock.lastPanel().showOptions).toEqual({ viewColumn: 1, preserveFocus: true });
    await p.show({ blockId: "b2" }, { preserveFocus: true });
    await p.show({ blockId: "b3" });
    expect(mock.lastPanel().revealFocus).toEqual([true, false]);
  });

  it("creates a fresh panel after the old one is closed", async () => {
    const p = panel();
    await p.show();
    mock.lastPanel().close();
    await p.show({ blockId: "b2" });
    expect(mock.registered.panels).toHaveLength(2);
    expect(mock.lastPanel().webview.html).toContain("#block/b2");
  });

  it("rebuilds the page when the port changed since it opened", async () => {
    let port = 5000;
    const p = new CatalogPanel(mock.Uri.file("/ext") as never, () => port);
    await p.show();
    port = 6000;
    await p.show({ blockId: "b3" });
    const last = mock.lastPanel();
    expect(last.posted).toEqual([]);
    expect(last.webview.html).toContain("frame-src http://127.0.0.1:6000");
    expect(last.webview.html).toContain("#block/b3");
  });

  it("uses the helper-mapped origin for frame-src, data-src and navigation", async () => {
    mock.env.externalUris.set("http://127.0.0.1:5000/", "https://fwd.example.test/");
    const p = panel();
    await p.show();
    const last = mock.lastPanel();
    expect(last.webview.html).toContain("frame-src https://fwd.example.test");
    expect(last.webview.html).toContain('data-src="https://fwd.example.test/?embedded=1');
    await p.show({ blockId: "b" });
    expect(last.posted).toEqual([{ type: "blockbase:navigate", src: expect.stringMatching(/^https:\/\/fwd\.example\.test\//) }]);
  });

  it("passes a light IDE theme through", async () => {
    mock.window.activeColorTheme.kind = mock.ColorThemeKind.Light;
    await panel().show();
    expect(mock.lastPanel().webview.html).toContain("theme=light");
  });
});

describe("open catalog command", () => {
  beforeEach(() => {
    mock.reset();
    // Never read the real ~/.blocks service inventory from tests.
    mock.configValues.set("blockbase.port", 5000);
  });

  it("accepts a deep-link target and ignores unknown arguments", async () => {
    const runner = fakeRunner({
      "catalog list": recorded.list(),
      "catalog locate": recorded.locate(),
      "ui status": ok(JSON.stringify({ ok: true, data: { running: true, url: "http://127.0.0.1:5000" } })),
    });
    activate({ subscriptions: [], extensionUri: mock.Uri.file("/ext") } as never, runner);
    const run = mock.registered.commands.get(COMMANDS.openPanel)!;
    await run({ blockId: "deep" });
    await run({ label: "a tree item" });
    const last = mock.lastPanel();
    expect(last.webview.html).toContain("#block/deep");
    expect(last.posted.at(-1)).toEqual({ type: "blockbase:navigate", src: expect.stringContaining("#home") });
  });
});
