export type CatalogEntry = {
  componentId: string;
  namespace: string;
  slug: string;
  displayName: string;
  category: string;
  tags: string[];
  bucket: string | null;
  entryPoint: string | null;
  revisionId: string;
  hasDemo: boolean;
};

export type Collection = {
  id: string;
  title: string;
  reserved: boolean;
  slugs: string[];
};

export type Family = { slug: string; name: string };

export type CatalogPayload = { entries: CatalogEntry[]; families: Family[] };

export type LibraryState = {
  tagsBySlug: Record<string, string[]>;
  collections: Collection[];
  metadataVersion: number;
};
