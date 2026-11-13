import { useEffect, useRef } from 'react';
import type { Collection } from '../library/types';

type CollectionTabsProps = {
  collections: Collection[];
  activeId: string | 'all';
  includeAll?: boolean;
  writable: boolean;
  creating: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSelectAll?: () => void;
  onSelect: (id: string) => void;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onSubmitCreate: () => void;
  showCreate?: boolean;
};

function chipClass(selected: boolean) {
  return `h-7 shrink-0 rounded-[5px] px-2 text-[0.6875rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
    selected
      ? 'bg-background text-foreground shadow-sm'
      : 'text-muted-foreground hover:text-foreground'
  }`;
}

export function CollectionTabs({
  collections,
  activeId,
  includeAll = false,
  writable,
  creating,
  draft,
  onDraftChange,
  onSelectAll,
  onSelect,
  onStartCreate,
  onCancelCreate,
  onSubmitCreate,
  showCreate = true,
}: CollectionTabsProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!creating) return;
    inputRef.current?.focus();
  }, [creating]);

  return (
    <div
      role="tablist"
      aria-label="Collections"
      className="collection-tabs"
    >
      {includeAll && onSelectAll ? (
        <button
          type="button"
          role="tab"
          aria-selected={activeId === 'all'}
          className={chipClass(activeId === 'all')}
          onClick={onSelectAll}
        >
          All
        </button>
      ) : null}
      {collections.map((collection) => {
        const selected = activeId === collection.id;
        return (
          <button
            key={collection.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={chipClass(selected)}
            onClick={() => onSelect(collection.id)}
          >
            <span className="truncate">{collection.title}</span>
            <span className="ml-1.5 tabular-nums text-[0.625rem] text-muted-foreground">
              {collection.slugs.length}
            </span>
          </button>
        );
      })}
      {showCreate && creating ? (
        <form
          className="collection-tabs-create"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitCreate();
          }}
        >
          <input
            ref={inputRef}
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
            className="collection-tabs-input"
          />
          <button type="submit" className={chipClass(false)}>
            Add
          </button>
          <button type="button" className={chipClass(false)} onClick={onCancelCreate}>
            Cancel
          </button>
        </form>
      ) : showCreate ? (
        <button
          type="button"
          onClick={onStartCreate}
          className={chipClass(false)}
        >
          + New
        </button>
      ) : null}
      {!writable ? (
        <span className="collection-tabs-hint">
          Writes need the Vite dev server
        </span>
      ) : null}
    </div>
  );
}
