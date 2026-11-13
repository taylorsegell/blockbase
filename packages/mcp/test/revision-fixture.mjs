// Shared test helper: writes a real on-disk component revision directory matching
// `RevisionStore`'s own layout (`revisions/<id>/original/**` + `revisions/<id>/assets/**`, see
// `packages/core/src/store/revisions/store.ts`), so `get_component_package` tests exercise real
// filesystem reads and the same integrity math the commit path uses — not a synthetic stub.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { revisionHash, sha256 } from '@blockbase/core';

/**
 * @param {string} componentDir directory that would hold `component.json` for a real package
 * @param {{ files?: Array<{ path: string, content: string }>, assets?: Array<{ path: string, bytes: Buffer }> }} content
 * @returns {Promise<{ revisionId: string, revisionPath: string }>}
 */
export async function writeRevisionFixture(componentDir, { files = [], assets = [] } = {}) {
  const canonicalFiles = files.map((file) => ({
    path: file.path,
    content: file.content,
    contentHash: sha256(Buffer.from(file.content, 'utf8')),
  }));
  const canonicalAssets = assets.map((asset) => ({
    path: asset.path,
    mediaType: 'application/octet-stream',
    contentHash: sha256(asset.bytes),
  }));
  const envelope = {
    schemaVersion: '1',
    sourceType: 'directory',
    files: canonicalFiles,
    assets: canonicalAssets,
    provenance: { sourceType: 'directory', locator: componentDir },
  };
  const revisionId = revisionHash(envelope);
  const revisionPath = join(componentDir, 'revisions', revisionId.slice('sha256:'.length));
  const originalPath = join(revisionPath, 'original');
  await mkdir(originalPath, { recursive: true });
  for (const file of files) {
    const destination = join(originalPath, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content, 'utf8');
  }
  if (assets.length > 0) {
    const assetsPath = join(revisionPath, 'assets');
    await mkdir(assetsPath, { recursive: true });
    for (const asset of assets) {
      const destination = join(assetsPath, asset.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, asset.bytes);
    }
  }
  return { revisionId, revisionPath };
}
