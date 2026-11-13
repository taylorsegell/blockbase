import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCatalog, fetchLibraryState, postCollection, postTags, type CollectionOp } from './api';
import type { CatalogEntry, Collection, Family, LibraryState } from './types';

export type { Collection, LibraryState };

const EMPTY: LibraryState = {
  tagsBySlug: {},
  collections: [{ id: 'favorites', title: 'Favorites', reserved: true, slugs: [] }],
  metadataVersion: 0,
};

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : 'Catalog request failed';
}

export function useLibrary() {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [families, setFamilies] = useState<Family[]>([]);
  const [state, setState] = useState<LibraryState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const tagQueues = useRef(new Map<string, Promise<boolean>>());

  const refresh = useCallback(async () => {
    try {
      const [catalog, next] = await Promise.all([fetchCatalog(), fetchLibraryState()]);
      setEntries(catalog.entries);
      setFamilies(catalog.families);
      setState(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setEntries((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const hot = import.meta.hot;
    if (!hot) return;
    const onChanged = () => void refresh();
    hot.on('blockbase:catalog-changed', onChanged);
    return () => hot.off?.('blockbase:catalog-changed', onChanged);
  }, [refresh]);

  const saveTags = useCallback(
    (componentId: string, tags: string[]) => {
      const queue = tagQueues.current;
      const previous = queue.get(componentId) ?? Promise.resolve(true);
      const next = previous
        .catch(() => false)
        .then(async () => {
          try {
            const saved = await postTags(componentId, tags);
            setState(saved);
            setEntries((current) =>
              current ? current.map((entry) => (entry.componentId === componentId ? { ...entry, tags: saved.tagsBySlug[componentId] ?? tags } : entry)) : current,
            );
            setError(null);
            return true;
          } catch (err) {
            setError(errorMessage(err));
            return false;
          }
        });
      queue.set(componentId, next);
      void next.finally(() => {
        if (queue.get(componentId) === next) queue.delete(componentId);
      });
      return next;
    },
    [],
  );

  const collectionOp = useCallback(async (op: CollectionOp) => {
    try {
      const collections = await postCollection(op);
      setState((current) => ({ ...current, collections }));
      setError(null);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }, []);

  return { entries, families, state, error, saveTags, collectionOp, refresh };
}
