/**
 * Bucket placement and labels, mirrored from apps/preview (src/lib/buckets.ts and
 * src/components/category-mark.ts) so the sidebar groups blocks exactly like the catalog page.
 * Keep the two in step; a test pins the cases that matter.
 */
export const BUCKET_ORDER = ["brick", "build", "creation", "ai"] as const;
export const IMPORTED_BUCKET = "imported";

const CATEGORY_BUCKET: Record<string, string> = {
  animation: "brick", avatars: "brick", backgrounds: "brick", borders: "brick", "charts-data-viz": "brick",
  cursors: "brick", icons: "brick", maps: "brick", "scroll-areas": "brick", "scroll-reveal": "brick",
  tags: "brick", texts: "brick",

  buttons: "build", cards: "build", carousels: "build", docks: "build", "file-trees": "build", forms: "build",
  inputs: "build", lists: "build", menus: "build", progress: "build", sidebars: "build", tabs: "build",
  toggles: "build", videos: "build",

  "calls-to-action": "creation", clients: "creation", contact: "creation", dashboards: "creation",
  "empty-states": "creation", faqs: "creation", features: "creation", footers: "creation", galleries: "creation",
  heroes: "creation", "pricing-sections": "creation", sections: "creation", "sign-ups": "creation",
  "team-sections": "creation", testimonials: "creation", timelines: "creation",
};

const AI_CHAT_SECTION: Record<string, string> = { brick: "ai-signals", build: "ai-parts", creation: "ai-screens" };

const CATEGORY_LABEL: Record<string, string> = { "ai-signals": "Signals", "ai-parts": "Chat Parts", "ai-screens": "Chat Screens" };

/** Where a block sits by default: its bucket and display category. */
export function placeEntry<T extends { bucket: string | null; category: string }>(entry: T): T {
  if (entry.category === "ai-chats") {
    return { ...entry, bucket: "ai", category: AI_CHAT_SECTION[entry.bucket ?? ""] ?? "ai-parts" };
  }
  const bucket = CATEGORY_BUCKET[entry.category];
  return bucket ? { ...entry, bucket } : entry;
}

export function bucketOf(entry: { bucket: string | null }): string {
  return entry.bucket ?? IMPORTED_BUCKET;
}

function bucketRank(bucket: string): number {
  if (bucket === IMPORTED_BUCKET) return Number.MAX_SAFE_INTEGER;
  const index = (BUCKET_ORDER as readonly string[]).indexOf(bucket);
  return index === -1 ? BUCKET_ORDER.length : index;
}

export function compareBuckets(a: string, b: string): number {
  return bucketRank(a) - bucketRank(b) || a.localeCompare(b);
}

export function bucketHeading(bucket: string): string {
  if (bucket === "ai") return "AI";
  return bucket.charAt(0).toUpperCase() + bucket.slice(1);
}

export function categoryLabel(name: string): string {
  if (CATEGORY_LABEL[name]) return CATEGORY_LABEL[name];
  return name
    .split("-")
    .map((word) => (word === "ai" ? "AI" : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}
