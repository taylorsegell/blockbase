import * as vscode from "vscode";
import { CliNotFoundError } from "../cli/runner";
import type { BlockbaseCli, CatalogList } from "../cli/blockbaseCli";
import { COMMANDS, CONTEXT_KEYS } from "../config";
import { buildCatalogTree, buildSearchTree, FAVORITES_ID, type CatalogNode } from "./catalogModel";
import type { CatalogTarget } from "../panel/catalogUrl";
import { categoryLabel } from "./placement";

/** contextValue of block items; use it in `view/item/context` menus (`viewItem == block`). */
export const BLOCK_CONTEXT_VALUE = "block";

type SetContext = (key: string, value: unknown) => unknown;

const defaultSetContext: SetContext = (key, value) => vscode.commands.executeCommand("setContext", key, value);

/**
 * Sidebar tree filled from `blockbase catalog list --json` and `blockbase search <q> --json`.
 * When the CLI is not on PATH it returns no items and sets `blockbase.cliMissing`, so the
 * view's welcome content shows install instructions.
 */
export class CatalogTreeProvider implements vscode.TreeDataProvider<CatalogNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<CatalogNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private list: CatalogList | undefined;
  private roots: Promise<CatalogNode[]> | undefined;
  private query: string | undefined;

  constructor(
    private readonly cli: BlockbaseCli,
    private readonly setContext: SetContext = defaultSetContext,
  ) {}

  /** The last catalog listing, for commands that need component details. */
  get catalog(): CatalogList | undefined {
    return this.list;
  }

  get searchQuery(): string | undefined {
    return this.query;
  }

  refresh(): void {
    this.roots = undefined;
    this.changed.fire(undefined);
  }

  setSearch(query: string | undefined): void {
    const trimmed = query?.trim();
    this.query = trimmed ? trimmed : undefined;
    void this.setContext(CONTEXT_KEYS.searching, this.query !== undefined);
    this.refresh();
  }

  getTreeItem(node: CatalogNode): vscode.TreeItem {
    if (node.kind === "message") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      return item;
    }
    if (node.kind === "block") {
      const { component } = node;
      const item = new vscode.TreeItem(component.displayName, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.description = component.category ? categoryLabel(component.category) : undefined;
      item.contextValue = BLOCK_CONTEXT_VALUE;
      item.command = openInCatalog({ blockId: component.componentId });
      item.iconPath = new vscode.ThemeIcon("symbol-class");
      const tooltip = new vscode.MarkdownString();
      tooltip.appendMarkdown(`**${escapeMarkdown(component.displayName)}**\n\n`);
      if (component.description) tooltip.appendMarkdown(`${escapeMarkdown(component.description)}\n\n`);
      if (component.tags.length > 0) tooltip.appendMarkdown(`Tags: ${component.tags.map((tag) => escapeMarkdown(tag)).join(", ")}`);
      item.tooltip = tooltip;
      return item;
    }
    const favorites = node.id === `collection:${FAVORITES_ID}`;
    const expanded = node.kind === "bucket" || favorites;
    const item = new vscode.TreeItem(node.label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = node.id;
    item.contextValue = node.kind;
    item.command = openInCatalog(
      node.kind === "collection" ? { collectionId: node.targetId } : node.kind === "bucket" ? { bucketId: node.targetId } : { categoryId: node.targetId },
    );
    item.description = String(countBlocks(node));
    item.iconPath = new vscode.ThemeIcon(favorites ? "star-full" : node.kind === "collection" ? "folder-library" : node.kind === "bucket" ? "layers" : "folder");
    return item;
  }

  getChildren(node?: CatalogNode): Promise<CatalogNode[]> | CatalogNode[] {
    if (node) return node.kind === "block" || node.kind === "message" ? [] : node.children;
    this.roots ??= this.load();
    return this.roots;
  }

  private async load(): Promise<CatalogNode[]> {
    try {
      this.list = await this.cli.listCatalog();
      await this.setContext(CONTEXT_KEYS.cliMissing, false);
      if (this.query !== undefined) return buildSearchTree(this.query, await this.cli.search(this.query), this.list);
      return buildCatalogTree(this.list);
    } catch (error) {
      if (error instanceof CliNotFoundError) {
        this.list = undefined;
        await this.setContext(CONTEXT_KEYS.cliMissing, true);
        return [];
      }
      const message = error instanceof Error ? error.message : String(error);
      return [{ kind: "message", id: "error", label: `Blockbase: ${message}` }];
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** Clicking a node navigates the catalog panel without taking focus from the tree; the page resolves `blockId` by componentId or slug. */
function openInCatalog(target: CatalogTarget): vscode.Command {
  return { command: COMMANDS.openPanel, title: "Open in Catalog", arguments: [target, { preserveFocus: true }] };
}

function countBlocks(node: CatalogNode): number {
  if (node.kind === "block") return 1;
  if (node.kind === "message") return 0;
  return node.children.reduce((total, child) => total + countBlocks(child), 0);
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}
