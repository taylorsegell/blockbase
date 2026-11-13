import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { BlockbaseCli, CliCommandError, type CatalogList } from "../cli/blockbaseCli";
import { CliNotFoundError, execFileRunner } from "../cli/runner";
import { COMMANDS, CONTEXT_KEYS } from "../config";
import { activate } from "../extension";
import { buildCatalogTree, buildSearchTree, type CatalogNode, type GroupNode } from "../tree/catalogModel";
import { BLOCK_CONTEXT_VALUE, CatalogTreeProvider } from "../tree/catalogTreeProvider";
import { CatalogWatcher, HISTORY_SIGNAL_GLOB } from "../tree/catalogWatcher";
import { placeEntry } from "../tree/placement";
import { fakeRunner, fixture, ok, recorded } from "./fakeCli";

const mock = vscode as unknown as typeof import("./mocks/vscode");

function component(slug: string, category: string, bucket: string | null = null, displayName = slug) {
  return { componentId: `cmp_local_${slug}`, namespace: "local", slug, displayName, description: `About ${slug}`, category, tags: [], bucket };
}

const labels = (nodes: CatalogNode[]) => nodes.map((node) => (node.kind === "block" ? node.component.displayName : node.label));
const group = (nodes: CatalogNode[], label: string) => nodes.find((node) => node.kind !== "block" && node.label === label) as GroupNode;

beforeEach(() => {
  mock.registered.context.clear();
  mock.registered.watchers.length = 0;
  mock.registered.commands.clear();
  mock.registered.inputBoxAnswers.length = 0;
});

describe("BlockbaseCli", () => {
  it("parses the recorded catalog list envelope", async () => {
    const list = await new BlockbaseCli(fakeRunner({ "catalog list": recorded.list() })).listCatalog();
    expect(list.components.map((c) => c.slug)).toEqual(["static-card"]);
    expect(list.components[0]).toMatchObject({ displayName: "Static Card", tags: ["featured"], bucket: null });
    expect(list.collections.map((c) => c.id)).toEqual(["favorites", "ideas"]);
  });

  it("passes the search query as one argument, never through a shell", async () => {
    const run = fakeRunner({ search: recorded.search() });
    const hits = await new BlockbaseCli(run).search('card"; rm -rf ~ #');
    expect(run.calls).toEqual([["search", 'card"; rm -rf ~ #', "--json"]]);
    expect(hits[0].componentId).toBe("cmp_local_static-card");
  });

  it("turns an error envelope into CliCommandError with its code", async () => {
    const envelope = JSON.stringify({ schemaVersion: "1", ok: false, operation: "catalog.list", error: { code: "INDEX_NOT_FOUND", message: "No index." }, warnings: [], recoveryActions: [] });
    const cli = new BlockbaseCli(fakeRunner({ "catalog list": { exitCode: 3, stdout: envelope, stderr: "" } }));
    await expect(cli.listCatalog()).rejects.toMatchObject({ name: "CliCommandError", code: "INDEX_NOT_FOUND", message: "No index." });
  });

  it("rejects unknown schema versions and non-JSON output", async () => {
    const future = fixture("catalog-list.json").replace(/"schemaVersion": "1"/g, '"schemaVersion": "2"');
    await expect(new BlockbaseCli(fakeRunner({ "catalog list": ok(future) })).listCatalog()).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
    await expect(new BlockbaseCli(fakeRunner({ "catalog list": { exitCode: 10, stdout: "", stderr: "boom" } })).listCatalog()).rejects.toBeInstanceOf(CliCommandError);
  });

  it("execFileRunner reports a missing executable as CliNotFoundError", async () => {
    await expect(execFileRunner({ command: "blockbase-definitely-not-installed-417" })(["--json"])).rejects.toBeInstanceOf(CliNotFoundError);
  });
});

describe("buildCatalogTree", () => {
  const list: CatalogList = {
    components: [
      component("hero-a", "heroes", null, "Hero A"),
      component("btn", "buttons", null, "Button"),
      component("chat", "ai-chats", "build", "Chat"),
      component("glow", "backgrounds", null, "Glow"),
      component("new-thing", "imported", null, "New Thing"),
      component("odd", "widgets", "custom", "Odd"),
    ],
    collections: [
      { id: "zeta", title: "Zeta", reserved: false, slugs: ["btn"] },
      { id: "favorites", title: "Favorites", reserved: true, slugs: ["hero-a", "missing-slug", "btn"] },
      { id: "alpha", title: "Alpha", reserved: false, slugs: [] },
    ],
  };

  it("puts Favorites first, other collections by title, then buckets in page order", () => {
    expect(labels(buildCatalogTree(list))).toEqual(["Favorites", "Alpha", "Zeta", "Brick", "Build", "Creation", "AI", "Custom", "Imported"]);
  });

  it("keeps collection order and skips slugs that no longer exist", () => {
    expect(labels(group(buildCatalogTree(list), "Favorites").children)).toEqual(["Hero A", "Button"]);
  });

  it("places blocks the way the catalog page does", () => {
    const tree = buildCatalogTree(list);
    expect(labels(group(tree, "Brick").children)).toEqual(["Backgrounds"]);
    expect(labels(group(group(tree, "AI").children, "Chat Parts").children)).toEqual(["Chat"]);
    expect(labels(group(tree, "Imported").children)).toEqual(["Imported"]);
    expect(placeEntry(component("x", "ai-chats", "creation")).category).toBe("ai-screens");
  });

  it("builds from the recorded envelope", async () => {
    const recordedList = await new BlockbaseCli(fakeRunner({ "catalog list": recorded.list() })).listCatalog();
    const tree = buildCatalogTree(recordedList);
    expect(labels(tree)).toEqual(["Favorites", "Ideas", "Imported"]);
    expect(labels(group(tree, "Favorites").children)).toEqual(["Static Card"]);
  });

  it("search results keep CLI ranking and say so when nothing matches", () => {
    expect(labels(buildSearchTree("q", [{ componentId: "cmp_local_btn", namespace: "local", slug: "btn", displayName: "Button", score: 1, favorite: false }], list))).toEqual(["Button"]);
    expect(buildSearchTree("zz", [], list)).toEqual([{ kind: "message", id: "search:empty", label: 'No blocks match "zz".' }]);
  });
});

describe("CatalogTreeProvider", () => {
  it("renders blocks with category and a tooltip carrying description and tags", async () => {
    const provider = new CatalogTreeProvider(new BlockbaseCli(fakeRunner({ "catalog list": recorded.list() })));
    const roots = await provider.getChildren();
    const favorites = roots[0];
    const block = (await provider.getChildren(favorites))[0];
    const item = provider.getTreeItem(block);
    expect(item.label).toBe("Static Card");
    expect(item.description).toBe("Imported");
    expect(item.contextValue).toBe(BLOCK_CONTEXT_VALUE);
    const tooltip = (item.tooltip as { value: string }).value;
    expect(tooltip).toContain("Imported React component Static Card");
    expect(tooltip).toContain("featured");
    expect(provider.getTreeItem(favorites).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
  });

  it("makes every node navigate the catalog panel, except messages", async () => {
    const list: CatalogList = {
      components: [component("hero-a", "heroes", null, "Hero A")],
      collections: [{ id: "ideas", title: "Ideas", reserved: false, slugs: ["hero-a"] }],
    };
    const provider = new CatalogTreeProvider(new BlockbaseCli(fakeRunner({})));
    const roots = buildCatalogTree(list);
    const command = (node: CatalogNode) => provider.getTreeItem(node).command;
    const open = (arg: object) => ({ command: COMMANDS.openPanel, title: "Open in Catalog", arguments: [arg, { preserveFocus: true }] });
    const collection = group(roots, "Ideas");
    const bucket = group(roots, "Creation");
    const category = bucket.children[0] as GroupNode;
    expect(command(collection)).toEqual(open({ collectionId: "ideas" }));
    expect(command(bucket)).toEqual(open({ bucketId: "creation" }));
    expect(command(category)).toEqual(open({ categoryId: "heroes" }));
    expect(command(collection.children[0])).toEqual(open({ blockId: "cmp_local_hero-a" }));
    expect(command({ kind: "message", id: "m", label: "No blocks" })).toBeUndefined();
  });

  it("search-result block nodes carry the open command", async () => {
    const provider = new CatalogTreeProvider(new BlockbaseCli(fakeRunner({ "catalog list": recorded.list(), "search card": recorded.search() })));
    provider.setSearch("card");
    const [hit] = await provider.getChildren();
    expect(hit.kind).toBe("block");
    expect(provider.getTreeItem(hit).command).toMatchObject({ command: COMMANDS.openPanel, arguments: [{ blockId: expect.any(String) }, { preserveFocus: true }] });
  });

  it("returns no items and sets cliMissing when blockbase is not on PATH", async () => {
    const provider = new CatalogTreeProvider(new BlockbaseCli(fakeRunner({ "catalog list": new CliNotFoundError("blockbase") })));
    expect(await provider.getChildren()).toEqual([]);
    expect(mock.registered.context.get(CONTEXT_KEYS.cliMissing)).toBe(true);
  });

  it("shows CLI errors as a message row", async () => {
    const provider = new CatalogTreeProvider(new BlockbaseCli(fakeRunner({ "catalog list": { exitCode: 10, stdout: "", stderr: "Internal error: disk" } })));
    expect(labels(await provider.getChildren())).toEqual(["Blockbase: Internal error: disk"]);
  });

  it("searches with blockbase search and clears back to the browse tree", async () => {
    const run = fakeRunner({ "catalog list": recorded.list(), "search card": recorded.search(), "search zzzqqq": recorded.searchEmpty() });
    const provider = new CatalogTreeProvider(new BlockbaseCli(run));
    const fired = vi.fn();
    provider.onDidChangeTreeData(fired);

    provider.setSearch("  card ");
    expect(fired).toHaveBeenCalled();
    expect(mock.registered.context.get(CONTEXT_KEYS.searching)).toBe(true);
    expect(labels(await provider.getChildren())).toEqual(["Static Card"]);
    expect(run.calls).toContainEqual(["search", "card", "--json"]);

    provider.setSearch("zzzqqq");
    expect(labels(await provider.getChildren())).toEqual(['No blocks match "zzzqqq".']);

    provider.setSearch(undefined);
    expect(mock.registered.context.get(CONTEXT_KEYS.searching)).toBe(false);
    expect(labels(await provider.getChildren())).toEqual(["Favorites", "Ideas", "Imported"]);
  });

  it("refresh re-runs the CLI", async () => {
    const run = fakeRunner({ "catalog list": recorded.list() });
    const provider = new CatalogTreeProvider(new BlockbaseCli(run));
    await provider.getChildren();
    await provider.getChildren();
    provider.refresh();
    await provider.getChildren();
    expect(run.calls.filter((args) => args[0] === "catalog")).toHaveLength(2);
  });
});

describe("CatalogWatcher", () => {
  it("watches the catalog history log and debounces refreshes", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const watcher = new CatalogWatcher("/tmp/blockbase-home", onChange, 100);
    const fsWatcher = mock.registered.watchers[0];
    expect(fsWatcher.pattern.pattern).toBe(HISTORY_SIGNAL_GLOB);
    expect(fsWatcher.pattern.base.fsPath).toBe("/tmp/blockbase-home");
    fsWatcher.changed.fire(mock.Uri.file("/tmp/blockbase-home/.git/logs/HEAD"));
    fsWatcher.changed.fire(mock.Uri.file("/tmp/blockbase-home/.git/logs/HEAD"));
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    watcher.dispose();
    expect(fsWatcher.disposed).toBe(true);
    vi.useRealTimers();
  });
});

describe("commands", () => {
  it("search command asks for a query, clear search resets, and a watcher starts on the located catalog", async () => {
    const run = fakeRunner({ "catalog list": recorded.list(), "catalog locate": recorded.locate(), "search card": recorded.search() });
    activate({ subscriptions: [], extensionUri: mock.Uri.file("/ext") } as unknown as import("vscode").ExtensionContext, run);
    await vi.waitFor(() => expect(mock.registered.watchers).toHaveLength(1));
    expect(mock.registered.watchers[0].pattern.base.fsPath).toBe("/tmp/blockbase-home");

    mock.registered.inputBoxAnswers.push("card");
    await mock.registered.commands.get(COMMANDS.search)?.();
    expect(mock.registered.context.get(CONTEXT_KEYS.searching)).toBe(true);
    await mock.registered.commands.get(COMMANDS.clearSearch)?.();
    expect(mock.registered.context.get(CONTEXT_KEYS.searching)).toBe(false);
  });
});
