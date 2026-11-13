import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { applyRefusal, readAddResult, renderPlanMarkdown } from "../add/addPlan";
import { APPLY_ACTION, PLAN_SCHEME, PlanDocuments, addToProject } from "../add/addToProject";
import { BlockbaseCli, type CatalogComponent } from "../cli/blockbaseCli";
import { CliNotFoundError, type CliResult } from "../cli/runner";
import { COMMANDS } from "../config";
import { activate } from "../extension";
import type { BlockNode } from "../tree/catalogModel";
import { fakeRunner, fixture, ok, recorded } from "./fakeCli";

const mock = vscode as unknown as typeof import("./mocks/vscode");

const dryRun = () => ok(fixture("add-dry-run.json"));
const applied = () => ok(fixture("add-apply.json"));
const dataOf = (name: string) => JSON.parse(fixture(name)).data;

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
const folder = (name: string, fsPath: string, index = 0) => ({ name, index, uri: mock.Uri.file(fsPath) });

function setup(answers: Parameters<typeof fakeRunner>[0]) {
  const runner = fakeRunner(answers);
  return { runner, deps: { cli: new BlockbaseCli(runner), plans: new PlanDocuments() } };
}

beforeEach(() => mock.resetUi());

describe("readAddResult", () => {
  it("reads the recorded dry-run envelope", () => {
    const result = readAddResult(dataOf("add-dry-run.json"));
    expect(result.applied).toBe(false);
    expect(result.files.map((f) => [f.path, f.operation])).toEqual([["src/components/glow-card/GlowCard.tsx", "create"]]);
    expect(result.dependencies).toEqual([{ name: "motion", range: "*", kind: "runtime" }]);
    expect(result.placement).toEqual({ directory: "src/components/glow-card", importPath: "@/components/glow-card/GlowCard" });
    expect(result.risk).toBe("medium");
    expect(result.validationCommands).toEqual(["pnpm build", "pnpm lint", "pnpm test"]);
    expect(applyRefusal(result)).toBeUndefined();
  });

  it.each([
    ["empty", ""],
    ["absolute", "/etc/passwd"],
    ["backslash", "src\\evil.tsx"],
    ["drive-letter", "C:/Windows/evil.tsx"],
    ["parent segment", "../outside.tsx"],
    ["embedded parent segment", "src/../../outside.tsx"],
    ["bare parent", ".."],
  ])("rejects an unsafe file path (%s)", (_name, unsafe) => {
    const data = dataOf("add-dry-run.json");
    data.bundle.files[0].path = unsafe;
    expect(() => readAddResult(data)).toThrow(/unsafe file path/);
  });

  it("rejects output without a bundle", () => {
    expect(() => readAddResult({ applied: false })).toThrow(/bundle/);
  });

  it("allows re-adding identical files but refuses to overwrite changed ones", () => {
    const same = readAddResult(dataOf("add-dry-run-existing.json"));
    expect(same.files[0].operation).toBe("replace");
    expect(applyRefusal(same)).toBeUndefined();
    const changed = { ...same, files: [{ ...same.files[0], targetHash: "sha256:local-edit" }] };
    expect(applyRefusal(changed)).toMatch(/already exist.*ThirdParty\.tsx/);
  });

  it("refuses a plan the CLI blocked", () => {
    const result = { ...readAddResult(dataOf("add-dry-run.json")), blocked: ["unsupported framework"] };
    expect(applyRefusal(result)).toMatch(/unsupported framework/);
  });
});

describe("renderPlanMarkdown", () => {
  it("shows files, dependencies, risk, residuals and validation commands", () => {
    const text = renderPlanMarkdown(readAddResult(dataOf("add-dry-run.json")), "Glow Card", "web");
    expect(text).toContain("# Add Glow Card to web");
    expect(text).toContain("`src/components/glow-card/GlowCard.tsx` (new)");
    expect(text).toContain("`motion@*`");
    expect(text).toContain("**Risk:** medium");
    expect(text).toContain("## Residuals (needs a human)");
    expect(text).toContain("`pnpm build`");
    expect(text).toContain("`@/components/glow-card/GlowCard`");
    expect(text).toContain("motion.div");
  });
});

describe("addToProject", () => {
  it("plans, previews, confirms, applies and opens the written files", async () => {
    mock.registered.workspaceFolders = [folder("web", "/work/web")];
    mock.registered.warningAnswers.push(APPLY_ACTION);
    const { runner, deps } = setup({ "add cmp_local_glow-card --project /work/web --dry-run": dryRun(), "add cmp_local_glow-card --project /work/web --apply": applied() });

    const result = await addToProject(deps, node);

    expect(runner.calls).toEqual([
      ["add", "cmp_local_glow-card", "--project", "/work/web", "--dry-run", "--json"],
      ["add", "cmp_local_glow-card", "--project", "/work/web", "--apply", "--manifest", expect.any(String), "--json"],
    ]);
    expect(result?.applied).toBe(true);
    const preview = mock.registered.executed.find((call) => call.id === "markdown.showPreview");
    const previewUri = preview?.args[0] as vscode.Uri;
    expect(previewUri.scheme).toBe(PLAN_SCHEME);
    expect(deps.plans.provideTextDocumentContent(previewUri)).toContain("# Add Glow Card to web");
    expect(mock.registered.openedDocuments).toEqual(["/work/web/src/components/glow-card/GlowCard.tsx"]);
    expect(mock.registered.messages.at(-1)?.text).toMatch(/Install: motion/);
  });

  it("applies the reviewed bundle through a manifest file and removes it afterwards", async () => {
    mock.registered.workspaceFolders = [folder("web", "/work/web")];
    mock.registered.warningAnswers.push(APPLY_ACTION);
    let manifestPath = "";
    let manifestJson: unknown;
    const { runner, deps } = setup({
      "add cmp_local_glow-card --project /work/web --dry-run": dryRun(),
      "add cmp_local_glow-card --project /work/web --apply": (args) => {
        manifestPath = args[args.indexOf("--manifest") + 1];
        manifestJson = JSON.parse(readFileSync(manifestPath, "utf8"));
        return applied();
      },
    });
    await addToProject(deps, node);
    expect(runner.calls[1]).toContain("--manifest");
    expect(manifestJson).toEqual(dataOf("add-dry-run.json").bundle);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("removes the manifest file when the apply fails", async () => {
    mock.registered.workspaceFolders = [folder("web", "/work/web")];
    mock.registered.warningAnswers.push(APPLY_ACTION);
    let manifestPath = "";
    const { deps } = setup({
      "add cmp_local_glow-card --project /work/web --dry-run": dryRun(),
      "add cmp_local_glow-card --project /work/web --apply": (args) => {
        manifestPath = args[args.indexOf("--manifest") + 1];
        throw new Error("boom");
      },
    });
    await addToProject(deps, node);
    expect(manifestPath).not.toBe("");
    expect(existsSync(manifestPath)).toBe(false);
    expect(mock.registered.messages.at(-1)?.text).toMatch(/boom/);
  });

  it("writes nothing when the user does not confirm", async () => {
    mock.registered.workspaceFolders = [folder("web", "/work/web")];
    mock.registered.warningAnswers.push(undefined);
    const { runner, deps } = setup({ "add cmp_local_glow-card --project /work/web --dry-run": dryRun() });
    expect(await addToProject(deps, node)).toBeUndefined();
    expect(runner.calls.map((args) => args.includes("--apply"))).toEqual([false]);
    expect(mock.registered.openedDocuments).toEqual([]);
  });

  it("asks which folder in a multi-root workspace", async () => {
    const api = folder("api", "/work/api", 0);
    const web = folder("web", "/work/web", 1);
    mock.registered.workspaceFolders = [api, web];
    mock.registered.folderPickAnswers.push(web);
    mock.registered.warningAnswers.push(undefined);
    const { runner, deps } = setup({ "add cmp_local_glow-card --project /work/web --dry-run": dryRun() });
    await addToProject(deps, node);
    expect(runner.calls[0]).toContain("/work/web");
  });

  it("stops when the folder pick is cancelled", async () => {
    mock.registered.workspaceFolders = [folder("api", "/work/api", 0), folder("web", "/work/web", 1)];
    const { runner, deps } = setup({});
    expect(await addToProject(deps, node)).toBeUndefined();
    expect(runner.calls).toEqual([]);
  });

  it("explains when no folder is open", async () => {
    const { runner, deps } = setup({});
    await addToProject(deps, node);
    expect(runner.calls).toEqual([]);
    expect(mock.registered.messages).toEqual([{ level: "error", text: "Open a project folder before adding a block." }]);
  });

  it("refuses a non-local folder unless a workspace writer is plugged in", async () => {
    mock.registered.workspaceFolders = [{ name: "remote", index: 0, uri: mock.Uri.from({ scheme: "vscode-remote", path: "/srv/web" }) }];
    const { runner, deps } = setup({});
    await addToProject(deps, node);
    expect(runner.calls).toEqual([]);
    expect(mock.registered.messages[0].text).toMatch(/not a local folder \(vscode-remote\)/);
  });

  it("refuses to overwrite changed files and never applies", async () => {
    mock.registered.workspaceFolders = [folder("web", "/work/web")];
    const envelope = JSON.parse(fixture("add-dry-run.json"));
    envelope.data.bundle.files[0] = { ...envelope.data.bundle.files[0], operation: "replace", targetHash: "sha256:other" };
    const { runner, deps } = setup({ "add cmp_local_glow-card --project /work/web --dry-run": ok(JSON.stringify(envelope)) });
    expect(await addToProject(deps, node)).toBeUndefined();
    expect(runner.calls).toHaveLength(1);
    expect(mock.registered.messages[0]).toMatchObject({ level: "error", text: expect.stringMatching(/overwritten/) });
  });

  it("shows the CLI's error message when the add fails", async () => {
    mock.registered.workspaceFolders = [folder("web", "/work/web")];
    const notFound: CliResult = { exitCode: 3, stdout: fixture("add-not-found.json"), stderr: "" };
    const { deps } = setup({ add: notFound });
    await addToProject(deps, node);
    expect(mock.registered.messages[0].text).toBe("Add to project failed: No component matched the exact ID or alias.");
  });

  it("tells the user to install the CLI when it is missing", async () => {
    mock.registered.workspaceFolders = [folder("web", "/work/web")];
    const { deps } = setup({ add: new CliNotFoundError("blockbase") });
    await addToProject(deps, node);
    expect(mock.registered.messages[0].text).toMatch(/npm install -g @blockbase\/cli/);
  });

  it("asks for a block when run from the command palette", async () => {
    mock.registered.workspaceFolders = [folder("web", "/work/web")];
    mock.registered.quickPickAnswers.push((items) => items[0]);
    mock.registered.warningAnswers.push(undefined);
    const { runner, deps } = setup({ "catalog list": recorded.list(), add: dryRun() });
    await addToProject(deps);
    expect(runner.calls[0]).toEqual(["catalog", "list", "--json"]);
    expect(runner.calls[1].slice(0, 1)).toEqual(["add"]);
  });
});

describe("Add to Project command", () => {
  it("is registered and runs on the block it was invoked on", async () => {
    mock.registered.commands.clear();
    mock.registered.workspaceFolders = [folder("web", "/work/web")];
    mock.registered.warningAnswers.push(undefined);
    const runner = fakeRunner({ "catalog list": recorded.list(), "catalog locate": recorded.locate(), add: dryRun() });
    activate({ subscriptions: [], extensionUri: mock.Uri.file("/ext") } as unknown as vscode.ExtensionContext, runner);
    expect(mock.registered.contentProviders.has(PLAN_SCHEME)).toBe(true);
    await mock.registered.commands.get(COMMANDS.addToProject)?.(node);
    expect(runner.calls.find((args) => args[0] === "add")).toEqual(["add", "cmp_local_glow-card", "--project", "/work/web", "--dry-run", "--json"]);
  });
});
