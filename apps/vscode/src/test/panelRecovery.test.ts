import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { CatalogPanel, type PanelRecovery } from "../panel/catalogPanel";
import type { ServiceState } from "../service/status";

const mock = vscode as unknown as typeof import("./mocks/vscode");

const DOWN: ServiceState = { kind: "no-service", url: "http://127.0.0.1:5000" };
const UP: ServiceState = { kind: "up", url: "http://127.0.0.1:5000" };

/** A recovery whose check() answers `state` and fires the change event, like the real class. */
function fakeRecovery(initial: ServiceState) {
  const emitter = new mock.EventEmitter<ServiceState>();
  const fake = {
    state: initial,
    check: vi.fn(async () => {
      emitter.fire(fake.state);
      return fake.state;
    }),
    handleAction: vi.fn(async (_action: string) => undefined),
    onDidChangeState: emitter.event,
  };
  return { fake, emitter };
}

function panelWith(recovery: ReturnType<typeof fakeRecovery>["fake"]) {
  return new CatalogPanel(mock.Uri.file("/ext") as never, () => 5000, recovery as unknown as PanelRecovery);
}

describe("CatalogPanel service recovery", () => {
  beforeEach(() => {
    mock.reset();
  });

  it("(a) shows the not-running view instead of the frame page when the service is down", async () => {
    const { fake } = fakeRecovery(DOWN);
    await panelWith(fake).show();
    const html = mock.lastPanel().webview.html;
    expect(html).toContain("blockbase.service");
    expect(html).toContain("The catalog page isn't running");
    expect(html).not.toContain("data-src=");
    expect(html).not.toContain("frame-src");
  });

  it("(b) forwards a service action while the not-running view shows", async () => {
    const { fake } = fakeRecovery(DOWN);
    await panelWith(fake).show();
    mock.lastPanel().receive({ type: "blockbase.service", action: "restart" });
    expect(fake.handleAction).toHaveBeenCalledTimes(1);
    expect(fake.handleAction).toHaveBeenCalledWith("restart");
  });

  it("(c) ignores a malformed action", async () => {
    const { fake } = fakeRecovery(DOWN);
    await panelWith(fake).show();
    const p = mock.lastPanel();
    p.receive({ type: "blockbase.service", action: "rm" });
    p.receive({ type: "blockbase.service", action: 3 });
    p.receive({ type: "blockbase.service" });
    p.receive(null);
    p.receive("blockbase.service");
    expect(fake.handleAction).not.toHaveBeenCalled();
  });

  it("(d) reloads the frame page for the remembered target when the service comes up", async () => {
    const { fake, emitter } = fakeRecovery(DOWN);
    await panelWith(fake).show({ blockId: "b" });
    expect(mock.lastPanel().webview.html).not.toContain("data-src=");
    fake.state = UP;
    emitter.fire(UP);
    await vi.waitFor(() => expect(mock.lastPanel().webview.html).toContain("data-src="));
    expect(mock.lastPanel().webview.html).toContain("#block/b");
    expect(mock.registered.panels).toHaveLength(1);
  });

  it("(e) re-checks on a frame error while up and does not rebuild the page", async () => {
    const { fake } = fakeRecovery(UP);
    await panelWith(fake).show();
    const p = mock.lastPanel();
    const before = p.webview.html;
    expect(fake.check).toHaveBeenCalledTimes(1);
    p.receive({ type: "blockbase:frame-error" });
    await vi.waitFor(() => expect(fake.check).toHaveBeenCalledTimes(2));
    expect(p.webview.html).toBe(before);
  });

  it("(e2) shows the not-running view when a frame error finds the service down", async () => {
    const { fake } = fakeRecovery(UP);
    await panelWith(fake).show();
    const p = mock.lastPanel();
    fake.state = DOWN;
    p.receive({ type: "blockbase:frame-error" });
    await vi.waitFor(() => expect(p.webview.html).toContain("blockbase.service"));
    expect(p.webview.html).not.toContain("data-src=");
  });

  it("(f) re-renders the not-running view when the state becomes starting", async () => {
    const { fake, emitter } = fakeRecovery(DOWN);
    await panelWith(fake).show();
    emitter.fire({ kind: "starting" });
    expect(mock.lastPanel().webview.html).toContain("Starting the catalog page");
    expect(mock.lastPanel().webview.html).not.toContain("data-src=");
  });

  it("(g) ignores blockbase.service while the frame page shows", async () => {
    const { fake } = fakeRecovery(UP);
    await panelWith(fake).show();
    mock.lastPanel().receive({ type: "blockbase.service", action: "install" });
    expect(fake.handleAction).not.toHaveBeenCalled();
  });

  it("(h) re-checks and posts no navigate when shown again while the not-running view shows", async () => {
    const { fake } = fakeRecovery(DOWN);
    const p = panelWith(fake);
    await p.show();
    await p.show({ blockId: "b2" });
    expect(fake.check).toHaveBeenCalledTimes(2);
    expect(mock.lastPanel().posted).toEqual([]);
    expect(mock.lastPanel().webview.html).toContain("blockbase.service");
    expect(mock.registered.panels).toHaveLength(1);
  });

  it("does not check again when navigating inside the frame page", async () => {
    const { fake } = fakeRecovery(UP);
    const p = panelWith(fake);
    await p.show();
    await p.show({ blockId: "b" });
    expect(fake.check).toHaveBeenCalledTimes(1);
    expect(mock.lastPanel().posted).toHaveLength(1);
  });

  it("stops listening to state changes after dispose", async () => {
    const { fake, emitter } = fakeRecovery(DOWN);
    const p = panelWith(fake);
    await p.show();
    const html = mock.lastPanel().webview.html;
    p.dispose();
    emitter.fire({ kind: "starting" });
    expect(mock.lastPanel().webview.html).toBe(html);
  });

  it("P-19: a burst of frame-error messages triggers exactly one status check", async () => {
    const { fake } = fakeRecovery(UP);
    await panelWith(fake).show();
    expect(fake.check).toHaveBeenCalledTimes(1);
    let release: (state: ServiceState) => void = () => undefined;
    fake.check.mockImplementationOnce(() => new Promise<ServiceState>((resolve) => (release = resolve)));
    const p = mock.lastPanel();
    for (let i = 0; i < 5; i++) p.receive({ type: "blockbase:frame-error" });
    expect(fake.check).toHaveBeenCalledTimes(2);
    release(UP);
    await vi.waitFor(() => {
      p.receive({ type: "blockbase:frame-error" });
      expect(fake.check).toHaveBeenCalledTimes(3);
    });
  });
});
