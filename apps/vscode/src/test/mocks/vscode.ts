/** Minimal vscode module stand-in for unit tests (aliased in vitest.config.ts). */
import * as path from "node:path";

export interface UriLike {
  scheme: string;
  authority: string;
  fsPath: string;
  path: string;
  toString(): string;
}

function make(scheme: string, authority: string, p: string): UriLike {
  const posix = p.replace(/\\/g, "/");
  const str = scheme === "file" ? p : `${scheme}://${authority}${posix}`;
  return { scheme, authority, fsPath: p, path: posix, toString: () => str };
}

function uri(p: string): UriLike {
  return make("file", "", p);
}

export const Uri = {
  file: uri,
  from(c: { scheme: string; authority?: string; path: string }): UriLike {
    return make(c.scheme, c.authority ?? "", c.path);
  },
  parse(value: string): UriLike {
    const u = new URL(value);
    return { ...make(u.protocol.slice(0, -1), u.host, u.pathname), toString: () => value };
  },
  joinPath(base: UriLike, ...parts: string[]): UriLike {
    if (base.scheme === "file") return uri(path.join(base.fsPath, ...parts));
    return make(base.scheme, base.authority, path.posix.join(base.path, ...parts));
  },
};

/** Remote and port-forwarding stand-ins (ARK-423). Tests set remoteName and externalUris. */
export const env = {
  clipboard: {
    async writeText(text: string) {
      registered.clipboard.push(text);
    },
  },
  remoteName: undefined as string | undefined,
  externalUris: new Map<string, string>(),
  async asExternalUri(u: UriLike): Promise<UriLike> {
    const mapped = env.externalUris.get(String(u));
    return mapped ? Uri.parse(mapped) : u;
  },
};

export class FileSystemError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
  static FileNotFound(what?: unknown): FileSystemError {
    return new FileSystemError(`FileNotFound: ${String(what)}`, "FileNotFound");
  }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const ViewColumn = { One: 1 };
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };

export interface MockPanel {
  webview: { html: string; cspSource: string; asWebviewUri(u: UriLike): UriLike; postMessage(m: unknown): Promise<boolean>; onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void } };
  posted: unknown[];
  revealCount: number;
  /** `preserveFocus` of each reveal call. */
  revealFocus: Array<boolean | undefined>;
  /** showOptions passed to createWebviewPanel. */
  showOptions: unknown;
  reveal(column?: unknown, preserveFocus?: boolean): void;
  onDidDispose(fn: () => void): { dispose(): void };
  /** Simulate the webview posting a message to the extension. */
  receive(message: unknown): void;
  /** Simulate the user closing the tab. */
  close(): void;
  dispose(): void;
}

export const registered = {
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  treeViews: [] as string[],
  panels: [] as string[],
  context: new Map<string, unknown>(),
  watchers: [] as FileSystemWatcherMock[],
  inputBoxAnswers: [] as Array<string | undefined>,
  panelObjects: [] as MockPanel[],
  clipboard: [] as string[],
  executed: [] as Array<{ id: string; args: unknown[] }>,
  contentProviders: new Map<string, unknown>(),
  workspaceFolders: undefined as Array<{ name: string; index: number; uri: UriLike }> | undefined,
  quickPickAnswers: [] as Array<(items: unknown[]) => unknown>,
  folderPickAnswers: [] as unknown[],
  warningAnswers: [] as Array<string | undefined>,
  messages: [] as Array<{ level: "info" | "warning" | "error"; text: string }>,
  openedDocuments: [] as string[],
};

/** Last webview panel the code created. */
export function lastPanel(): MockPanel {
  const p = registered.panelObjects.at(-1);
  if (!p) throw new Error("no panel created");
  return p;
}

/** Clear registrations and restore defaults between tests. */
export function reset(): void {
  registered.commands.clear();
  registered.treeViews.length = 0;
  registered.panels.length = 0;
  registered.panelObjects.length = 0;
  registered.context.clear();
  registered.watchers.length = 0;
  registered.inputBoxAnswers.length = 0;
  registered.clipboard.length = 0;
  resetUi();
  window.activeColorTheme.kind = ColorThemeKind.Dark;
  configValues.clear();
  env.remoteName = undefined;
  env.externalUris.clear();
  workspace.written.clear();
  workspace.existing.clear();
  workspace.statErrors.clear();
}

export const configValues = new Map<string, unknown>();

/** Clears the recorded UI state between tests. */
export function resetUi(): void {
  registered.executed.length = 0;
  registered.contentProviders.clear();
  registered.workspaceFolders = undefined;
  registered.quickPickAnswers.length = 0;
  registered.folderPickAnswers.length = 0;
  registered.warningAnswers.length = 0;
  registered.messages.length = 0;
  registered.openedDocuments.length = 0;
}

export const ProgressLocation = { Notification: 15 };

export const commands = {
  registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
    registered.commands.set(id, fn);
    return { dispose: () => registered.commands.delete(id) };
  },
  async executeCommand(id: string, ...args: unknown[]) {
    registered.executed.push({ id, args });
    if (id === "setContext") registered.context.set(String(args[0]), args[1]);
    return undefined;
  },
};

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: unknown;
  contextValue?: string;
  iconPath?: unknown;
  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export class MarkdownString {
  value = "";
  appendMarkdown(text: string) {
    this.value += text;
    return this;
  }
}

export class RelativePattern {
  constructor(
    public readonly base: UriLike,
    public readonly pattern: string,
  ) {}
}

export class FileSystemWatcherMock {
  readonly changed = new EventEmitter<UriLike>();
  disposed = false;
  constructor(public readonly pattern: RelativePattern) {}
  onDidChange = this.changed.event;
  onDidCreate = this.changed.event;
  onDidDelete = this.changed.event;
  dispose() {
    this.disposed = true;
  }
}

export const workspace = {
  /** In-memory file map: writeFile stores here, stat/readFile read from it. */
  written: new Map<string, Uint8Array>(),
  /** URIs that already exist (without content) so stat finds them; tests seed this to model existing files. */
  existing: new Set<string>(),
  /** Per-URI errors for stat to throw (tests inject non-FileNotFound failures). */
  statErrors: new Map<string, Error>(),
  fs: {
    async stat(u: UriLike): Promise<{ type: number }> {
      const err = workspace.statErrors.get(String(u));
      if (err) throw err;
      if (!workspace.existing.has(String(u)) && !workspace.written.has(String(u))) throw FileSystemError.FileNotFound(u);
      return { type: 1 };
    },
    async readFile(u: UriLike): Promise<Uint8Array> {
      const data = workspace.written.get(String(u));
      if (!data) throw FileSystemError.FileNotFound(u);
      return data;
    },
    async writeFile(u: UriLike, content: Uint8Array): Promise<void> {
      workspace.written.set(String(u), content);
    },
  },
  get workspaceFolders() {
    return registered.workspaceFolders;
  },
  registerTextDocumentContentProvider(scheme: string, provider: unknown) {
    registered.contentProviders.set(scheme, provider);
    return { dispose: () => registered.contentProviders.delete(scheme) };
  },
  createFileSystemWatcher(pattern: RelativePattern) {
    const watcher = new FileSystemWatcherMock(pattern);
    registered.watchers.push(watcher);
    return watcher;
  },
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const v = configValues.get(`${section}.${key}`);
        return (v === undefined ? fallback : v) as T;
      },
    };
  },
};

export const window = {
  activeColorTheme: { kind: ColorThemeKind.Dark },
  createTreeView(id: string) {
    registered.treeViews.push(id);
    return { dispose() {} };
  },
  async showInputBox() {
    return registered.inputBoxAnswers.shift();
  },
  async showQuickPick(items: unknown[]) {
    const answer = registered.quickPickAnswers.shift();
    return answer ? answer(items) : undefined;
  },
  async showWorkspaceFolderPick() {
    return registered.folderPickAnswers.shift();
  },
  async showWarningMessage(text: string) {
    registered.messages.push({ level: "warning", text });
    return registered.warningAnswers.shift();
  },
  async showErrorMessage(text: string) {
    registered.messages.push({ level: "error", text });
    return undefined;
  },
  async showInformationMessage(text: string) {
    registered.messages.push({ level: "info", text });
    return undefined;
  },
  async withProgress<T>(_options: unknown, task: () => Promise<T>) {
    return task();
  },
  async showTextDocument(target: UriLike) {
    registered.openedDocuments.push(target.fsPath);
    return {};
  },
  createWebviewPanel(viewType: string, _title?: string, showOptions?: unknown) {
    registered.panels.push(viewType);
    const disposeListeners: Array<() => void> = [];
    let messageListener: ((message: unknown) => void) | undefined;
    const panel: MockPanel = {
      webview: {
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (u: UriLike) => u,
        postMessage: async (m: unknown) => {
          panel.posted.push(m);
          return true;
        },
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          messageListener = listener;
          return {
            dispose() {
              if (messageListener === listener) messageListener = undefined;
            },
          };
        },
      },
      posted: [],
      revealCount: 0,
      revealFocus: [],
      showOptions,
      reveal(_column?: unknown, preserveFocus?: boolean) {
        panel.revealCount++;
        panel.revealFocus.push(preserveFocus);
      },
      onDidDispose(fn) {
        disposeListeners.push(fn);
        return { dispose() {} };
      },
      receive(message: unknown) {
        messageListener?.(message);
      },
      close() {
        for (const fn of disposeListeners) fn();
      },
      dispose() {
        panel.close();
      },
    };
    registered.panelObjects.push(panel);
    return panel;
  },
};
