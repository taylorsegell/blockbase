/** Every contributed id lives here so package.json and code stay in sync (tested). */
export const VIEW_CONTAINER_ID = "blockbase";
export const CATALOG_VIEW_ID = "blockbase.catalog";
export const PANEL_VIEW_TYPE = "blockbase.catalogPanel";

export const COMMANDS = {
  refresh: "blockbase.refresh",
  /**
   * "Blockbase: Open Catalog". Optional argument `{ blockId }` or `{ collectionId }` deep-links
   * the reused panel; the sidebar tree calls this with its item's id.
   */
  openPanel: "blockbase.openPanel",
  search: "blockbase.search",
  clearSearch: "blockbase.clearSearch",
  installService: "blockbase.service.install",
  runForSession: "blockbase.service.runForSession",
  restartService: "blockbase.service.restart",
  copyHandoff: "blockbase.copyHandoff",
  addToProject: "blockbase.addToProject",
} as const;

/** `when`-clause context keys set by the extension. */
export const CONTEXT_KEYS = {
  cliMissing: "blockbase.cliMissing",
  searching: "blockbase.searching",
} as const;

export const CONFIG_SECTION = "blockbase";
/** Settings, relative to CONFIG_SECTION. */
export const SETTINGS = {
  port: "port",
} as const;

/** CLI binary the service commands run (argument arrays only, never a shell string). */
export const CLI_BIN = "blockbase";
