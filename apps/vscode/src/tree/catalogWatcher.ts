import * as vscode from "vscode";

/**
 * Every catalog change made through Blockbase is a commit in the catalog's own git history,
 * so its reflog (`.git/logs/HEAD`) is the change signal. Only the file's timestamp matters;
 * the extension never reads catalog contents directly.
 */
export const HISTORY_SIGNAL_GLOB = ".git/logs/HEAD";

/** Watches the catalog history and calls `onChange` (debounced) when it moves. */
export class CatalogWatcher implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    catalogRoot: string,
    private readonly onChange: () => void,
    private readonly debounceMs = 300,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(catalogRoot), HISTORY_SIGNAL_GLOB));
    const fire = () => this.schedule();
    this.watcher.onDidChange(fire);
    this.watcher.onDidCreate(fire);
    this.watcher.onDidDelete(fire);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onChange();
    }, this.debounceMs);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watcher.dispose();
  }
}
