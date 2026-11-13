import type { CatalogPayload, Collection, LibraryState } from './types';

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || res.statusText);
  return body as T;
}

function post(path: string, body: unknown) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function fetchCatalog(): Promise<CatalogPayload> {
  return parse<CatalogPayload>(await fetch('/api/catalog'));
}

export async function fetchLibraryState(): Promise<LibraryState> {
  return parse<LibraryState>(await fetch('/api/state'));
}

export async function postTags(componentId: string, tags: string[]): Promise<LibraryState> {
  return parse<LibraryState>(await post('/api/tags', { componentId, tags }));
}

export type CollectionOp =
  | { op: 'create'; id: string; title: string }
  | { op: 'add' | 'remove'; id: string; slug: string }
  | { op: 'reorder'; id: string; slug: string; index: number }
  | { op: 'delete'; id: string };

export async function postCollection(op: CollectionOp): Promise<Collection[]> {
  const body = await parse<{ collections: Collection[] }>(await post('/api/collections', op));
  return body.collections;
}
