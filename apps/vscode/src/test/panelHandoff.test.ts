import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as vscode from "vscode";
import { CatalogPanel } from "../panel/catalogPanel";

const mock = vscode as unknown as typeof import("./mocks/vscode");

async function openPanel() {
  const panel = new CatalogPanel(mock.Uri.file("/ext") as never, () => 5000);
  await panel.show();
  return mock.lastPanel();
}

describe("CatalogPanel copy handoff", () => {
  let executeSpy: MockInstance<typeof mock.commands.executeCommand>;

  beforeEach(() => {
    mock.reset();
    executeSpy = vi.spyOn(mock.commands, "executeCommand");
  });
  afterEach(() => {
    executeSpy.mockRestore();
  });

  it("runs blockbase.copyHandoff for a valid id-form message", async () => {
    const p = await openPanel();
    p.receive({ type: "blockbase:copy-handoff", componentId: "cmp_local_glow-card" });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith("blockbase.copyHandoff", "cmp_local_glow-card");
  });

  it("accepts a 200-character id", async () => {
    const p = await openPanel();
    p.receive({ type: "blockbase:copy-handoff", componentId: "a".repeat(200) });
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores an empty id, a 201-character id and a charset violation", async () => {
    const p = await openPanel();
    p.receive({ type: "blockbase:copy-handoff", componentId: "" });
    p.receive({ type: "blockbase:copy-handoff", componentId: "a".repeat(201) });
    p.receive({ type: "blockbase:copy-handoff", componentId: "a\n[x](command:foo)" });
    p.receive({ type: "blockbase:copy-handoff", componentId: 7 });
    p.receive({ type: "blockbase:copy-handoff" });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("ignores a wrong type and non-object messages", async () => {
    const p = await openPanel();
    p.receive({ type: "blockbase:copy", componentId: "cmp_local_x" });
    p.receive("blockbase:copy-handoff");
    p.receive(null);
    p.receive(undefined);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("marks the framed page with host=vscode", async () => {
    const p = await openPanel();
    expect(p.webview.html).toContain("host=vscode");
  });
});
