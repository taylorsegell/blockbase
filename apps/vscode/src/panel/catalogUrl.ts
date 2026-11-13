/** Where in the catalog page to land. The page routes by URL hash (see apps/preview App.tsx). */
export type CatalogTarget = { blockId: string } | { collectionId: string } | { categoryId: string } | { bucketId: string };

export type IdeTheme = "light" | "dark";

/** Hash the catalog page understands: `#home`, `#block/<id>`, `#collection/<id>`, `#category/<id>`, `#bucket/<id>`. */
export function catalogHash(target: CatalogTarget | undefined): string {
  if (!target) return "home";
  if ("blockId" in target) return `block/${encodeURIComponent(target.blockId)}`;
  if ("collectionId" in target) return `collection/${encodeURIComponent(target.collectionId)}`;
  if ("categoryId" in target) return `category/${encodeURIComponent(target.categoryId)}`;
  return `bucket/${encodeURIComponent(target.bucketId)}`;
}

/** Validate a command argument. Anything that is not a block, collection, category or bucket target means "home". */
export function parseCatalogTarget(value: unknown): CatalogTarget | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.blockId === "string" && record.blockId) return { blockId: record.blockId };
  if (typeof record.collectionId === "string" && record.collectionId) return { collectionId: record.collectionId };
  if (typeof record.categoryId === "string" && record.categoryId) return { categoryId: record.categoryId };
  if (typeof record.bucketId === "string" && record.bucketId) return { bucketId: record.bucketId };
  return undefined;
}

export function catalogOrigin(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Blockbase port: ${port}`);
  }
  // The service binds IPv4 only; `localhost` can resolve to ::1.
  return `http://127.0.0.1:${port}`;
}

/**
 * Page URL. `embedded=1` and `theme` are hints for the catalog page; it ignores them today
 * (embedded mode and theme pass-through are follow-ups in apps/preview). `host=vscode` tells the
 * page it can hand a copy request to the editor. Only the hash changes
 * between navigations, so moving to another block is a same-document hash change.
 */
export function buildCatalogUrl(options: { port: number; theme: IdeTheme; target?: CatalogTarget }): string {
  return `${catalogOrigin(options.port)}/?embedded=1&host=vscode&theme=${options.theme}#${catalogHash(options.target)}`;
}
