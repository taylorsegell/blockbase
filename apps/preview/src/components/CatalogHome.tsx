import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Layers, Tag, ToyBrick } from 'lucide-react';
import { HairlineGrid, type HairlineTile } from './HairlineGrid';
import { FilterBar, type Filter, type FilterFieldDef } from './chrome/FilterBar';
import type { CatalogEntry as BlockEntry } from '../library/types';
import { categoryLabel } from './category-mark';
import { bucketHeading, compareBuckets } from '../lib/buckets';

type Shelf = {
  bucket: string;
  category: string;
  label: string;
  blocks: BlockEntry[];
};

type CatalogHomeProps = {
  total: number;
  shelves: Shelf[];
  categoryId: string;
  /** Bucket to focus on landing (`#bucket/<id>`); unknown ids show every bucket. */
  bucketId?: string;
  onOpen: (componentId: string) => void;
  onOpenCategory: (id: string) => void;
  onBack: () => void;
  onOpenBucket: (id: string) => void;
  onShowAll: () => void;
};

function tokenMatch(operator: string, selected: string[], candidate: string) {
  const hit = selected.includes(candidate);
  if (operator === 'is_not' || operator === 'is_none') return !hit;
  return hit;
}

function blockMatches(block: BlockEntry, filters: Filter[]) {
  for (const filter of filters) {
    if (!filter.values.length) continue;
    if (filter.field === 'component') {
      if (!tokenMatch(filter.operator, filter.values, block.componentId)) return false;
    }
    if (filter.field === 'tag') {
      const any = filter.values.some((value) => block.tags.includes(value));
      if (filter.operator === 'is_not' || filter.operator === 'is_none') {
        if (any) return false;
      } else if (!any) {
        return false;
      }
    }
    if (filter.field === 'bucket') {
      if (!tokenMatch(filter.operator, filter.values, block.bucket ?? '')) return false;
    }
  }
  return true;
}

function bucketLabel(bucket: string | null) {
  return bucket ? bucketHeading(bucket) : '';
}

function plural(count: number, noun: string, many = `${noun}s`) {
  return `${count} ${count === 1 ? noun : many}`;
}

function namePreview(names: string[], limit = 3) {
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown} +${names.length - limit}` : shown;
}

function shelfTile(shelf: Shelf, onOpen: () => void): HairlineTile {
  const names = shelf.blocks.map((block) => block.displayName).sort((a, b) => a.localeCompare(b));

  return {
    key: `${shelf.bucket}:${shelf.category}`,
    meta: plural(shelf.blocks.length, 'block'),
    title: shelf.label,
    description: namePreview(names),
    label: `${shelf.label}, ${plural(shelf.blocks.length, 'block')}`,
    onOpen,
  };
}

function blockTile(block: BlockEntry, onOpen: () => void): HairlineTile {
  return {
    key: block.componentId,
    meta: bucketLabel(block.bucket) || block.namespace,
    title: block.displayName,
    description: block.tags.length ? namePreview(block.tags) : categoryLabel(block.category),
    label: `Open ${block.displayName}`,
    onOpen,
  };
}

export function CatalogHome({
  total,
  shelves,
  categoryId,
  bucketId,
  onOpen,
  onOpenCategory,
  onBack,
  onOpenBucket,
  onShowAll,
}: CatalogHomeProps) {
  const [filters, setFilters] = useState<Filter[]>([]);
  const active = useMemo(() => {
    if (!categoryId) return undefined;
    const matches = shelves.filter((shelf) => shelf.category === categoryId);
    if (!matches.length) return undefined;
    const seen = new Set<string>();
    const blocks = matches.flatMap((shelf) => shelf.blocks).filter((block) => {
      if (seen.has(block.componentId)) return false;
      seen.add(block.componentId);
      return true;
    });
    return {
      category: categoryId,
      label: matches[0].label,
      blocks,
    };
  }, [categoryId, shelves]);
  const inCategory = Boolean(categoryId);

  useEffect(() => {
    setFilters([]);
  }, [categoryId]);

  // Only the category view has a filter bar; home filters by bucket chips.
  const fields = useMemo<FilterFieldDef[]>(() => {
    if (!active) return [];
    const isAny = [
      { value: 'is', label: 'is' },
      { value: 'is_not', label: 'is not' },
      { value: 'is_any', label: 'is any of', multi: true },
    ];
    const buckets = [
      ...new Map(
        shelves.flatMap((shelf) =>
          shelf.blocks.flatMap((block) => (block.bucket ? [[block.bucket, bucketLabel(block.bucket)] as const] : [])),
        ),
      ),
    ].sort((a, b) => a[1].localeCompare(b[1]));

    const tags = [...new Set(active.blocks.flatMap((block) => block.tags))].sort();
    return [
      {
        id: 'component',
        label: 'Component',
        icon: <ToyBrick className="size-3.5" />,
        operators: isAny,
        loadOptions: async (query) => {
          const q = query.trim().toLowerCase();
          return active.blocks
            .map((block) => ({ value: block.componentId, label: block.displayName }))
            .filter((option) => !q || option.label.toLowerCase().includes(q));
        },
      },
      {
        id: 'tag',
        label: 'Tag',
        icon: <Tag className="size-3.5" />,
        operators: [
          { value: 'is_any', label: 'is any of', multi: true },
          { value: 'is_none', label: 'is none of', multi: true },
        ],
        options: tags.map((tag) => ({ value: tag, label: tag })),
      },
      ...(buckets.length
        ? [
            {
              id: 'bucket',
              label: 'Bucket',
              icon: <Layers className="size-3.5" />,
              operators: isAny,
              options: buckets.map(([value, label]) => ({ value, label })),
            },
          ]
        : []),
    ];
  }, [active, shelves]);

  const bucketGroups = useMemo(() => {
    const sorted = [...shelves].sort((a, b) => a.label.localeCompare(b.label));
    return [...new Set(sorted.map((shelf) => shelf.bucket))].sort(compareBuckets).map((id) => {
      const items = sorted.filter((shelf) => shelf.bucket === id);
      const blockCount = items.reduce((sum, shelf) => sum + shelf.blocks.length, 0);
      return { id, label: bucketHeading(id), items, blockCount };
    });
  }, [shelves]);

  const bucketKnown = Boolean(bucketId) && bucketGroups.some((group) => group.id === bucketId);

  // The hash is the source of truth: `#bucket/<id>` focuses a known bucket, `#home` shows all.
  const bucket = bucketKnown ? bucketId! : null;

  // Back to the page top (the chip bar is not sticky) once the filtered render has committed.
  useEffect(() => {
    if (bucket && bucket === bucketId) document.querySelector('.catalog-home')?.scrollIntoView({ block: 'start' });
  }, [bucket, bucketId]);

  const shownGroups = bucket
    ? bucketGroups.filter((group) => group.id === bucket)
    : bucketGroups;

  const visibleBlocks = useMemo(() => {
    if (!active) return [];
    return active.blocks
      .filter((block) => blockMatches(block, filters))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [active, filters]);

  return (
    <div className="catalog-home min-h-full bg-background px-8 pb-16 pt-6 sm:px-10">
      {inCategory ? (
        <button type="button" onClick={onBack} className="gallery-back">
          <ArrowLeft className="size-3.5" />
          All categories
        </button>
      ) : null}

      <h1 className="catalog-home-mast flex items-end gap-3">
        <span
          className={`catalog-home-total tabular-nums ${
            inCategory ? 'kit-mast-total' : 'text-foreground'
          }`}
        >
          {inCategory ? (active?.blocks.length ?? 0) : total}
        </span>{' '}
        <span className="catalog-home-unit text-muted-foreground">
          {inCategory ? (active?.label ?? 'Category') : 'blocks'}
        </span>
      </h1>

      {inCategory ? (
        <div className="catalog-filter-bar">
          <FilterBar
            fields={fields}
            value={filters}
            onChange={setFilters}
            aria-label="Component filters"
          />
        </div>
      ) : null}

      {inCategory && !active ? (
        <p className="gallery-empty">No category matches that filter.</p>
      ) : inCategory ? (
        visibleBlocks.length === 0 ? (
          <p className="gallery-empty">No components match that filter.</p>
        ) : (
          <HairlineGrid
            className="catalog-grid"
            tiles={visibleBlocks.map((block) => blockTile(block, () => onOpen(block.componentId)))}
          />
        )
      ) : bucketGroups.length === 0 ? (
        <p className="gallery-empty">No categories yet.</p>
      ) : (
        <>
          {bucketGroups.length > 1 ? (
            <div className="bucket-jump" role="group" aria-label="Show bucket">
              {[{ id: null as string | null, label: 'All', blockCount: total }, ...bucketGroups].map(
                ({ id, label, blockCount }) => (
                  <button
                    key={id ?? 'all'}
                    type="button"
                    className="bucket-jump-link"
                    aria-pressed={bucket === id}
                    onClick={() => (id ? onOpenBucket(id) : onShowAll())}
                  >
                    {label}
                    <span className="bucket-jump-count tabular-nums">{blockCount}</span>
                  </button>
                ),
              )}
            </div>
          ) : null}
          {shownGroups.map(({ id, label, items, blockCount }) => (
            <section
              key={id}
              className="bucket-section"
              aria-labelledby={`bucket-${id}-heading`}
            >
              <header className="bucket-head">
                <h2 id={`bucket-${id}-heading`} className="bucket-title">
                  {label}
                </h2>
                <p className="bucket-meta tabular-nums">
                  <span className="bucket-count">{blockCount}</span>
                  {' '}
                  {blockCount === 1 ? 'block' : 'blocks'} in {plural(items.length, 'category', 'categories')}
                </p>
              </header>
              <HairlineGrid
                className="catalog-grid"
                tiles={items.map((shelf) => shelfTile(shelf, () => onOpenCategory(shelf.category)))}
              />
            </section>
          ))}
        </>
      )}
    </div>
  );
}
