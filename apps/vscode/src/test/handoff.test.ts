import { handoffText } from "@blockbase/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { COMMANDS } from "../config";
import { activate } from "../extension";
import { fakeRunner, recorded } from "./fakeCli";

const mock = vscode as unknown as typeof import("./mocks/vscode");

/** What the catalog page's "Copy commands" button produces for the fixture block. */
const PAGE_TEXT = [
  'Add "Static Card" (imported) from my Blockbase catalog to this project. Show me the add plan before applying it.',
  "",
  "blockbase inspect cmp_local_static-card --json",
  "blockbase adapt cmp_local_static-card --project . --json",
].join("\n");

async function activated() {
  const ctx = { subscriptions: [] as { dispose(): void }[], extensionUri: mock.Uri.file("/ext") };
  activate(ctx as unknown as import("vscode").ExtensionContext, fakeRunner({ "catalog list": recorded.list(), "catalog locate": recorded.locate() }));
  return mock.registered.commands.get(COMMANDS.copyHandoff)!;
}

describe("copy handoff", () => {
  beforeEach(() => {
    mock.registered.commands.clear();
    mock.registered.clipboard.length = 0;
    mock.registered.messages.length = 0;
  });

  it("should produce identical handoff text from the extension and the page", async () => {
    const copy = await activated();
    await copy("cmp_local_static-card");
    expect(mock.registered.clipboard).toEqual([PAGE_TEXT]);
    expect(handoffText({ componentId: "cmp_local_static-card", displayName: "Static Card", category: "imported" })).toBe(PAGE_TEXT);
  });

  // The tree shows display placement (category may be rewritten); the page uses the raw catalog entry.
  it("copies the raw catalog entry from a sidebar block node", async () => {
    const copy = await activated();
    await copy({ kind: "block", id: "x", component: { componentId: "cmp_local_static-card", displayName: "Static Card", category: "ai-parts" } });
    expect(mock.registered.clipboard).toEqual([PAGE_TEXT]);
  });

  it("warns and copies nothing for an unknown block", async () => {
    const copy = await activated();
    await copy("cmp_missing");
    expect(mock.registered.clipboard).toEqual([]);
    expect(mock.registered.messages.at(-1)).toMatchObject({ level: "warning", text: expect.stringMatching(/cmp_missing/) });
  });
});
