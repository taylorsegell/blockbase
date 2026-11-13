import { Component, useEffect, useState, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { demos, loaders } from 'virtual:blockbase-catalog';
import type { CatalogEntry } from '../library/types';

type Loaded = { Block: ComponentType<any> } | { error: Error };

/** Plain function components, plus the objects `forwardRef`, `memo` and `lazy` return. */
function isComponent(value: unknown): value is ComponentType<any> {
  if (typeof value === 'function') return true;
  return typeof value === 'object' && value !== null && typeof (value as { $$typeof?: unknown }).$$typeof === 'symbol';
}

function pickExport(mod: Record<string, unknown>, displayName: string): ComponentType<any> | undefined {
  const named = mod[displayName];
  if (isComponent(named)) return named;
  if (isComponent(mod.default)) return mod.default;
  return Object.values(mod).find(isComponent);
}

function Failure({ error, entry }: { error: Error; entry: CatalogEntry }) {
  return (
    <div role="alert" className="max-w-xl rounded-md border border-rose-500/40 bg-rose-500/5 p-4 text-sm">
      <p className="font-medium text-rose-600 dark:text-rose-400">This block failed to render.</p>
      <p className="mt-2 break-words">{error.message}</p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[0.6875rem] text-muted-foreground">
        <dt>componentId</dt>
        <dd className="break-all">{entry.componentId}</dd>
        <dt>entry</dt>
        <dd className="break-all">{entry.entryPoint ?? 'none found'}</dd>
      </dl>
    </div>
  );
}

class Boundary extends Component<{ entry: CatalogEntry; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  componentDidUpdate(prev: { entry: CatalogEntry }) {
    if (prev.entry.componentId !== this.props.entry.componentId && this.state.error) this.setState({ error: null });
  }
  render() {
    return this.state.error ? <Failure error={this.state.error} entry={this.props.entry} /> : this.props.children;
  }
}

export function GenericBlock({ entry }: { entry: CatalogEntry }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    const demo = demos[entry.componentId];
    const load = demo ?? loaders[entry.componentId];
    if (!load) {
      setLoaded({ error: new Error(entry.entryPoint ? 'No loader is registered for this component yet; the page reloads when the catalog changes.' : 'No entry point could be determined for this component.') });
      // The virtual module is imported statically, so a component added after load needs a fresh page.
      const hot = import.meta.hot;
      const reload = () => window.location.reload();
      if (entry.entryPoint) hot?.on('blockbase:catalog-changed', reload);
      return () => {
        cancelled = true;
        hot?.off?.('blockbase:catalog-changed', reload);
      };
    }
    load().then(
      (mod) => {
        if (cancelled) return;
        const exports = mod as Record<string, unknown>;
        // A demo's default export already supplies the props, so it is rendered as-is.
        const Block = demo ? (isComponent(exports.default) ? exports.default : undefined) : pickExport(exports, entry.displayName);
        setLoaded(Block ? { Block } : { error: new Error(demo ? 'demo.tsx has no default export.' : 'The entry module exports no component.') });
      },
      (error) => {
        if (!cancelled) setLoaded({ error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entry.componentId, entry.displayName, entry.entryPoint]);

  if (!loaded) return <p className="text-sm text-muted-foreground">Loading block…</p>;
  if ('error' in loaded) return <Failure error={loaded.error} entry={entry} />;
  const { Block } = loaded;
  return (
    <Boundary entry={entry}>
      <Block />
    </Boundary>
  );
}
