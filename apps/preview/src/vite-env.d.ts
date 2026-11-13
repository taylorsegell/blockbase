/// <reference types="vite/client" />

declare module 'virtual:blockbase-catalog' {
  import type { CatalogEntry } from './library/types';
  export const loaders: Record<string, () => Promise<any>>;
  /** Preview demos (`demo.tsx` beside component.json); the default export renders the block with sample props. */
  export const demos: Record<string, () => Promise<any>>;
  export const entries: CatalogEntry[];
}
