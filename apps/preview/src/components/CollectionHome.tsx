import {
  ChevronDown,
  ChevronUp,
  Star,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { Collection } from '../library/types';
import type { CatalogEntry as BlockEntry } from '../library/types';
import { BlockHandoff } from './BlockHandoff';
import { categoryLabel } from './category-mark';
import { HairlineGrid } from './HairlineGrid';

type CollectionHomeProps = {
  collection: Collection;
  blocks: BlockEntry[];
  writable: boolean;
  onOpen: (slug: string) => void;
  onMove: (slug: string, direction: 'up' | 'down') => void;
  onRemoveSlug: (slug: string) => void;
  onDelete?: () => void;
  tabs?: ReactNode;
};

export function CollectionHome({
  collection,
  blocks,
  writable,
  onOpen,
  onMove,
  onRemoveSlug,
  onDelete,
  tabs,
}: CollectionHomeProps) {
  return (
    <div className="catalog-home min-h-full bg-background px-8 pb-16 pt-6 sm:px-10">
      {tabs ? <div className="mb-8">{tabs}</div> : null}
      <div className="catalog-home-mast flex flex-wrap items-end gap-3">
        <p className="catalog-home-total kit-mast-total tabular-nums">{blocks.length}</p>
        <p className="catalog-home-unit text-muted-foreground">{collection.title}</p>
        {writable && !collection.reserved && onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            className="mb-0.5 ml-auto inline-flex h-8 items-center rounded-md border px-3 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Delete collection
          </button>
        ) : null}
      </div>

      {blocks.length === 0 ? (
        <div className="kit-empty">
          <Star className="kit-empty-mark" strokeWidth={1.25} aria-hidden="true" />
          <p className="kit-empty-copy">
            {collection.id === 'favorites'
              ? 'Star a block from its preview. It lands here as a shortlist you can open without hunting the tree.'
              : 'Open a block, then add it from the collection menu in the preview header. This kit stays empty until you do.'}
          </p>
        </div>
      ) : (
        <HairlineGrid
          className="catalog-grid"
          tiles={blocks.map((block, index) => ({
            key: block.componentId,
            meta: categoryLabel(block.category),
            title: block.displayName,
            description: block.tags.length
              ? block.tags.slice(0, 3).join(', ') + (block.tags.length > 3 ? ` +${block.tags.length - 3}` : '')
              : '',
            label: `Open ${block.displayName}`,
            onOpen: () => onOpen(block.componentId),
            tools: (
              <>
                <BlockHandoff compact block={block} />
                {writable ? (
                  <>
                    <button
                      type="button"
                      aria-label={`Move ${block.displayName} up`}
                      disabled={index === 0}
                      onClick={() => onMove(block.slug, 'up')}
                      className="hairline-tool"
                    >
                      <ChevronUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${block.displayName} down`}
                      disabled={index === blocks.length - 1}
                      onClick={() => onMove(block.slug, 'down')}
                      className="hairline-tool"
                    >
                      <ChevronDown className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${block.displayName} from ${collection.title}`}
                      onClick={() => onRemoveSlug(block.slug)}
                      className="hairline-tool"
                    >
                      <X className="size-3.5" />
                    </button>
                  </>
                ) : null}
              </>
            ),
          }))}
        />
      )}
    </div>
  );
}
