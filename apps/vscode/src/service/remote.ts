/**
 * Remote workspace support (Remote SSH, Codespaces, dev containers).
 *
 * The extension is `extensionKind: ["ui"]`, so it always runs on the local machine,
 * next to the local `blockbase` CLI and catalog service. In a remote window only the
 * workspace files live elsewhere, so anything written into the project must go through
 * `vscode.workspace.fs` on the folder's URI, never a local file path.
 */
import * as vscode from "vscode";

export interface RemoteContext {
  isRemote: boolean;
  /** e.g. "ssh-remote", "codespaces", "dev-container", "wsl"; undefined for local windows. */
  remoteName: string | undefined;
}

export function remoteContext(): RemoteContext {
  const remoteName = vscode.env.remoteName;
  return { isRemote: remoteName !== undefined, remoteName };
}

/**
 * URL the panel webview should load for a catalog page. Locally (and for a UI-side
 * extension) this is the same URL; if the extension ever runs on the workspace side,
 * VS Code returns a forwarded address instead.
 */
export async function catalogUrlForWebview(url: string): Promise<string> {
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
  return external.toString();
}

export interface WorkspaceFile {
  /** Path relative to the workspace folder, using "/" separators. */
  path: string;
  contents: string;
}

function safeSegments(relative: string): string[] {
  const segments = relative.split("/");
  const escapes =
    relative.length === 0 ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    /^[a-zA-Z]:/.test(relative) ||
    segments.some((s) => s === ".." || s === "");
  if (escapes) throw new Error(`Refusing to write outside the workspace folder: ${JSON.stringify(relative)}`);
  const kept = segments.filter((s) => s !== ".");
  if (kept.length === 0) throw new Error(`Refusing to write to the workspace folder itself: ${JSON.stringify(relative)}`);
  return kept;
}

export interface WriteOptions {
  /** Replace files that already exist. Default false: existing files are a collision. */
  overwrite?: boolean;
}

function isFileNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "FileNotFound";
}

/**
 * Write files into a workspace folder, local or remote. All paths are checked and every
 * target is stat-checked before anything is written, so a bad path or a collision leaves
 * the folder untouched. Existing files are refused unless `overwrite` is true.
 */
export async function writeIntoWorkspace(
  folder: vscode.Uri,
  files: WorkspaceFile[],
  options: WriteOptions = {},
): Promise<vscode.Uri[]> {
  const overwrite = options.overwrite ?? false;
  const seen = new Set<string>();
  const targets = files.map((f) => {
    const segments = safeSegments(f.path);
    const key = segments.join("/");
    if (seen.has(key)) throw new Error(`Duplicate path in one write: ${JSON.stringify(key)}`);
    seen.add(key);
    return vscode.Uri.joinPath(folder, ...segments);
  });

  if (!overwrite) {
    const collisions: string[] = [];
    for (const [i, target] of targets.entries()) {
      try {
        await vscode.workspace.fs.stat(target);
        collisions.push(files[i]!.path);
      } catch (err) {
        if (!isFileNotFound(err)) throw err;
      }
    }
    if (collisions.length > 0) {
      throw new Error(`Refusing to overwrite existing files: ${collisions.join(", ")}`);
    }
  }

  const encoder = new TextEncoder();
  for (const [i, target] of targets.entries()) {
    await vscode.workspace.fs.writeFile(target, encoder.encode(files[i]!.contents));
  }
  return targets;
}
