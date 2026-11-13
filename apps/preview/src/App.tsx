import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronsDownUp,
  LayoutDashboard,
  Library,
  Moon,
  PanelLeft,
  PanelLeftClose,
  Search,
  Star,
  Sun,
} from 'lucide-react';
import blockbaseLogo from './blockbase-logo.svg';
import { useTheme } from '@/components/theme-provider';
import { ThemeSwitcher } from './components/ThemeSwitcher';
import { CatalogHome } from './components/CatalogHome';
import { CollectionsHome } from './components/CollectionsHome';
import { CollectionHome } from './components/CollectionHome';
import { CollectionTabs } from './components/CollectionTabs';
import { TagEditor } from './components/TagEditor';
import { BlockHandoff } from './components/BlockHandoff';
import {
  SidebarFolder,
  SidebarFooter,
  SidebarGroup,
  SidebarIdentity,
  SidebarItem,
  SidebarKbd,
  SidebarLeaf,
} from './components/SidebarNav';
import { categoryLabel, categoryMark } from './components/category-mark';
import { GenericBlock } from './render/GenericBlock';
import { useLibrary } from './library/useLibrary';
import { bucketHeading, bucketKey, bucketOf, compareBuckets, placeEntry, sectionKey } from './lib/buckets';
import type { CatalogEntry, Collection } from './library/types';
import './index.css';
import './styles/themes/index.css';

type PreviewView = 'catalog' | 'collections' | 'collection';

type PreviewRoute = {
  view: PreviewView;
  /** componentId (or a bare slug from an older link); resolved against the fetched catalog. */
  blockRef: string;
  collectionId: string;
  category: string;
  /** Home-page bucket (brick, build, ...) to focus; unknown ids fall back to all buckets. */
  bucket: string;
};

const NO_ROUTE = { blockRef: '', collectionId: '', category: '', bucket: '' };

// Does not need the catalog: block refs are resolved after the fetch.
function routeFromHash(): PreviewRoute {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw || raw === 'home') return { view: 'catalog', ...NO_ROUTE };
  if (raw === 'collections') return { view: 'collections', ...NO_ROUTE };
  if (raw.startsWith('collection/')) {
    return { view: 'collection', ...NO_ROUTE, collectionId: decodeURIComponent(raw.slice('collection/'.length)) };
  }
  if (raw.startsWith('category/')) {
    return { view: 'catalog', ...NO_ROUTE, category: decodeURIComponent(raw.slice('category/'.length)) };
  }
  if (raw.startsWith('bucket/')) {
    return { view: 'catalog', ...NO_ROUTE, bucket: decodeURIComponent(raw.slice('bucket/'.length)) };
  }
  if (raw.startsWith('block/')) {
    return { view: 'catalog', ...NO_ROUTE, blockRef: decodeURIComponent(raw.slice('block/'.length)) };
  }
  return { view: 'catalog', ...NO_ROUTE, blockRef: decodeURIComponent(raw) };
}

function goHome() {
  window.location.hash = 'home';
}

function openCatalog() {
  goHome();
}

function openCollections() {
  window.location.hash = 'collections';
}

function openBlock(componentId: string) {
  window.location.hash = `block/${encodeURIComponent(componentId)}`;
}

function openCategory(id: string) {
  window.location.hash = `category/${encodeURIComponent(id)}`;
}

function openBucket(id: string) {
  window.location.hash = `bucket/${encodeURIComponent(id)}`;
}

function openCollection(id: string) {
  window.location.hash = `collection/${encodeURIComponent(id)}`;
}

function slugifyCollectionId(title: string) {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'collection'
  );
}

function tabClass(selected: boolean) {
  return `h-7 rounded-[5px] px-2 text-[0.6875rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
    selected
      ? 'bg-background text-foreground shadow-sm'
      : 'text-muted-foreground hover:text-foreground'
  }`;
}

export function App() {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [route, setRoute] = useState(routeFromHash);
  // On phones the rail stacks above the stage; start it closed so the catalog leads.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia('(max-width: 767px)').matches,
  );
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({});
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [collectionDraft, setCollectionDraft] = useState('');
  const { mode, setMode } = useTheme();
  const dark = mode === 'dark';
  const { entries, state, error, saveTags, collectionOp } = useLibrary();
  const catalogBlocks = useMemo(() => (entries ?? []).map(placeEntry), [entries]);
  const loading = entries === null;
  const writable = !loading;
  const view = route.view;
  const active = useMemo(
    () =>
      route.blockRef
        ? catalogBlocks.find(
            (entry) => entry.componentId === route.blockRef || entry.slug === route.blockRef,
          )
        : undefined,
    [catalogBlocks, route.blockRef],
  );
  const atHome = view === 'catalog' && !active;
  const atCollections = view === 'collections';

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!active) return;
    setSectionOpen((open) => ({
      ...open,
      [bucketKey(bucketOf(active))]: true,
      [sectionKey(bucketOf(active), active.category)]: true,
    }));
  }, [active]);

  useEffect(() => {
    if (!route.bucket) return;
    setSectionOpen((open) => ({ ...open, [bucketKey(route.bucket)]: true }));
  }, [route.bucket]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }
      event.preventDefault();
      setSidebarOpen(true);
      window.requestAnimationFrame(() => searchRef.current?.focus());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalogBlocks;
    return catalogBlocks.filter((block) =>
      [block.slug, block.displayName, block.category, block.bucket ?? '', ...block.tags]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [catalogBlocks, query]);

  // Bucket first (brick, build, creation, others, imported), then category
  // alphabetically inside each bucket; sections are keyed `bucket:category`.
  const groupBlocks = useCallback((list: CatalogEntry[]) => {
    const groups = list.reduce<Record<string, CatalogEntry[]>>((acc, block) => {
      const key = sectionKey(bucketOf(block), block.category);
      (acc[key] ??= []).push(block);
      return acc;
    }, {});

    return Object.entries(groups)
      .map(([key, categoryBlocks]) => {
        const split = key.indexOf(':');
        const bucket = key.slice(0, split);
        const category = key.slice(split + 1);
        return {
          key,
          bucket,
          category,
          label: categoryLabel(category),
          blocks: [...categoryBlocks].sort((a, b) => a.displayName.localeCompare(b.displayName)),
        };
      })
      .sort((a, b) => compareBuckets(a.bucket, b.bucket) || a.label.localeCompare(b.label));
  }, []);
  const grouped = useMemo(() => groupBlocks(filtered), [filtered, groupBlocks]);
  const homeShelves = useMemo(() => groupBlocks(catalogBlocks), [catalogBlocks, groupBlocks]);
  const groupedBuckets = useMemo(
    () => [...new Set(grouped.map((group) => group.bucket))].sort(compareBuckets),
    [grouped],
  );
  const filtering = query.trim().length > 0;
  const anySectionOpen =
    groupedBuckets.some((bucket) => sectionOpen[bucketKey(bucket)] ?? true) ||
    grouped.some(({ key }) => sectionOpen[key] ?? filtering);
  const favorites = state.collections.find((collection) => collection.id === 'favorites');
  const starred = Boolean(active && favorites?.slugs.includes(active.slug));
  const starDisabled = !writable || !active;
  const sidebarCollections = useMemo(() => {
    const pinned = state.collections.filter((collection) => collection.id === 'favorites');
    const rest = state.collections
      .filter((collection) => collection.id !== 'favorites')
      .sort((a, b) => a.title.localeCompare(b.title));
    return [...pinned, ...rest];
  }, [state.collections]);
  const blockNames = useMemo(
    () => new Map(catalogBlocks.map((block) => [block.slug, block.displayName])),
    [catalogBlocks],
  );
  const activeCollection = state.collections.find(
    (collection) => collection.id === route.collectionId,
  );
  const collectionBlocks = useMemo(() => {
    if (!activeCollection) return [];
    return activeCollection.slugs.flatMap((item) => {
      const block = catalogBlocks.find((entry) => entry.slug === item);
      return block ? [block] : [];
    });
  }, [activeCollection, catalogBlocks]);
  const showCollectionsNav = view === 'collections' || view === 'collection';

  const isSectionOpen = (key: string) => sectionOpen[key] ?? filtering;

  const isBucketOpen = (bucket: string) =>
    filtering || (sectionOpen[bucketKey(bucket)] ?? true);

  const setSectionExpanded = (key: string, expanded: boolean) => {
    setSectionOpen((current) => ({ ...current, [key]: expanded }));
  };

  const collapseAll = () => {
    setSectionOpen({
      ...Object.fromEntries(groupedBuckets.map((bucket) => [bucketKey(bucket), false])),
      ...Object.fromEntries(grouped.map(({ key }) => [key, false])),
    });
  };

  const toggleFavorite = useCallback(async () => {
    if (!active || !favorites || !writable) return;
    await collectionOp({
      op: favorites.slugs.includes(active.slug) ? 'remove' : 'add',
      id: 'favorites',
      slug: active.slug,
    });
  }, [active, collectionOp, favorites, writable]);

  const moveCollectionSlug = useCallback(
    (itemSlug: string, direction: 'up' | 'down') => {
      if (!activeCollection || !writable) return;
      const visible = collectionBlocks.map((block) => block.slug);
      const at = visible.indexOf(itemSlug);
      const neighbor = visible[direction === 'up' ? at - 1 : at + 1];
      if (at < 0 || neighbor === undefined) return;
      void collectionOp({
        op: 'reorder',
        id: activeCollection.id,
        slug: itemSlug,
        index: activeCollection.slugs.indexOf(neighbor),
      });
    },
    [activeCollection, collectionBlocks, collectionOp, writable],
  );

  const removeCollectionSlug = useCallback(
    (itemSlug: string) => {
      if (!activeCollection || !writable) return;
      void collectionOp({ op: 'remove', id: activeCollection.id, slug: itemSlug });
    },
    [activeCollection, collectionOp, writable],
  );

  const startCreateCollection = useCallback(() => {
    setCreatingCollection(true);
    setCollectionDraft('');
  }, []);

  const cancelCreateCollection = useCallback(() => {
    setCreatingCollection(false);
    setCollectionDraft('');
  }, []);

  const createNamedCollection = useCallback(async () => {
    const title = collectionDraft.trim();
    if (!title || !writable) return;
    const id = slugifyCollectionId(title);
    const saved = await collectionOp({ op: 'create', id, title });
    if (saved) {
      setCreatingCollection(false);
      setCollectionDraft('');
      openCollection(id);
    }
  }, [collectionDraft, collectionOp, writable]);

  const changeCollectionMembership = useCallback(
    (value: string) => {
      if (!writable || !active) return;
      const [action, collectionId] = value.split(':');
      if ((action !== 'add' && action !== 'remove') || !collectionId) return;
      void collectionOp({ op: action, id: collectionId, slug: active.slug });
    },
    [active, collectionOp, writable],
  );

  const deleteNamedCollection = useCallback(async () => {
    if (!writable || !activeCollection || activeCollection.reserved) return;
    if (!window.confirm(`Delete ${activeCollection.title}?`)) return;
    const saved = await collectionOp({ op: 'delete', id: activeCollection.id });
    if (saved) openCatalog();
  }, [activeCollection, collectionOp, writable]);

  const workspaceHeader = (
    <header className="shrink-0 border-b bg-background px-4 py-3 sm:px-8">
      <div className="flex min-h-8 flex-wrap items-center gap-3">
        {!sidebarOpen && (
          <button
            type="button"
            onClick={goHome}
            aria-label="Blocks home"
            className="inline-flex items-center gap-2 rounded-sm px-1 text-[0.9375rem] leading-none font-semibold tracking-[-0.02em] hover:text-brand focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <img src={blockbaseLogo} alt="" className="size-7 shrink-0" />
            Blocks
          </button>
        )}
        <nav
          aria-label="Workspace"
          className="flex items-center gap-0.5 rounded-md border bg-muted/60 p-0.5"
        >
          <button
            type="button"
            aria-current={view === 'catalog' ? 'page' : undefined}
            className={tabClass(view === 'catalog')}
            onClick={openCatalog}
          >
            Catalog
          </button>
          <button
            type="button"
            aria-current={
              view === 'collections' || view === 'collection' ? 'page' : undefined
            }
            className={tabClass(view === 'collections' || view === 'collection')}
            onClick={openCollections}
          >
            Collections
          </button>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeSwitcher />
          <button
            type="button"
            onClick={() => setMode(dark ? 'light' : 'dark')}
            aria-label={`Switch to ${dark ? 'light' : 'dark'} appearance`}
            title={`Switch to ${dark ? 'light' : 'dark'} appearance`}
            className="inline-flex size-8 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          </button>
        </div>
      </div>
    </header>
  );

  return (
    <div className="preview-shell relative flex h-dvh overflow-hidden">
      <aside
        id="preview-catalog"
        hidden={!sidebarOpen}
        className={`preview-sidebar relative flex w-[17.5rem] shrink-0 flex-col ${
          sidebarOpen ? '' : 'hidden'
        }`}
      >
        <div className="px-3 pt-3">
          {sidebarOpen && (
            <SidebarIdentity
              markSrc={blockbaseLogo}
              title="Blocks"
              detail={loading ? 'Loading catalog…' : `${catalogBlocks.length} blocks · ${homeShelves.length} categories`}
              onClick={goHome}
            />
          )}
          {view === 'catalog' ? (
            <label className="sidebar-nav-row group mt-2 flex items-center gap-2.5 rounded-[6px] px-2.5 py-[7px] text-muted-foreground transition-colors focus-within:bg-foreground/5 focus-within:text-foreground hover:bg-foreground/5">
              <Search aria-hidden={true} strokeWidth={1.5} className="size-4 shrink-0 text-muted-foreground/80" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Filter blocks"
                placeholder="Filter blocks"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
              />
              <SidebarKbd>/</SidebarKbd>
            </label>
          ) : null}
          <div className="mt-0.5 flex flex-col gap-0.5">
            <SidebarItem
              icon={LayoutDashboard}
              title="Home"
              active={atHome && !route.category}
              onSelect={goHome}
            />
            <SidebarItem
              icon={Library}
              title="Collections"
              badge={state.collections.length}
              active={view === 'collections'}
              onSelect={openCollections}
            />
          </div>
        </div>
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4">
          {showCollectionsNav ? (
            <SidebarGroup heading="Collections">
              <CollectionTabs
                collections={sidebarCollections}
                activeId={view === 'collection' ? route.collectionId : 'all'}
                includeAll={view === 'collection'}
                writable={writable}
                creating={false}
                draft={collectionDraft}
                onDraftChange={setCollectionDraft}
                onSelectAll={openCollections}
                onSelect={openCollection}
                onStartCreate={startCreateCollection}
                onCancelCreate={cancelCreateCollection}
                onSubmitCreate={() => void createNamedCollection()}
                showCreate={false}
              />
            </SidebarGroup>
          ) : loading ? null : filtered.length === 0 ? (
            <p className="px-2.5 py-6 text-[13px] text-muted-foreground">No blocks match that filter.</p>
          ) : (
            <nav aria-label="Block catalog" className="flex flex-col gap-4">
              {groupedBuckets.map((bucket) => {
                const sections = grouped.filter((group) => group.bucket === bucket);
                const bucketCount = sections.reduce((sum, group) => sum + group.blocks.length, 0);

                return (
                  <SidebarGroup
                    key={bucketKey(bucket)}
                    heading={bucketHeading(bucket)}
                    count={bucketCount}
                    expanded={isBucketOpen(bucket)}
                    onExpandedChange={(expanded) => setSectionExpanded(bucketKey(bucket), expanded)}
                  >
                    {sections.map(({ key, category, label, blocks: categoryBlocks }) => (
                      <SidebarFolder
                        key={key}
                        icon={categoryMark(category)}
                        title={label}
                        badge={categoryBlocks.length}
                        expanded={isSectionOpen(key)}
                        onExpandedChange={(expanded) => setSectionExpanded(key, expanded)}
                      >
                        {categoryBlocks.map((block) => (
                          <SidebarLeaf
                            key={block.componentId}
                            title={block.displayName}
                            active={active?.componentId === block.componentId}
                            onSelect={() => openBlock(block.componentId)}
                          />
                        ))}
                      </SidebarFolder>
                    ))}
                  </SidebarGroup>
                );
              })}
            </nav>
          )}
        </div>
        <SidebarFooter>
          {view === 'catalog' ? (
            <SidebarItem
              icon={ChevronsDownUp}
              title="Collapse all"
              disabled={!anySectionOpen}
              onSelect={collapseAll}
            />
          ) : null}
          <SidebarItem icon={PanelLeftClose} title="Hide sidebar" onSelect={() => setSidebarOpen(false)} />
        </SidebarFooter>
      </aside>
      {sidebarOpen ? null : (
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          aria-controls="preview-catalog"
          aria-expanded="false"
          aria-label="Show catalog sidebar"
          title="Show sidebar"
          className="preview-sidebar-toggle is-closed inline-flex size-8 items-center justify-center rounded-full border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <PanelLeft className="size-3.5" />
        </button>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {error ? (
          <p className="border-b px-8 py-2 text-xs text-rose-600 sm:px-10 dark:text-rose-400">
            {error}
          </p>
        ) : null}
        {loading ? (
          <>
            {workspaceHeader}
            <p className="px-8 py-10 text-sm text-muted-foreground sm:px-10">Loading catalog…</p>
          </>
        ) : atHome ? (
          <>
            {workspaceHeader}
            <div className="min-h-0 flex-1 overflow-auto bg-background">
              <CatalogHome
                total={catalogBlocks.length}
                shelves={homeShelves}
                categoryId={route.category}
                bucketId={route.bucket}
                onOpen={openBlock}
                onOpenCategory={openCategory}
                onBack={openCatalog}
                onOpenBucket={openBucket}
                onShowAll={goHome}
              />
            </div>
          </>
        ) : atCollections ? (
          <>
            {workspaceHeader}
            <div className="min-h-0 flex-1 overflow-auto bg-background">
              <CollectionsHome
                collections={sidebarCollections}
                blockNames={blockNames}
                writable={writable}
                creating={creatingCollection}
                draft={collectionDraft}
                onDraftChange={setCollectionDraft}
                onStartCreate={startCreateCollection}
                onCancelCreate={cancelCreateCollection}
                onSubmitCreate={() => void createNamedCollection()}
                onOpen={openCollection}
              />
            </div>
          </>
        ) : active ? (
          <>
            {workspaceHeader}
            <header className="shrink-0 border-b bg-background px-8 py-6 sm:px-10">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-xl leading-none font-semibold tracking-[-0.02em]">
                      {active.displayName}
                    </h2>
                    <p className="mt-2 truncate text-sm text-muted-foreground">
                      {categoryLabel(active.category)}
                      {active.bucket ? ` · ${active.bucket}` : ''}
                    </p>
                    <div className="mt-3">
                      <BlockHandoff block={active} />
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void toggleFavorite()}
                    disabled={starDisabled}
                    aria-pressed={starred}
                    aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
                    className="inline-flex size-8 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Star className={`size-3.5 ${starred ? 'fill-current' : ''}`} />
                  </button>
                  <select
                    aria-label="Collections"
                    value=""
                    disabled={!writable}
                    onChange={(event) => {
                      changeCollectionMembership(event.target.value);
                      event.target.value = '';
                    }}
                    className="h-8 max-w-[11rem] rounded-md border bg-background px-2 text-[0.6875rem] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus:border-ring focus:ring-1 focus:ring-ring disabled:pointer-events-none disabled:opacity-40"
                  >
                    <option value="" disabled>
                      Manage collections…
                    </option>
                    {state.collections.map((collection) => {
                      const member = collection.slugs.includes(active.slug);
                      return (
                        <option
                          key={collection.id}
                          value={`${member ? 'remove' : 'add'}:${collection.id}`}
                        >
                          {member
                            ? `Remove from ${collection.title}`
                            : `Add to ${collection.title}`}
                        </option>
                      );
                    })}
                  </select>
                  <span
                    className="inline-flex size-8 min-w-fit min-h-8 items-center justify-center rounded-md border px-2 font-mono text-[0.6875rem] text-muted-foreground"
                    style={{ boxSizing: 'border-box' }}
                  >
                    {active.namespace}
                  </span>
                </div>
              </div>
              <TagEditor
                tags={active.tags}
                disabled={!writable}
                onFilterTag={(tag) => setQuery(tag)}
                onChange={(tags) => {
                  void saveTags(active.componentId, tags);
                }}
              />
            </header>
            <div className="preview-canvas min-h-0 flex-1 overflow-auto">
              <div className="preview-stage flex min-h-full px-4 py-8 sm:px-8 sm:py-10">
                <div className="preview-frame">
                  <GenericBlock entry={active} />
                </div>
              </div>
            </div>
          </>
        ) : view === 'collection' ? (
          <>
            {workspaceHeader}
            <div className="min-h-0 flex-1 overflow-auto bg-background">
              {activeCollection ? (
                <CollectionHome
                  collection={activeCollection}
                  blocks={collectionBlocks}
                  writable={writable}
                  onOpen={openBlock}
                  onMove={moveCollectionSlug}
                  onRemoveSlug={removeCollectionSlug}
                  onDelete={deleteNamedCollection}
                />
              ) : (
                <div className="catalog-home min-h-full bg-background px-8 pb-16 pt-6 sm:px-10">
                  <p className="text-xl font-semibold tracking-[-0.02em]">
                    Collection not found
                  </p>
                  <button
                    type="button"
                    onClick={goHome}
                    className="mt-6 inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-accent"
                  >
                    Back to catalog
                  </button>
                </div>
              )}
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
