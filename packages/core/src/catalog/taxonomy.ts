import { parse } from 'yaml';
import type { CatalogDiagnostic, LegacyCatalogRow } from './types.js';
import { CatalogConflictError } from './errors.js';

export const ALLOWED_BUCKETS = ['brick', 'build', 'creation'] as const;
export type AllowedBucket = (typeof ALLOWED_BUCKETS)[number];

export type TaxonomyRow = { name: string; slug: string };

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}
export function parseTaxonomyCsv(text: string): TaxonomyRow[] {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  const nameIndex = header.indexOf('Name');
  const slugIndex = header.indexOf('Slug');
  if (nameIndex === -1 || slugIndex === -1) throw new Error('taxonomy CSV must have Name,Slug header');
  return lines.slice(1).flatMap((line) => {
    const cells = parseCsvLine(line);
    const name = cells[nameIndex]?.trim();
    const slug = cells[slugIndex]?.trim();
    return name && slug ? [{ name, slug }] : [];
  });
}

export type TaxonomyValidationInput = {
  catalogYaml?: string | unknown;
  catalogRows?: LegacyCatalogRow[];
  taxonomyCsv: string;
  catalogFile?: string;
  taxonomyFile?: string;
};

function evidence(file: string, value?: unknown) {
  return value === undefined ? { file } : { file, value };
}

export function validateCatalogTaxonomy(input: TaxonomyValidationInput): CatalogDiagnostic[] {
  const catalogFile = input.catalogFile ?? 'catalog.yaml';
  const taxonomyFile = input.taxonomyFile ?? 'taxonomy.csv';
  const diagnostics: CatalogDiagnostic[] = [];
  let taxonomy: TaxonomyRow[];
  try {
    taxonomy = parseTaxonomyCsv(input.taxonomyCsv);
  } catch (error) {
    diagnostics.push({
      code: 'taxonomy.invalid_header', severity: 'error',
      message: error instanceof Error ? error.message : 'taxonomy CSV is invalid',
      file: taxonomyFile, evidence: evidence(taxonomyFile),
    });
    return diagnostics;
  }
  const taxonomySlugs = new Set(taxonomy.map((row) => row.slug));
  const duplicateTaxonomy = new Set<string>();
  for (const row of taxonomy) {
    if (duplicateTaxonomy.has(row.slug)) diagnostics.push({
      code: 'taxonomy.duplicate_family', severity: 'error',
      message: `taxonomy family '${row.slug}' is declared more than once`,
      file: taxonomyFile, path: row.slug, evidence: evidence(taxonomyFile, row),
    });
    duplicateTaxonomy.add(row.slug);
  }

  let rows: LegacyCatalogRow[] = input.catalogRows ?? [];
  if (!input.catalogRows) {
    try {
      const parsed = typeof input.catalogYaml === 'string' ? parse(input.catalogYaml) : input.catalogYaml;
      rows = Array.isArray((parsed as { blocks?: unknown[] } | null)?.blocks)
        ? ((parsed as { blocks: LegacyCatalogRow[] }).blocks ?? [])
        : [];
    } catch (error) {
      diagnostics.push({ code: 'catalog.invalid_yaml', severity: 'error', message: error instanceof Error ? error.message : 'catalog YAML is invalid', file: catalogFile, evidence: evidence(catalogFile) });
      return diagnostics;
    }
  }
  const occupied = new Set<string>();
  const identities = new Set<string>();
  const paths = new Map<string, LegacyCatalogRow[]>();
  for (const row of rows) {
    const name = row?.name;
    const slug = row?.slug;
    const bucket = row?.bucket;
    const path = row?.path;
    if (typeof bucket !== 'string' || !(ALLOWED_BUCKETS as readonly string[]).includes(bucket)) diagnostics.push({
      code: 'taxonomy.invalid_bucket', severity: 'error', message: `catalog bucket '${bucket}' is not allowed for slug '${slug}'`, file: catalogFile, path: String(slug ?? ''), evidence: evidence(catalogFile, row),
    });
    if (typeof name !== 'string' || !taxonomySlugs.has(name)) diagnostics.push({
      code: 'taxonomy.missing_family', severity: 'error', message: `catalog family '${name}' is missing from taxonomy`, file: catalogFile, path: String(slug ?? ''), evidence: evidence(catalogFile, row),
    });
    if (typeof name === 'string') occupied.add(name);
    const identity = `${name}\u0000${slug}`;
    if (identities.has(identity)) diagnostics.push({
      code: 'catalog.duplicate_identity', severity: 'error', message: `catalog identity '${name}/${slug}' is duplicated`, file: catalogFile, path: String(slug ?? ''), evidence: evidence(catalogFile, row),
    });
    identities.add(identity);
    if (typeof path === 'string') paths.set(path, [...(paths.get(path) ?? []), row]);
    const expectedPath = slug === 'snowboarder-404' ? 'empty-states/dino-404' : `${name}/${slug}`;
    if (path !== expectedPath) diagnostics.push({
      code: 'catalog.noncanonical_path', severity: 'error', message: `catalog path '${path}' must equal '${expectedPath}'`, file: catalogFile, path: String(slug ?? ''), evidence: evidence(catalogFile, row),
    });
  }
  for (const [path, pathRows] of paths) {
    if (pathRows.length > 1) {
      const allowed = path === 'empty-states/dino-404' && pathRows.some((row) => row.slug === 'snowboarder-404') && pathRows.some((row) => row.slug === 'dino-404');
      diagnostics.push({
        code: allowed ? 'catalog.shared_path_exception' : 'catalog.shared_path', severity: allowed ? 'warning' : 'error',
        message: allowed ? `shared path '${path}' is the documented snowboarder-404 variant exception` : `catalog path '${path}' is shared by multiple identities`, file: catalogFile, path, evidence: evidence(catalogFile, pathRows.map((row) => row.slug)),
      });
    }
  }
  for (const row of taxonomy) if (!occupied.has(row.slug)) diagnostics.push({
    code: 'taxonomy.unused_family', severity: 'error', message: `taxonomy family '${row.slug}' has zero catalog rows`, file: taxonomyFile, path: row.slug, evidence: evidence(taxonomyFile, row),
  });
  return diagnostics;
}

export function assertCatalogTaxonomy(input: TaxonomyValidationInput): void {
  const diagnostics = validateCatalogTaxonomy(input);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) throw new CatalogConflictError(errors, errors[0].message);
}
