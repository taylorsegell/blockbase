import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { catalogUrlForWebview, remoteContext, writeIntoWorkspace } from "../service/remote";

const mock = vscode as unknown as typeof import("./mocks/vscode");
const manifest = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));

describe("remote workspaces", () => {
  beforeEach(() => {
    mock.env.remoteName = undefined;
    mock.env.externalUris.clear();
    mock.workspace.written.clear();
    mock.workspace.statErrors.clear();
  });

  it("runs on the UI (local) side so the local catalog and CLI are reachable", () => {
    expect(manifest.extensionKind).toEqual(["ui"]);
  });

  it("reports local windows as not remote", () => {
    expect(remoteContext()).toEqual({ isRemote: false, remoteName: undefined });
  });

  it("reports the remote name in SSH, Codespaces and dev container windows", () => {
    for (const name of ["ssh-remote", "codespaces", "dev-container"]) {
      mock.env.remoteName = name;
      expect(remoteContext()).toEqual({ isRemote: true, remoteName: name });
    }
  });

  it("passes the catalog URL through asExternalUri", async () => {
    expect(await catalogUrlForWebview("http://127.0.0.1:5555/#home")).toBe("http://127.0.0.1:5555/#home");
    mock.env.externalUris.set("http://127.0.0.1:5555/", "https://fwd.example.test/");
    expect(await catalogUrlForWebview("http://127.0.0.1:5555/")).toBe("https://fwd.example.test/");
  });

  it("writes files through workspace.fs on the remote folder URI", async () => {
    const folder = mock.Uri.from({ scheme: "vscode-remote", authority: "ssh-remote+box", path: "/home/me/app" });
    const written = await writeIntoWorkspace(folder as unknown as vscode.Uri, [
      { path: "src/components/ui/button.tsx", contents: "x" },
    ]);
    expect(written.map(String)).toEqual(["vscode-remote://ssh-remote+box/home/me/app/src/components/ui/button.tsx"]);
    expect(new TextDecoder().decode(mock.workspace.written.get(String(written[0])))).toBe("x");
  });

  it("refuses paths that escape the workspace folder", async () => {
    const folder = mock.Uri.file("/proj") as unknown as vscode.Uri;
    for (const bad of ["../evil.ts", "/etc/passwd", "a/../../b", "C:\\x", ""]) {
      await expect(writeIntoWorkspace(folder, [{ path: bad, contents: "" }])).rejects.toThrow(/outside the workspace/);
    }
    expect(mock.workspace.written.size).toBe(0);
  });

  describe("create-only writes", () => {
    const folder = mock.Uri.from({ scheme: "vscode-remote", authority: "ssh-remote+box", path: "/home/me/app" });
    const f = folder as unknown as vscode.Uri;
    const key = (rel: string) => `vscode-remote://ssh-remote+box/home/me/app/${rel}`;
    const enc = (s: string) => new TextEncoder().encode(s);

    it("refuses to overwrite an existing file and writes nothing", async () => {
      mock.workspace.written.set(key("a.ts"), enc("old"));
      await expect(
        writeIntoWorkspace(f, [
          { path: "new.ts", contents: "n" },
          { path: "a.ts", contents: "x" },
        ]),
      ).rejects.toThrow(/a\.ts/);
      expect(mock.workspace.written.size).toBe(1);
      expect(new TextDecoder().decode(mock.workspace.written.get(key("a.ts")))).toBe("old");
    });

    it("replaces existing files when overwrite is true", async () => {
      mock.workspace.written.set(key("a.ts"), enc("old"));
      await writeIntoWorkspace(f, [{ path: "a.ts", contents: "x" }], { overwrite: true });
      expect(new TextDecoder().decode(mock.workspace.written.get(key("a.ts")))).toBe("x");
    });

    it("writes when stat reports FileNotFound", async () => {
      mock.workspace.statErrors.set(key("a.ts"), mock.FileSystemError.FileNotFound());
      await writeIntoWorkspace(f, [{ path: "a.ts", contents: "x" }]);
      expect(mock.workspace.written.has(key("a.ts"))).toBe(true);
    });

    it("aborts without writing on any other stat error", async () => {
      mock.workspace.statErrors.set(key("b.ts"), new mock.FileSystemError("no permission", "NoPermissions"));
      await expect(
        writeIntoWorkspace(f, [
          { path: "a.ts", contents: "x" },
          { path: "b.ts", contents: "y" },
        ]),
      ).rejects.toThrow(/no permission/);
      expect(mock.workspace.written.size).toBe(0);
    });

    it("rejects paths that resolve to the folder itself", async () => {
      for (const bad of [".", "./", "./."]) {
        await expect(writeIntoWorkspace(f, [{ path: bad, contents: "" }])).rejects.toThrow(/outside the workspace|folder itself/);
      }
      expect(mock.workspace.written.size).toBe(0);
    });

    it("rejects duplicate paths in one call", async () => {
      await expect(
        writeIntoWorkspace(f, [
          { path: "a.ts", contents: "1" },
          { path: "./a.ts", contents: "2" },
        ]),
      ).rejects.toThrow(/duplicate.*a\.ts/i);
      expect(mock.workspace.written.size).toBe(0);
    });
  });
});
