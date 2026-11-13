import type { ProjectProfile, TokenMapping } from '@blockbase/contracts';

export type CanonicalRoleMapping = TokenMapping & {
  destinationToken?: string;
};

function candidates(profile: ProjectProfile): string[] {
  return [...new Set([...Object.keys(profile.tokens.values), ...Object.keys(profile.tokens.aliases)])].sort();
}

function roleWords(role: string): string[] {
  return role.split('.').filter((word) => !['color', 'space', 'radius', 'font', 'shadow', 'motion', 'size'].includes(word));
}

function chooseDestinationToken(role: string, profile: ProjectProfile): string | undefined {
  const available = candidates(profile);
  if (available.length === 0) return undefined;
  const words = roleWords(role);
  const scored = available.map((candidate) => {
    const lower = candidate.toLowerCase();
    let score = 0;
    for (const word of words) if (lower.includes(word)) score += 4;
    if (role.includes('surface') && /(surface|background|page|canvas|card)/.test(lower)) score += 3;
    if (role.includes('text.primary') && /(ink|foreground|content|text)/.test(lower)) score += 3;
    if (role.includes('text.muted') && /(muted|secondary|subtle)/.test(lower)) score += 3;
    if (role.includes('border') && /(border|divider|ring)/.test(lower)) score += 3;
    if (role.includes('action') && /(primary|accent|brand)/.test(lower)) score += 3;
    return { candidate, score };
  }).sort((left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate));
  return scored[0]?.score ? scored[0].candidate : undefined;
}

function preferredToken(role: string): string[] {
  return role.includes('surface.default') ? ['--background', '--surface', '--color-surface']
    : role.includes('surface.elevated') ? ['--card', '--surface-card']
      : role.includes('text.primary') ? ['--foreground', '--text', '--content-ink', '--color-ink']
        : role.includes('text.muted') ? ['--muted-foreground', '--muted', '--content-muted']
          : role.includes('border') ? ['--border', '--divider']
            : role.includes('action.primary') ? ['--primary', '--accent', '--brand'] : [];
}

export function canonicalRoleMappings(roles: readonly string[], profile: ProjectProfile): CanonicalRoleMapping[] {
  const known = candidates(profile);
  return [...new Set(roles)].sort().map((role) => {
    const destinationToken = preferredToken(role).find((name) => known.includes(name)) ?? chooseDestinationToken(role, profile);
    return {
      sourceToken: role,
      destinationExpression: destinationToken ? `var(${destinationToken})` : '',
      confidence: destinationToken ? 'high' : 'low',
      ...(destinationToken ? { destinationToken } : {}),
    };
  });
}

/** Shared mapper name used by preview and destination emission callers. */
export const mapCanonicalRoles = canonicalRoleMappings;

function resolveProfileValue(name: string, profile: ProjectProfile, seen = new Set<string>()): string | undefined {
  if (seen.has(name)) return undefined;
  const value = profile.tokens.values[name];
  if (value !== undefined) return value;
  const alias = profile.tokens.aliases[name];
  if (!alias) return undefined;
  const target = alias.match(/^var\(\s*(--[\w-]+)\s*\)$/)?.[1];
  return target ? resolveProfileValue(target, profile, new Set([...seen, name])) : alias;
}

export function canonicalRoleValues(roles: readonly string[], profile: ProjectProfile): Array<CanonicalRoleMapping & { value?: string }> {
  return canonicalRoleMappings(roles, profile).map((mapping) => ({
    ...mapping,
    ...(mapping.destinationToken ? { value: resolveProfileValue(mapping.destinationToken, profile) } : {}),
  }));
}

export const mapCanonicalValues = canonicalRoleValues;
