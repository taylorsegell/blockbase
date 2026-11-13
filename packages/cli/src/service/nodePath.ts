import { existsSync, realpathSync } from 'node:fs';

export interface NodePathDeps {
  exists(path: string): boolean;
  realpath(path: string): string;
}

const defaultDeps: NodePathDeps = { exists: existsSync, realpath: realpathSync };

const CELLAR_NODE = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/;

/**
 * Homebrew installs Node under a version-specific Cellar folder that vanishes on upgrade.
 * Prefer the stable `<prefix>/opt/<formula>` symlink when it resolves to the same binary.
 */
export function stableNodePath(execPath: string, deps: NodePathDeps = defaultDeps): string {
  const match = CELLAR_NODE.exec(execPath);
  if (!match) return execPath;
  const candidate = `${match[1]}/opt/${match[2]}/bin/node`;
  try {
    if (!deps.exists(candidate)) return execPath;
    return deps.realpath(candidate) === deps.realpath(execPath) ? candidate : execPath;
  } catch {
    return execPath;
  }
}
