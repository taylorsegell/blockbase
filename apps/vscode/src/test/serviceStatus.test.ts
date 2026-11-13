import { describe, expect, it, vi } from "vitest";
import { CLI_CALLS, classifyStatus, probeServiceStatus, type CliRunner } from "../service/status";
import { ServiceRecovery, waitUntilUp, type SessionProcess } from "../service/serviceRecovery";
import { renderNotRunningHtml } from "../service/notRunningView";

function envelope(data: unknown) {
  return JSON.stringify({ schemaVersion: "1", ok: true, operation: "ui.status", data, warnings: [] });
}

const svc = (installed: boolean, loaded: boolean) => ({ supported: true, platform: "darwin", installed, owned: installed, loaded });

function fakeRunner(stdout: string) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runner: CliRunner = async (file, args) => {
    calls.push({ file, args });
    return { stdout, stderr: "", exitCode: 0 };
  };
  return { runner, calls };
}

describe("CLI calls", () => {
  it("should build every CLI call as an argument array and never execute service install in tests", async () => {
    for (const call of Object.values(CLI_CALLS)) {
      expect(Array.isArray(call)).toBe(true);
      for (const part of call) expect(part).not.toMatch(/\s/);
    }
    expect(CLI_CALLS.status).toEqual(["ui", "status", "--json"]);
    expect(CLI_CALLS.installService).toEqual(["ui", "service", "install"]);
    expect(CLI_CALLS.restartService).toEqual(["ui", "service", "install"]);
    expect(CLI_CALLS.runSession).toEqual(["ui"]);

    const { runner, calls } = fakeRunner(envelope({ running: true, url: "http://127.0.0.1:1/", service: svc(true, true) }));
    const recovery = new ServiceRecovery({ bin: "blockbase", runner, spawnSession: () => ({ kill: vi.fn(), onExit: () => {} }), health: async () => true });
    await recovery.check();
    await recovery.install();
    // Only the fake runner saw calls; nothing reached a real process.
    expect(calls.map((c) => c.args)).toEqual([CLI_CALLS.status, CLI_CALLS.installService]);
    expect(calls.every((c) => c.file === "blockbase")).toBe(true);
  });
});

describe("classifyStatus", () => {
  it("reports up, installed-but-down and no-service", () => {
    expect(classifyStatus(JSON.parse(envelope({ running: true, url: "u", service: svc(true, true) }))).kind).toBe("up");
    expect(classifyStatus(JSON.parse(envelope({ running: false, url: "u", service: svc(true, false) }))).kind).toBe("installed-down");
    expect(classifyStatus(JSON.parse(envelope({ running: false, url: "u", service: svc(false, false) }))).kind).toBe("no-service");
  });

  it("treats malformed or failed envelopes as unknown", () => {
    expect(classifyStatus(null).kind).toBe("unknown");
    expect(classifyStatus({ ok: false, error: { message: "boom" } }).kind).toBe("unknown");
    expect(classifyStatus({ ok: true, data: { running: "yes" } }).kind).toBe("unknown");
  });

  it("maps a missing CLI to unknown with a message", async () => {
    const runner: CliRunner = async () => {
      throw Object.assign(new Error("spawn blockbase ENOENT"), { code: "ENOENT" });
    };
    const status = await probeServiceStatus("blockbase", runner);
    expect(status.kind).toBe("unknown");
    expect(status.kind === "unknown" && status.reason).toMatch(/not found/i);
  });
});

describe("waitUntilUp", () => {
  it("retries with backoff until the page answers", async () => {
    const answers = [false, false, true];
    const health = vi.fn(async () => answers.shift() ?? true);
    const delays: number[] = [];
    const ok = await waitUntilUp(health, { sleep: async (ms) => void delays.push(ms), initialDelayMs: 100, maxDelayMs: 300, maxAttempts: 10 });
    expect(ok).toBe(true);
    expect(health).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
  });

  it("gives up after maxAttempts or when cancelled", async () => {
    expect(await waitUntilUp(async () => false, { sleep: async () => {}, maxAttempts: 3 })).toBe(false);
    const signal = AbortSignal.abort();
    expect(await waitUntilUp(async () => true, { sleep: async () => {}, signal })).toBe(false);
  });
});

describe("ServiceRecovery", () => {
  it("tracks the session child and kills it on dispose", () => {
    const child: SessionProcess = { kill: vi.fn(), onExit: () => {} };
    const spawnSession = vi.fn(() => child);
    const recovery = new ServiceRecovery({ bin: "blockbase", runner: fakeRunner("").runner, spawnSession });
    recovery.runForSession();
    recovery.runForSession(); // second click does not start a second server
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith("blockbase", ["ui"]);
    recovery.dispose();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("forgets a session child that exits on its own", () => {
    let exit: () => void = () => {};
    const child: SessionProcess = { kill: vi.fn(), onExit: (cb) => void (exit = cb) };
    const recovery = new ServiceRecovery({ bin: "blockbase", runner: fakeRunner("").runner, spawnSession: () => child });
    recovery.runForSession();
    exit();
    recovery.dispose();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("emits state changes and recovers once the health check answers", async () => {
    const { runner } = fakeRunner(envelope({ running: false, url: "u", service: svc(true, false) }));
    const health = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const recovery = new ServiceRecovery({ bin: "blockbase", runner, spawnSession: () => ({ kill() {}, onExit() {} }), health, sleep: async () => {} });
    const seen: string[] = [];
    recovery.onDidChangeState((s) => seen.push(s.kind));
    await recovery.check();
    await recovery.restart();
    expect(seen).toEqual(["installed-down", "starting", "up"]);
  });
});

describe("renderNotRunningHtml", () => {
  it("offers Install and Run for this session when there is no service", () => {
    const html = renderNotRunningHtml({ kind: "no-service", url: "u" }, "n1");
    expect(html).toContain('data-action="install"');
    expect(html).toContain('data-action="runSession"');
    expect(html).not.toContain('data-action="restart"');
    expect(html).toContain("script-src 'nonce-n1'");
  });

  it("offers Restart when installed but down, and escapes text", () => {
    const html = renderNotRunningHtml({ kind: "unknown", reason: "<b>x</b>" }, "n");
    expect(html).toContain("&lt;b&gt;");
    expect(renderNotRunningHtml({ kind: "installed-down", url: "u" }, "n")).toContain('data-action="restart"');
  });
});
