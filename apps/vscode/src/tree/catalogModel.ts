import type { CatalogComponent, CatalogList, SearchHit } from "../cli/blockbaseCli";
import { bucketHeading, bucketOf, categoryLabel, compareBuckets, placeEntry } from "./placement";

export const FAVORITES_ID = "favorites";

/** A block placed in the tree. `component.bucket`/`category` are the page's display placement. */
export interface BlockNode {
  kind: "block";
  id: string;
  component: CatalogComponent;
}

export interface GroupNode {
  kind: "collection" | "bucket" | "category";
  id: string;
  label: string;
  /**
   * Raw id the catalog page routes on: collection id, bucket id, or category id (not the node id).
   * A category target drops the bucket because the page's category view is bucket-independent.
   */
  targetId: string;
  children: CatalogNode[];
}

export interface MessageNode {
  kind: "message";
  id: string;
  label: string;
}

/** Every node the sidebar shows. Commands receive BlockNode (contextValue `block`). */
export type CatalogNode = BlockNode | GroupNode | MessageNode;

const byName = (a: CatalogComponent, b: CatalogComponent) => a.displayName.localeCompare(b.displayName);

/**
 * Builds the browse tree: Favorites first, then the other collections by title, then buckets
 * (brick, build, creation, AI, others, imported) with their categories, as on the catalog page.
 */
export function buildCatalogTree(list: CatalogList): CatalogNode[] {
  const placed = list.components.map(placeEntry);
  const bySlug = new Map(placed.map((component) => [component.slug, component]));

  const collections = [
    ...list.collections.filter((collection) => collection.id === FAVORITES_ID),
    ...list.collections.filter((collection) => collection.id !== FAVORITES_ID).sort((a, b) => a.title.localeCompare(b.title)),
  ].map<GroupNode>((collection) => ({
    kind: "collection",
    id: `collection:${collection.id}`,
    label: collection.title,
    targetId: collection.id,
    // Collections keep their own order; slugs that no longer resolve are skipped.
    children: collection.slugs
      .map((slug) => bySlug.get(slug))
      .filter((component): component is CatalogComponent => component !== undefined)
      .map((component) => blockNode(`collection:${collection.id}`, component)),
  }));

  const buckets = new Map<string, Map<string, CatalogComponent[]>>();
  for (const component of placed) {
    const categories = buckets.get(bucketOf(component)) ?? new Map<string, CatalogComponent[]>();
    buckets.set(bucketOf(component), categories);
    categories.set(component.category, [...(categories.get(component.category) ?? []), component]);
  }
  const bucketNodes = [...buckets.keys()].sort(compareBuckets).map<GroupNode>((bucket) => ({
    kind: "bucket",
    id: `bucket:${bucket}`,
    label: bucketHeading(bucket),
    targetId: bucket,
    children: [...buckets.get(bucket)!.entries()]
      .map(([category, components]) => ({ category, label: categoryLabel(category), components }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .map<GroupNode>(({ category, label, components }) => ({
        kind: "category",
        id: `category:${bucket}:${category}`,
        label,
        targetId: category,
        children: [...components].sort(byName).map((component) => blockNode(`category:${bucket}:${category}`, component)),
      })),
  }));

  return [...collections, ...bucketNodes];
}

/** Flat result list for a search, in the CLI's ranking order. */
export function buildSearchTree(query: string, hits: SearchHit[], list: CatalogList | undefined): CatalogNode[] {
  if (hits.length === 0) return [{ kind: "message", id: "search:empty", label: `No blocks match "${query}".` }];
  const byId = new Map((list?.components ?? []).map((component) => [component.componentId, placeEntry(component)]));
  return hits.map((hit) =>
    blockNode(
      "search",
      byId.get(hit.componentId) ?? {
        componentId: hit.componentId,
        namespace: hit.namespace,
        slug: hit.slug,
        displayName: hit.displayName,
        description: "",
        category: "",
        tags: [],
        bucket: null,
      },
    ),
  );
}

function blockNode(parentId: string, component: CatalogComponent): BlockNode {
  return { kind: "block", id: `${parentId}/${component.componentId}`, component };
}
