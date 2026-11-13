import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONTRACT_VERSION, parseComponentManifest, type ComponentManifest, type ProjectProfile } from '@blockbase/contracts';
import { IndexError, INDEX_ERROR_CODES } from '../index/errors.js';
import { indexPathFor, openIndex } from '../index/store.js';
import type { CompatibilityInput, ComponentInspection, SearchEvidence, SearchOptions, SearchResponse, SearchResult } from '../index/types.js';

const DEFAULT_MARGIN = 0.12;
const MAX_LIMIT = 50;

function termsFor(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}

function ftsQuery(terms: string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' OR ');
}

function textMatch(value: string, terms: string[]): string[] {
  const lower = value.toLocaleLowerCase();
  return terms.filter((term) => lower.includes(term));
}

function scoreFor(fields: Array<[string, string]>, terms: string[], exact: boolean): { score: number; evidence: SearchEvidence[] } {
  const evidence: SearchEvidence[] = [];
  let matched = 0;
  for (const [field, value] of fields) {
    const matchedTerms = textMatch(value, terms);
    if (matchedTerms.length > 0) evidence.push({ field, value, matchedTerms });
    matched += new Set(matchedTerms).size;
  }
  const coverage = terms.length === 0 ? 0 : Math.min(1, matched / terms.length);
  const fieldBonus = evidence.reduce((sum, item) => sum + (item.field === 'displayName' ? 0.12 : item.field === 'tags' || item.field === 'aliases' ? 0.08 : 0.03), 0);
  const score = Math.min(1, Number((coverage * 0.75 + Math.min(0.2, fieldBonus) + (exact ? 0.25 : 0)).toFixed(6)));
  return { score, evidence };
}

function compatibilityFor(manifest: ComponentManifest, input: CompatibilityInput | undefined): { matched: string[]; conflicts: string[]; score: number } {
  if (!input) return { matched: [], conflicts: [], score: 0 };
  const matched: string[] = [];
  const conflicts: string[] = [];
  const framework = input.framework ?? input.project?.framework.name;
  const language = input.language ?? input.project?.language.name;
  const runtime = input.runtime;
  if (framework) (manifest.framework.toLowerCase() === framework.toLowerCase() ? matched : conflicts).push(`framework:${framework}`);
  if (language) (manifest.compatibility.language.toLowerCase() === language.toLowerCase() ? matched : conflicts).push(`language:${language}`);
  if (runtime) (manifest.compatibility.runtime.toLowerCase() === runtime.toLowerCase() ? matched : conflicts).push(`runtime:${runtime}`);
  const styling = input.stylingModes ?? input.project?.styling.systems;
  if (styling?.length) {
    const overlap = styling.filter((item) => manifest.stylingModes.map((mode) => mode.toLowerCase()).includes(item.toLowerCase()));
    (overlap.length > 0 ? matched : conflicts).push(`styling:${styling.join(',')}`);
  }
  return { matched, conflicts, score: matched.length * 0.03 - conflicts.length * 0.12 };
}

function recoveryActions(catalogRoot: string, query: string) {
  return [
    { id: 'import-component', label: 'Import a component matching the query', safe: true, command: 'blockbase import <source> --json' },
    { id: 'relax-query', label: 'Try a shorter or broader search query', safe: true, command: `blockbase search "${query.split(/\s+/).slice(0, 1).join(' ')}" --json` },
    { id: 'rebuild-index', label: 'Rebuild the search index from manifests', safe: true, command: `blockbase catalog rebuild --catalog ${catalogRoot} --json` },
  ];
}

function rowResult(row: Record<string, unknown>, terms: string[], input: CompatibilityInput | undefined): SearchResult {
  const aliases = JSON.parse(String(row.aliases_json)) as string[];
  const tags = JSON.parse(String(row.tags_json)) as string[];
  const stylingModes = JSON.parse(String(row.styling_modes_json)) as string[];
  const fields: Array<[string, string]> = [
    ['displayName', String(row.display_name)], ['description', String(row.description)], ['aliases', aliases.join(' ')], ['tags', tags.join(' ')],
    ['category', String(row.category)], ['framework', String(row.framework)], ['stylingModes', stylingModes.join(' ')], ['sourceSymbols', String(row.source_symbols)],
  ];
  const scored = scoreFor(fields, terms, false);
  // Validating the full manifest dominates search time on broad queries; only compatibility scoring needs it.
  const compatibility = input ? compatibilityFor(parseComponentManifest(JSON.parse(String(row.manifest_json))), input) : { matched: [], conflicts: [], score: 0 };
  return {
    componentId: String(row.component_id), revisionId: String(row.current_revision), displayName: String(row.display_name), namespace: String(row.namespace), slug: String(row.slug), favorite: Number(row.favorite ?? 0) === 1,
    score: Math.max(0, Math.min(1, Number((scored.score + compatibility.score).toFixed(6)))), evidence: scored.evidence,
    compatibility: { matched: compatibility.matched, conflicts: compatibility.conflicts },
  };
}

export async function searchComponents(catalogRoot: string, query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const normalized = query.trim();
  const terms = termsFor(normalized);
  const index = await openIndex({ catalogRoot });
  try {
    if (terms.length === 0) return { schemaVersion: CONTRACT_VERSION, query: normalized, catalogRevision: index.catalogRevision, results: [], selection: { status: 'miss', confidenceMargin: options.confidenceMargin ?? DEFAULT_MARGIN, margin: null }, recoveryActions: recoveryActions(catalogRoot, normalized) };
    let rows: Record<string, unknown>[];
    try {
      const columns = ['component_id', 'current_revision', 'display_name', 'namespace', 'slug', 'description', 'aliases_json', 'tags_json', 'category', 'framework', 'styling_modes_json', 'source_symbols', ...(options.compatibility ? ['manifest_json'] : [])]
        .map((column) => `components.${column}`).join(', ');
      rows = index.db.prepare(`SELECT ${columns}, component_favorites.favorite AS favorite FROM component_fts JOIN components USING (component_id) JOIN component_favorites USING (component_id) WHERE component_fts MATCH ?`).all(ftsQuery(terms)) as Record<string, unknown>[];
    } catch (error) {
      throw new IndexError(INDEX_ERROR_CODES.corrupt, 'The SQLite search index could not execute its FTS query.', { indexPath: indexPathFor(catalogRoot), recoveryAction: recoveryActions(catalogRoot, normalized)[2], cause: error instanceof Error ? error.message : String(error) });
    }
    const results = rows.map((row) => rowResult(row, terms, options.compatibility))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.componentId.localeCompare(right.componentId))
      .slice(0, Math.min(MAX_LIMIT, Math.max(1, options.limit ?? 10)));
    const confidenceMargin = options.confidenceMargin ?? DEFAULT_MARGIN;
    const margin = results.length > 1 ? Number((results[0].score - results[1].score).toFixed(6)) : results.length === 1 ? results[0].score : null;
    const status = results.length === 0 ? 'miss' : results.length > 1 && (margin ?? 0) < confidenceMargin ? 'needs-selection' : 'selected';
    return {
      schemaVersion: CONTRACT_VERSION, query: normalized, catalogRevision: index.catalogRevision, results,
      selection: { status, ...(status === 'selected' ? { selectedComponentId: results[0].componentId } : {}), confidenceMargin, margin },
      recoveryActions: status === 'miss' ? recoveryActions(catalogRoot, normalized) : [],
    };
  } finally {
    index.close();
  }
}

export async function inspectComponent(catalogRoot: string, input: string, revision?: string): Promise<ComponentInspection> {
  const index = await openIndex({ catalogRoot });
  try {
    const exactMatches = index.db.prepare(`SELECT * FROM components WHERE component_id = ? OR EXISTS (SELECT 1 FROM json_each(aliases_json) WHERE value = ?) ORDER BY component_id`).all(input, input) as Record<string, unknown>[];
    if (exactMatches.length > 1) throw new IndexError(INDEX_ERROR_CODES.ambiguous, 'The alias matches multiple components; choose an explicit component ID.', { input, candidates: exactMatches.map((row) => String(row.component_id)) });
    const exact = exactMatches[0];
    if (!exact) throw new IndexError(INDEX_ERROR_CODES.componentNotFound, 'No component matched the exact ID or alias.', { input });
    const manifest = parseComponentManifest(JSON.parse(String(exact.manifest_json)));
    const revisionId = revision ?? manifest.currentRevision;
    if (revisionId !== manifest.currentRevision) {
      const revisionName = revisionId.replace(/^sha256:/, '');
      const revisionPath = join(dirname(String(exact.source_path)), 'revisions', revisionName);
      try { await stat(revisionPath); } catch { throw new IndexError(INDEX_ERROR_CODES.componentNotFound, 'The requested component revision was not found.', { input, revision: revisionId }); }
    }
    const packagePath = dirname(String(exact.source_path));
    const revisionPath = join(packagePath, 'revisions', revisionId.replace(/^sha256:/, ''));
    const alias = manifest.componentId === input ? 'id' : 'alias';
    return {
      schemaVersion: CONTRACT_VERSION, componentId: manifest.componentId, revisionId, manifest, packagePath, revisionPath,
      evidence: [
        { field: 'componentId', path: String(exact.source_path), value: manifest.componentId },
        { field: 'revision', path: join(revisionPath, 'original'), value: revisionId },
        { field: 'manifest', path: String(exact.source_path), value: manifest.displayName },
      ], lookup: { input, matchedBy: alias, exact: true },
    };
  } finally {
    index.close();
  }
}

export type { ProjectProfile };
