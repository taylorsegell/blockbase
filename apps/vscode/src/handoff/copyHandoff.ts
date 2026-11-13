import { handoffText, type HandoffTarget } from "@blockbase/contracts";
import * as vscode from "vscode";
import type { CatalogList } from "../cli/blockbaseCli";

/** A component id, or a sidebar block node (`{ component: { componentId, ... } }`). */
export type HandoffArgument = string | { component?: Partial<HandoffTarget> } | undefined;

function componentIdOf(arg: HandoffArgument): string | undefined {
  if (typeof arg === "string") return arg.trim() || undefined;
  const id = arg?.component?.componentId;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * Builds the same handoff text as the catalog page's "Copy commands" button.
 * Uses the raw catalog entry, not the tree's display placement, because the page does.
 */
export function resolveHandoffText(arg: HandoffArgument, catalog: CatalogList | undefined): { id?: string; text?: string } {
  const id = componentIdOf(arg);
  if (!id) return {};
  const entry = catalog?.components.find((component) => component.componentId === id);
  return entry ? { id, text: handoffText(entry) } : { id };
}

/** `blockbase.copyHandoff`: writes the handoff for a block to the clipboard. */
export async function copyHandoff(arg: HandoffArgument, catalog: CatalogList | undefined): Promise<boolean> {
  const { id, text } = resolveHandoffText(arg, catalog);
  if (!text) {
    void vscode.window.showWarningMessage(
      id ? `Blockbase: ${id} is not in the catalog. Refresh and try again.` : "Blockbase: choose a block to copy its handoff.",
    );
    return false;
  }
  await vscode.env.clipboard.writeText(text);
  void vscode.window.showInformationMessage(`Copied the agent handoff for ${id}.`);
  return true;
}
