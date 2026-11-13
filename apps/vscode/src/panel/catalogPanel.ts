import * as vscode from "vscode";
import { COMMANDS, PANEL_VIEW_TYPE } from "../config";
import { renderNotRunningHtml, SERVICE_MESSAGE_TYPE } from "../service/notRunningView";
import { catalogUrlForWebview } from "../service/remote";
import type { ServiceAction } from "../service/serviceRecovery";
import type { ServiceState } from "../service/status";
import { buildCatalogUrl, catalogOrigin, type CatalogTarget, type IdeTheme } from "./catalogUrl";
import { createNonce, getWebviewHtml } from "./getWebviewHtml";

/** Extension -> webview message: point the catalog iframe at `src`. */
export interface NavigateMessage {
  type: "blockbase:navigate";
  src: string;
}

export function ideTheme(): IdeTheme {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? "light" : "dark";
}

/** Webview -> extension message: the catalog frame failed to load or never loaded. */
export const FRAME_ERROR_TYPE = "blockbase:frame-error";

/** Webview -> extension message: copy the handoff for a component id (the page asked, the relay passed it on). */
export const COPY_HANDOFF_TYPE = "blockbase:copy-handoff";

/** Component ids are slugified; the allowlist keeps markdown and command-link text out of notifications. */
export const HANDOFF_ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,200}$/;

const SERVICE_ACTIONS: readonly string[] = ["install", "runSession", "restart", "retry"] satisfies readonly ServiceAction[];

/** The slice of `ServiceRecovery` the panel uses. */
export interface PanelRecovery {
  check(): Promise<ServiceState>;
  handleAction(action: ServiceAction): Promise<unknown>;
  onDidChangeState: vscode.Event<ServiceState>;
}

/** `preserveFocus`: show the panel without moving focus off the tree (tree clicks). */
export interface ShowOptions {
  preserveFocus?: boolean;
}

/**
 * One reused editor-panel webview that frames the local catalog page.
 * After the first open, navigation only changes the iframe hash, so the page does not reload.
 * With a `recovery`, a service that is not running shows the not-running view instead of the frame.
 */
export class CatalogPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private port: number | undefined;
  /** Origin the webview can reach (differs from the local one in remote windows). */
  private externalOrigin = "";
  /** Last requested target, kept so a reload after recovery lands where the user asked. */
  private target: CatalogTarget | undefined;
  /** What the panel shows now: the catalog frame page or the not-running view. */
  private view: "frame" | "not-running" | undefined;
  private readonly stateSubscription: vscode.Disposable | undefined;
  /** True while a frame-error status check runs, so a burst of messages costs one `ui status` call. */
  private frameErrorCheckInFlight = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getPort: () => number,
    private readonly recovery?: PanelRecovery,
  ) {
    this.stateSubscription = recovery?.onDidChangeState((state) => this.onStateChange(state));
  }

  async show(target?: CatalogTarget, options?: ShowOptions): Promise<void> {
    const preserveFocus = options?.preserveFocus === true;
    const port = this.getPort();
    this.target = target;
    if (this.panel && this.port === port && this.view === "frame") {
      this.panel.reveal(undefined, preserveFocus);
      const message: NavigateMessage = { type: "blockbase:navigate", src: this.src(port, target) };
      await this.panel.webview.postMessage(message);
      return;
    }
    // First open, a port change, or the not-running view: check the service, then (re)build the page.
    if (this.recovery) {
      const state = await this.recovery.check();
      if (state.kind !== "up") {
        this.showNotRunning(state, port, preserveFocus);
        return;
      }
    }
    await this.showFrame(port, preserveFocus);
  }

  /** Builds the frame page. The CSP frame-src must match the origin, so this runs on every rebuild. */
  private async showFrame(port: number, preserveFocus = false): Promise<void> {
    this.externalOrigin = new URL(await catalogUrlForWebview(`${catalogOrigin(port)}/`)).origin;
    this.port = port;
    const existing = this.panel;
    const panel = existing ?? this.create(port, preserveFocus);
    panel.webview.html = getWebviewHtml(panel.webview, this.extensionUri, undefined, {
      origin: this.externalOrigin,
      src: this.src(port, this.target),
    });
    this.view = "frame";
    if (existing) existing.reveal(undefined, preserveFocus);
    this.panel = panel;
  }

  private showNotRunning(state: ServiceState, port: number, preserveFocus = false): void {
    const existing = this.panel;
    const panel = existing ?? this.create(port, preserveFocus);
    panel.webview.html = renderNotRunningHtml(state, createNonce());
    this.view = "not-running";
    if (existing) existing.reveal(undefined, preserveFocus);
    this.panel = panel;
  }

  private create(port: number, preserveFocus = false): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, "Blockbase", { viewColumn: vscode.ViewColumn.One, preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
      portMapping: [{ webviewPort: port, extensionHostPort: port }],
    });
    panel.webview.onDidReceiveMessage((message: unknown) => this.onMessage(message));
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.port = undefined;
        this.view = undefined;
      }
    });
    return panel;
  }

  private src(port: number, target: CatalogTarget | undefined): string {
    return buildCatalogUrl({ port, theme: ideTheme(), target }).replace(catalogOrigin(port), this.externalOrigin);
  }

  /** Only reacts while the not-running view shows; the frame page never changes on a state event. */
  private onStateChange(state: ServiceState): void {
    if (!this.panel || this.view !== "not-running") return;
    if (state.kind === "up") {
      this.showFrame(this.getPort()).catch((error: unknown) => {
        void vscode.window.showErrorMessage(`Blockbase could not reload the catalog page: ${(error as Error).message}`);
      });
    } else {
      this.panel.webview.html = renderNotRunningHtml(state, createNonce());
    }
  }

  private onMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const { type, action, componentId } = message as { type?: unknown; action?: unknown; componentId?: unknown };
    if (type === COPY_HANDOFF_TYPE) {
      if (typeof componentId === "string" && HANDOFF_ID_PATTERN.test(componentId)) {
        void vscode.commands.executeCommand(COMMANDS.copyHandoff, componentId);
      }
      return;
    }
    if (!this.recovery) return;
    if (type === SERVICE_MESSAGE_TYPE) {
      // Service actions come only from the not-running view. While the frame page shows, a
      // catalog page (and any block code in it) is present, so the message is ignored.
      if (this.view !== "not-running") return;
      if (typeof action === "string" && SERVICE_ACTIONS.includes(action)) void this.recovery.handleAction(action as ServiceAction);
    } else if (type === FRAME_ERROR_TYPE) {
      if (this.frameErrorCheckInFlight) return;
      this.frameErrorCheckInFlight = true;
      void this.onFrameError(this.recovery).finally(() => {
        this.frameErrorCheckInFlight = false;
      });
    }
  }

  /** A frame error only triggers a status check; the page is replaced only if the service is down. */
  private async onFrameError(recovery: PanelRecovery): Promise<void> {
    const state = await recovery.check();
    if (state.kind !== "up" && this.panel && this.view === "frame" && this.port !== undefined) this.showNotRunning(state, this.port);
  }

  dispose(): void {
    this.stateSubscription?.dispose();
    this.panel?.dispose();
  }
}
