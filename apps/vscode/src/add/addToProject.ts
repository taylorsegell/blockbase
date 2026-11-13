/**
 * "Add to Project": pick a workspace folder, show the `add --dry-run` plan, confirm, `add --apply`,
 * then open the written files. Nothing is written before the modal confirm.
 */
import * as vscode from "vscode";
import type { BlockbaseCli, CatalogComponent } from "../cli/blockbaseCli";
import { CliNotFoundError } from "../cli/runner";
import type { BlockNode } from "../tree/catalogModel";
import { applyRefusal, renderPlanMarkdown, type AddResult } from "./addPlan";

export const PLAN_SCHEME = "blockbase-plan";
export const APPLY_ACTION = "Apply";

/** Read-only virtual documents holding plan previews, keyed by URI path. */
export class PlanDocuments implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  set(name: string, markdown: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PLAN_SCHEME, path: `/${name}.md` });
    this.documents.set(uri.path, markdown);
    this.changed.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.path) ?? "This plan preview has expired. Run Add to Project again.";
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/**
 * Writes an approved plan into the folder. The default runs `blockbase add --apply` on a local
 * folder, from the bundle the user reviewed. A remote window (extensionKind `ui`) cannot let the local CLI write into the remote
 * workspace; a `vscode.workspace.fs` writer for that case plugs in here (see ARK-423).
 */
export type PlanApplier = (component: CatalogComponent, folder: vscode.WorkspaceFolder, plan: AddResult) => Promise<AddResult>;

export function cliApplier(cli: BlockbaseCli): PlanApplier {
  return (component, folder, plan) => cli.applyAdd(component.componentId, folder.uri.fsPath, plan.bundle);
}

export interface AddToProjectDeps {
  cli: BlockbaseCli;
  plans: PlanDocuments;
  applier?: PlanApplier;
}

function describeError(error: unknown): string {
  if (error instanceof CliNotFoundError) return "The Blockbase CLI was not found on your PATH. Install it with `npm install -g @blockbase/cli`.";
  return error instanceof Error ? error.message : String(error);
}

async function pickComponent(cli: BlockbaseCli): Promise<CatalogComponent | undefined> {
  const list = await cli.listCatalog();
  if (list.components.length === 0) {
    void vscode.window.showInformationMessage("The Blockbase catalog is empty. Import a block first.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.components.map((component) => ({ label: component.displayName, description: component.slug, detail: component.description, component })),
    { placeHolder: "Block to add to the project", matchOnDescription: true },
  );
  return picked?.component;
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage("Open a project folder before adding a block.");
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({ placeHolder: "Folder to add the block to" });
}

/** Runs the whole flow. Returns the apply result, or undefined when cancelled or failed. */
export async function addToProject(deps: AddToProjectDeps, node?: BlockNode): Promise<AddResult | undefined> {
  try {
    const component = node?.component ?? (await pickComponent(deps.cli));
    if (!component) return undefined;
    const folder = await pickFolder();
    if (!folder) return undefined;
    const applier = deps.applier ?? cliApplier(deps.cli);
    if (!deps.applier && folder.uri.scheme !== "file") {
      void vscode.window.showErrorMessage(`Blockbase cannot add blocks to ${folder.name} yet: it is not a local folder (${folder.uri.scheme}).`);
      return undefined;
    }

    const plan = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Planning ${component.displayName}…` },
      () => deps.cli.planAdd(component.componentId, folder.uri.fsPath),
    );
    const previewUri = deps.plans.set(`add-${component.slug}-to-${folder.name}`, renderPlanMarkdown(plan, component.displayName, folder.name));
    await vscode.commands.executeCommand("markdown.showPreview", previewUri);

    const refusal = applyRefusal(plan);
    if (refusal) {
      void vscode.window.showErrorMessage(refusal);
      return undefined;
    }
    const answer = await vscode.window.showWarningMessage(
      `Add ${component.displayName} to ${folder.name}?`,
      { modal: true, detail: `Writes ${plan.files.length} file(s) under ${plan.placement.directory}. Risk: ${plan.risk}.` },
      APPLY_ACTION,
    );
    if (answer !== APPLY_ACTION) return undefined;

    const applied = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Adding ${component.displayName}…` },
      () => applier(component, folder, plan),
    );
    if (!applied.applied) {
      void vscode.window.showErrorMessage(`Blockbase did not apply ${component.displayName}; nothing was written.`);
      return applied;
    }
    for (const file of applied.files) {
      await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, file.path), { preview: false, preserveFocus: true });
    }
    const install = applied.dependencies.map((dep) => dep.name).join(" ");
    void vscode.window.showInformationMessage(
      `Added ${component.displayName}. Import it from ${applied.placement.importPath}.${install ? ` Install: ${install}` : ""}`,
    );
    return applied;
  } catch (error) {
    void vscode.window.showErrorMessage(`Add to project failed: ${describeError(error)}`);
    return undefined;
  }
}
