import type { CatalogEntry } from '../library/types';

// Brick, build, creation, then AI. Anything else follows alphabetically, then
// blocks without a bucket (new imports) last.
export const BUCKET_ORDER = ['brick', 'build', 'creation', 'ai'] as const;
export const IMPORTED_BUCKET = 'imported';

// Default home for each category, by its role on a page: brick is a visual
// primitive, build is an interactive component, creation is a page section.
// One category lives in one bucket, so it never shows up twice. A category
// missing from this map keeps the bucket it was filed under.
const CATEGORY_BUCKET: Record<string, string> = {
  animation: 'brick',
  avatars: 'brick',
  backgrounds: 'brick',
  borders: 'brick',
  'charts-data-viz': 'brick',
  cursors: 'brick',
  icons: 'brick',
  maps: 'brick',
  'scroll-areas': 'brick',
  'scroll-reveal': 'brick',
  tags: 'brick',
  texts: 'brick',

  buttons: 'build',
  cards: 'build',
  carousels: 'build',
  docks: 'build',
  'file-trees': 'build',
  forms: 'build',
  inputs: 'build',
  lists: 'build',
  menus: 'build',
  progress: 'build',
  sidebars: 'build',
  tabs: 'build',
  toggles: 'build',
  videos: 'build',

  'calls-to-action': 'creation',
  clients: 'creation',
  contact: 'creation',
  dashboards: 'creation',
  'empty-states': 'creation',
  faqs: 'creation',
  features: 'creation',
  footers: 'creation',
  galleries: 'creation',
  heroes: 'creation',
  'pricing-sections': 'creation',
  sections: 'creation',
  'sign-ups': 'creation',
  'team-sections': 'creation',
  testimonials: 'creation',
  timelines: 'creation',
};

// AI chat blocks span every level, so they get their own bucket and the level
// they were filed under becomes the category.
const AI_CHAT_SECTION: Record<string, string> = {
  brick: 'ai-signals',
  build: 'ai-parts',
  creation: 'ai-screens',
};

/** Where a block sits in the catalog by default: its bucket and display category. */
export function placeEntry<T extends Pick<CatalogEntry, 'bucket' | 'category'>>(entry: T): T {
  if (entry.category === 'ai-chats') {
    return { ...entry, bucket: 'ai', category: AI_CHAT_SECTION[entry.bucket ?? ''] ?? 'ai-parts' };
  }
  const bucket = CATEGORY_BUCKET[entry.category];
  return bucket ? { ...entry, bucket } : entry;
}

export function bucketOf(entry: Pick<CatalogEntry, 'bucket'>): string {
  return entry.bucket ?? IMPORTED_BUCKET;
}

export function bucketRank(bucket: string) {
  if (bucket === IMPORTED_BUCKET) return Number.MAX_SAFE_INTEGER;
  const index = (BUCKET_ORDER as readonly string[]).indexOf(bucket);
  return index === -1 ? BUCKET_ORDER.length : index;
}

export function compareBuckets(a: string, b: string) {
  return bucketRank(a) - bucketRank(b) || a.localeCompare(b);
}

export function bucketHeading(bucket: string) {
  if (bucket === 'ai') return 'AI';
  return bucket.charAt(0).toUpperCase() + bucket.slice(1);
}

export function sectionKey(bucket: string, name: string) {
  return `${bucket}:${name}`;
}

export function bucketKey(bucket: string) {
  return `bucket:${bucket}`;
}
