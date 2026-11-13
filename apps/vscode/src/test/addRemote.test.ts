import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as vscode from "vscode";
import { applyRefusal, collisions, readAddResult } from "../add/addPlan";
import { APPLY_ACTION, PlanDocuments, addToProject } from "../add/addToProject";
import { BlockbaseCli, type CatalogComponent } from "../cli/blockbaseCli";
import { workspaceApplier } from "../extension";
import type { BlockNode } from "../tree/catalogModel";
import { fakeRunner, fixture, ok } from "./fakeCli";

const mock = vscode as unknown as typeof import("./mocks/vscode");

const FILE_PATH = "src/components/glow-card/GlowCard.tsx";
const KEY = `vscode-remote://ssh-remote+box/home/me/app/${FILE_PATH}`;
const dryRunJson = () => JSON.parse(fixture("add-dry-run.json")).data;
const fixtureContent: string = dryRunJson().bundle.files[0].content;

const glowCard: CatalogComponent = {
  componentId: "cmp_local_glow-card",
  namespace: "local",
  slug: "glow-card",
  displayName: "Glow Card",
  description: "",
  category: "",
  tags: [],
  bucket: null,
};
const node: BlockNode = { kind: "block", id: "block:glow-card", component: glowCard };
const remoteFolder = () => ({
  name: "app",
  index: 0,
  uri: mock.Uri.from({ scheme: "vscode-remote", authority: "ssh-remote+box", path: "/home/me/app" }),
});

function cliWith(answers: Parameters<typeof fakeRunner>[0] = {}) {
  const runner = fakeRunner(answers);
  return { runner, cli: new BlockbaseCli(runner) };
}

describe("workspaceApplier on a remote folder", () => {
  beforeEach(() => mock.reset());

  it("(a) writes the file contents through workspace.fs and reports applied", async () => {
    const { cli } = cliWith();
    const plan = readAddResult(dryRunJson());
    const result = await workspaceApplier(cli)(glowCard, remoteFolder() as never, plan);
    expect(result.applied).toBe(true);
    expect(new TextDecoder().decode(mock.workspace.written.get(KEY))).toBe(fixtureContent);
  });

  it("(b) refuses before writing when a target exists, listing it as a collision", async () => {
    mock.workspace.existing.add(KEY);
    const { cli } = cliWith();
    const plan = readAddResult(dryRunJson());
    const result = await workspaceApplier(cli)(glowCard, remoteFolder() as never, plan);
    expect(result.applied).toBe(false);
    expect(collisions(result).map((f) => f.path)).toEqual([FILE_PATH]);
    expect(applyRefusal(result)).toContain(FILE_PATH);
    expect(mock.workspace.written.size).toBe(0);
    expect(mock.registered.messages.some((m) => String(m.text).includes(FILE_PATH))).toBe(true);
  });

  it("(b2) aborts, writing nothing, on a stat error other than FileNotFound", async () => {
    mock.workspace.statErrors.set(KEY, Object.assign(new Error("no permission"), { code: "NoPermissions" }));
    const { cli } = cliWith();
    const plan = readAddResult(dryRunJson());
    await expect(workspaceApplier(cli)(glowCard, remoteFolder() as never, plan)).rejects.toThrow("no permission");
    expect(mock.workspace.written.size).toBe(0);
  });

  it("(c) keeps the CLI path for a local file folder and writes nothing through workspace.fs", async () => {
    const { runner, cli } = cliWith({ "add cmp_local_glow-card --project /work/web --apply": ok(fixture("add-apply.json")) });
    const plan = readAddResult(dryRunJson());
    const folder = { name: "web", index: 0, uri: mock.Uri.file("/work/web") };
    const result = await workspaceApplier(cli)(glowCard, folder as never, plan);
    expect(runner.calls.some((args) => args.includes("--apply"))).toBe(true);
    expect(result.applied).toBe(true);
    expect(mock.workspace.written.size).toBe(0);
  });

  it("(d) refuses a plan whose file has no content and writes nothing", async () => {
    const { cli } = cliWith();
    const plan = readAddResult(dryRunJson());
    const stripped = { ...plan, files: plan.files.map((f) => ({ ...f, content: undefined })) };
    const result = await workspaceApplier(cli)(glowCard, remoteFolder() as never, stripped);
    expect(result.applied).toBe(false);
    expect(mock.workspace.written.size).toBe(0);
  });

  describe("race", () => {
    let statSpy: MockInstance<typeof mock.workspace.fs.stat> | undefined;
    afterEach(() => {
      statSpy?.mockRestore();
      statSpy = undefined;
    });

    it("(e) refuses when the target appears after the applier's own stat pass", async () => {
      const original = mock.workspace.fs.stat.bind(mock.workspace.fs);
      let calls = 0;
      statSpy = vi.spyOn(mock.workspace.fs, "stat").mockImplementation(async (u) => {
        calls += 1;
        try {
          return await original(u);
        } finally {
          if (calls === 1) mock.workspace.existing.add(KEY);
        }
      });
      mock.registered.workspaceFolders = [remoteFolder()];
      mock.registered.warningAnswers.push(APPLY_ACTION);
      const { cli } = cliWith({ "add cmp_local_glow-card --project /home/me/app --dry-run": ok(fixture("add-dry-run.json")) });
      await addToProject({ cli, plans: new PlanDocuments(), applier: workspaceApplier(cli) }, node);
      expect(calls).toBe(2);
      expect(mock.workspace.written.size).toBe(0);
      expect(mock.registered.messages.some((m) => String(m.text).includes("Refusing to overwrite existing files"))).toBe(true);
    });
  });
});
