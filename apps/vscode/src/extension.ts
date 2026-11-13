/**
 * Extension entry. All registration happens here; feature code lives in
 * add/ (add a block to the workspace), cli/ (CLI runner), tree/ (sidebar), panel/ (editor webview) and service/ (local Blockbase service).
 */
import * as vscode from "vscode";
import { applyRefusal, type AddResult } from "./add/addPlan";
import { PLAN_SCHEME, PlanDocuments, addToProject, cliApplier, type PlanApplier } from "./add/addToProject";
import { BlockbaseCli } from "./cli/blockbaseCli";
import { execFileRunner, type CliRunner } from "./cli/runner";
import { CATALOG_VIEW_ID, CLI_BIN, COMMANDS, CONFIG_SECTION, SETTINGS } from "./config";
import { copyHandoff, type HandoffArgument } from "./handoff/copyHandoff";
import { CatalogPanel } from "./panel/catalogPanel";
import { parseCatalogTarget } from "./panel/catalogUrl";
import { resolveCatalogPort } from "./panel/resolvePort";
import { writeIntoWorkspace } from "./service/remote";
import { ServiceRecovery } from "./service/serviceRecovery";
import { CatalogTreeProvider } from "./tree/catalogTreeProvider";
import type { BlockNode } from "./tree/catalogModel";
import { CatalogWatcher } from "./tree/catalogWatcher";

let recovery: ServiceRecovery | undefined;

function isFileNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "FileNotFound";
}

/**
 * Applies a reviewed plan from its own file contents through `vscode.workspace.fs`, so it also
 * works in a remote window. Nothing is overwritten: existing files are refused before any write.
 */
function remoteApplier(): PlanApplier {
  return async (_component, folder, plan): Promise<AddResult> => {
    if (plan.files.some((file) => typeof file.content !== "string")) {
      void vscode.window.showErrorMessage("Blockbase cannot add this block here: the plan has no file contents.");
      return { ...plan, applied: false };
    }
    const existing = new Set<string>();
    for (const file of plan.files) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, file.path));
        existing.add(file.path);
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
      }
    }
    if (existing.size > 0) {
      const refused: AddResult = {
        ...plan,
        applied: false,
        files: plan.files.map((file) => (existing.has(file.path) ? { ...file, operation: "replace", targetHash: undefined } : file)),
      };
      void vscode.window.showErrorMessage(applyRefusal(refused) ?? "These files already exist.");
      return refused;
    }
    await writeIntoWorkspace(
      folder.uri,
      plan.files.map((file) => ({ path: file.path, contents: file.content as string })),
    );
    return { ...plan, applied: true };
  };
}

/** Local folders keep the CLI apply; any other scheme (remote, virtual) writes through `workspace.fs`. */
export function workspaceApplier(cli: BlockbaseCli): PlanApplier {
  const local = cliApplier(cli);
  const remote = remoteApplier();
  return (component, folder, plan) => (folder.uri.scheme === "file" ? local(component, folder, plan) : remote(component, folder, plan));
}

/** `runner` is injectable for tests; production uses execFile on `blockbase` from PATH. */
export function activate(context: vscode.ExtensionContext, runner: CliRunner = execFileRunner()): void {
  const cli = new BlockbaseCli(runner);
  const tree = new CatalogTreeProvider(cli);
  // Service calls go through the same injected runner as every other CLI call, so tests never spawn the CLI.
  recovery = new ServiceRecovery({ bin: CLI_BIN, runner: (_file, args) => runner(args) });
  const service = recovery;
  const panel = new CatalogPanel(
    context.extensionUri,
    () => resolveCatalogPort({ setting: vscode.workspace.getConfiguration(CONFIG_SECTION).get(SETTINGS.port, 0) }),
    service,
  );
  const plans = new PlanDocuments();
  const treeView = vscode.window.createTreeView(CATALOG_VIEW_ID, { treeDataProvider: tree, showCollapseAll: true });

  let watcher: CatalogWatcher | undefined;
  const watchCatalog = async () => {
    if (watcher) return;
    try {
      const location = await cli.locate();
      if (location.found && location.rootPath && !watcher) watcher = new CatalogWatcher(location.rootPath, () => tree.refresh());
    } catch {
      // CLI missing or catalog not created yet: retried on the next manual refresh.
    }
  };
  void watchCatalog();

  context.subscriptions.push(
    tree,
    panel,
    treeView,
    { dispose: () => watcher?.dispose() },
    vscode.commands.registerCommand(COMMANDS.refresh, () => {
      tree.refresh();
      void watchCatalog();
    }),
    vscode.commands.registerCommand(COMMANDS.openPanel, (target?: unknown, options?: unknown) =>
      panel.show(parseCatalogTarget(target), { preserveFocus: (options as { preserveFocus?: unknown } | null | undefined)?.preserveFocus === true }),),
    vscode.commands.registerCommand(COMMANDS.search, async () => {
      const query = await vscode.window.showInputBox({ prompt: "Search the Blockbase catalog", placeHolder: "e.g. pricing table", value: tree.searchQuery });
      if (query !== undefined) tree.setSearch(query);
    }),
    vscode.commands.registerCommand(COMMANDS.clearSearch, () => tree.setSearch(undefined)),
    service,
    vscode.commands.registerCommand(COMMANDS.installService, () => service.install()),
    vscode.commands.registerCommand(COMMANDS.runForSession, () => service.runForSession()),
    vscode.commands.registerCommand(COMMANDS.restartService, () => service.restart()),
    vscode.commands.registerCommand(COMMANDS.copyHandoff, async (arg?: HandoffArgument) => {
      if (!tree.catalog) await tree.getChildren();
      return copyHandoff(arg, tree.catalog);
    }),
    plans,
    vscode.workspace.registerTextDocumentContentProvider(PLAN_SCHEME, plans),
    vscode.commands.registerCommand(COMMANDS.addToProject, (node?: BlockNode) => addToProject({ cli, plans, applier: workspaceApplier(cli) }, node?.kind === "block" ? node : undefined)),
  );
}

/** Kills a "Run for this session" child even if subscriptions were not disposed. */
export function deactivate(): void {
  recovery?.dispose();
  recovery = undefined;
}
