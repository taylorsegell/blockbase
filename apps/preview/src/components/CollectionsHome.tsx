import { Plus } from 'lucide-react';
import type { Collection } from '../library/types';
import { HairlineGrid } from './HairlineGrid';

type CollectionsHomeProps = {
  collections: Collection[];
  /** displayName by slug, for each collection's preview line. */
  blockNames: Map<string, string>;
  writable: boolean;
  creating: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onSubmitCreate: () => void;
  onOpen: (id: string) => void;
};

function namePreview(names: string[], limit = 3) {
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown} +${names.length - limit}` : shown;
}

export function CollectionsHome({
  collections,
  blockNames,
  writable,
  creating,
  draft,
  onDraftChange,
  onStartCreate,
  onCancelCreate,
  onSubmitCreate,
  onOpen,
}: CollectionsHomeProps) {
  return (
    <div className="catalog-home min-h-full bg-background px-8 pb-16 pt-6 sm:px-10">
      <div className="catalog-home-mast flex flex-wrap items-end gap-3">
        <h1 className="flex items-end gap-3">
          <span className="catalog-home-total tabular-nums text-foreground">{collections.length}</span>{' '}
          <span className="catalog-home-unit text-muted-foreground">
            {collections.length === 1 ? 'collection' : 'collections'}
          </span>
        </h1>
        {writable ? (
          <button
            type="button"
            onClick={onStartCreate}
            disabled={creating}
            className="mb-0.5 ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <Plus className="size-3.5" />
            New collection
          </button>
        ) : null}
      </div>

      {creating ? (
        <form
          className="collections-home-create"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitCreate();
          }}
        >
          <label
            htmlFor="new-collection-name"
            className="text-[0.6875rem] font-semibold tracking-[0.16em] text-muted-foreground uppercase"
          >
            New collection
          </label>
          <div className="mt-2 flex max-w-md items-center gap-2">
            <input
              id="new-collection-name"
              autoFocus
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onCancelCreate();
                }
              }}
              aria-label="New collection name"
              placeholder="Name"
              className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-1 focus:ring-ring"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              className="inline-flex h-9 items-center rounded-md border px-3 text-[0.6875rem] font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
            >
              Add
            </button>
            <button
              type="button"
              onClick={onCancelCreate}
              className="inline-flex h-9 items-center rounded-md border px-3 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <HairlineGrid
        className="catalog-grid"
        tiles={collections.map((collection) => {
          const count = collection.slugs.length;
          const names = collection.slugs.flatMap((slug) => blockNames.get(slug) ?? []);
          return {
            key: collection.id,
            meta: `${count} ${count === 1 ? 'block' : 'blocks'}`,
            title: collection.title,
            description: names.length ? namePreview(names) : 'Nothing saved yet',
            label: `${collection.title}, ${count} ${count === 1 ? 'block' : 'blocks'}`,
            onOpen: () => onOpen(collection.id),
          };
        })}
      />
    </div>
  );
}
