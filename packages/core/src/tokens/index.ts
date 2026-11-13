import {
  CONTRACT_VERSION,
  stableStringify,
  type CanonicalTokenContract,
  type NormalizationResidual,
  type SourceEnvelope,
  type SourceFile,
  type TokenValueType,
} from '@blockbase/contracts';
import { revisionHash, sha256 } from '../import/local.js';

export type TokenOccurrenceKind = 'tailwind' | 'css' | 'css-module' | 'inline-style';

export type TokenOccurrence = {
  filePath: string;
  line: number;
  column: number;
  kind: TokenOccurrenceKind;
  source: string;
  originalValue: string;
  valueType: TokenValueType;
  tokenName?: string;
  role?: string;
  normalizedValue?: string;
  fallbackValue?: string;
  confidence: number;
  mapped: boolean;
  evidence: string;
};

export type TokenResidual = NormalizationResidual & {
  fallbackValue: string;
  confidence: number;
};

export type TokenExtractionResult = {
  contract: CanonicalTokenContract;
  occurrences: TokenOccurrence[];
  residuals: TokenResidual[];
  coverage: { total: number; normalized: number; residual: number };
};

type FileInput = Pick<SourceFile, 'path' | 'content'>;

const SPACING: Record<string, [string, string]> = {
  '0.5': ['space.0.5', '0.125rem'], '1': ['space.1', '0.25rem'], '1.5': ['space.1.5', '0.375rem'],
  '2': ['space.2', '0.5rem'], '2.5': ['space.2.5', '0.625rem'], '3': ['space.3', '0.75rem'],
  '3.5': ['space.3.5', '0.875rem'], '4': ['space.4', '1rem'], '5': ['space.5', '1.25rem'],
  '6': ['space.6', '1.5rem'], '8': ['space.8', '2rem'], '10': ['space.10', '2.5rem'],
  '12': ['space.12', '3rem'], '16': ['space.16', '4rem'],
};

const RADIUS: Record<string, [string, string]> = {
  sm: ['radius.sm', '0.125rem'], md: ['radius.md', '0.375rem'], DEFAULT: ['radius.md', '0.25rem'],
  lg: ['radius.lg', '0.5rem'], xl: ['radius.lg', '0.75rem'], '2xl': ['radius.lg', '1rem'], full: ['radius.full', '9999px'],
};

const SEMANTIC_CLASSES: Record<string, [string, TokenValueType, string, string]> = {
  'bg-background': ['color.surface.default', 'color', 'var(--background)', 'semantic background utility'],
  'bg-card': ['color.surface.elevated', 'color', 'var(--card)', 'semantic surface utility'],
  'text-foreground': ['color.text.primary', 'color', 'var(--foreground)', 'semantic text utility'],
  'text-muted-foreground': ['color.text.muted', 'color', 'var(--muted-foreground)', 'semantic text utility'],
  'border-border': ['color.border.default', 'color', 'var(--border)', 'semantic border utility'],
  'bg-primary': ['color.action.primary.background', 'color', 'var(--primary)', 'semantic action utility'],
  'text-primary-foreground': ['color.action.primary.foreground', 'color', 'var(--primary-foreground)', 'semantic action utility'],
};

const COLOR_PREFIXES: Record<string, string> = {
  bg: 'color.surface.default', 'from': 'color.surface.default', 'to': 'color.surface.default',
  text: 'color.text.primary', border: 'color.border.default', decoration: 'color.text.primary',
};

function filesFrom(input: SourceEnvelope | readonly FileInput[]): readonly FileInput[] {
  return 'files' in input ? input.files : input;
}

function location(content: string, offset: number): { line: number; column: number } {
  const before = content.slice(0, Math.max(0, offset));
  const line = before.split('\n').length;
  const lastBreak = before.lastIndexOf('\n');
  return { line, column: offset - lastBreak };
}

function valueType(value: string): TokenValueType {
  if (/^#(?:[\da-f]{3,8})$/i.test(value) || /^(?:rgb|hsl)a?\(/i.test(value) || /^(?:white|black|red|blue|green|transparent)$/i.test(value)) return 'color';
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|vh|vw|%|ch|ex|cm|mm|in|pt|pc)$/.test(value)) return 'dimension';
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)$/.test(value)) return 'duration';
  if (/^(?:0|1|true|false)$/.test(value)) return 'number';
  return 'string';
}

function roleForProperty(property: string, value: string): [string, TokenValueType] | undefined {
  const p = property.toLowerCase();
  const varName = value.match(/^var\(\s*--([\w-]+)/)?.[1] ?? '';
  if (/background|color|fill|stroke/.test(p)) {
    if (/surface|background|card|canvas/.test(varName)) return ['color.surface.default', 'color'];
    if (/muted|secondary/.test(varName)) return ['color.text.muted', 'color'];
    if (/foreground|text/.test(varName)) return ['color.text.primary', 'color'];
    if (/border|ring|divider/.test(varName)) return ['color.border.default', 'color'];
    if (/primary|accent|brand/.test(varName)) return ['color.action.primary.background', 'color'];
  }
  if (/radius/.test(p) && /^(?:0|[\d.]+(?:px|rem|em))$/.test(value)) return ['radius.md', 'dimension'];
  const spacing = value.match(/^(\d+(?:\.\d+)?)(px|rem)$/)?.[1];
  if (spacing) {
    const pixels = value.endsWith('rem') ? Number(spacing) * 16 : Number(spacing);
    const scale = Object.entries(SPACING).find(([, [, canonical]]) => Number.parseFloat(canonical) * 16 === pixels);
    if (scale && /^(?:padding|margin|gap|inset|top|right|bottom|left|width|height|size)/.test(p)) return [scale[1][0], 'dimension'];
  }
  if (/^\d+(?:\.\d+)?$/.test(value) && /^(?:padding|margin|gap|inset|top|right|bottom|left|width|height|size)/.test(p)) {
    const scale = Object.entries(SPACING).find(([, [, canonical]]) => Number.parseFloat(canonical) * 16 === Number(value));
    if (scale) return [scale[1][0], 'dimension'];
  }
  return undefined;
}

function residual(
  filePath: string,
  content: string,
  offset: number,
  kind: TokenResidual['kind'],
  reason: string,
  source: string,
  fallbackValue: string,
  confidence: number,
): TokenResidual {
  const point = location(content, offset);
  return { path: filePath, line: point.line, column: point.column, kind, reason, source, fallbackValue, confidence };
}

export function extractTokens(input: SourceEnvelope | readonly FileInput[], contractId?: string): TokenExtractionResult {
  const files = filesFrom(input).slice().sort((a, b) => a.path.localeCompare(b.path));
  const occurrences: TokenOccurrence[] = [];
  const residuals: TokenResidual[] = [];
  const definitions = new Map<string, { name: string; role: string; valueType: TokenValueType; defaultValue: string; fallbackValue?: string; confidence: number }>();
  const staticStringHelpers = new Map<string, string>();
  for (const file of files) {
    for (const helper of file.content.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])(.*?)\2/g)) staticStringHelpers.set(helper[1], helper[3]);
  }

  function addOccurrence(file: FileInput, offset: number, kind: TokenOccurrenceKind, source: string, originalValue: string, mapped: { name: string; valueType: TokenValueType; defaultValue: string; confidence: number; evidence: string; fallbackValue?: string } | undefined, reason?: string): void {
    const point = location(file.content, offset);
    const type = mapped?.valueType ?? valueType(originalValue);
    const occurrence: TokenOccurrence = {
      filePath: file.path, line: point.line, column: point.column, kind, source, originalValue, valueType: type,
      ...(mapped ? { tokenName: mapped.name, role: mapped.name, normalizedValue: `var(--bb-${mapped.name.replaceAll('.', '-')})`, ...(mapped.fallbackValue ? { fallbackValue: mapped.fallbackValue } : {}) } : {}),
      confidence: mapped?.confidence ?? 0.35, mapped: Boolean(mapped), evidence: mapped?.evidence ?? reason ?? 'No safe semantic mapping was found.',
    };
    occurrences.push(occurrence);
    if (mapped) {
      const previous = definitions.get(mapped.name);
      definitions.set(mapped.name, {
        name: mapped.name, role: mapped.name, valueType: mapped.valueType, defaultValue: mapped.defaultValue,
        ...(mapped.fallbackValue ? { fallbackValue: mapped.fallbackValue } : {}), confidence: Math.min(previous?.confidence ?? 1, mapped.confidence),
      });
    } else {
      residuals.push(residual(file.path, file.content, offset, 'unresolved-token', reason ?? 'The literal is not mapped by the supported token subset.', originalValue, originalValue, 0.35));
    }
  }

  function scanTailwind(file: FileInput): void {
    const classAttribute = /\b(?:className|class)\s*=\s*("[^"]*"|'[^']*'|\{[\s\S]*?\})/g;
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = classAttribute.exec(file.content))) {
      let expression = match[1];
      const expressionOffset = match.index + match[0].indexOf(expression);
      const helperName = expression.match(/^\{\s*([A-Za-z_$][\w$]*)\s*\}$/)?.[1];
      const helperValue = helperName ? staticStringHelpers.get(helperName) : undefined;
      if (helperValue !== undefined) expression = `'${helperValue}'`;
      const staticModuleReference = /^\{\s*[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\}$/.test(expression);
      if (staticModuleReference) continue;
      if (expression.startsWith('{') && (expression.includes('${') || !/['"]/.test(expression))) {
        residuals.push(residual(file.path, file.content, expressionOffset, 'unsupported-syntax', 'Class names are runtime-generated; finite static values are required.', expression, expression, 0));
        continue;
      }
      const literals = expression.startsWith('{') ? [...expression.matchAll(/(['"])(.*?)\1/g)].map((item) => ({ value: item[2], offset: expressionOffset + item.index! + 1 })) : [{ value: expression.slice(1, -1), offset: expressionOffset + 1 }];
      for (const literal of literals) {
        for (const utility of literal.value.split(/\s+/).filter(Boolean)) {
          const utilityOffset = literal.offset + literal.value.indexOf(utility);
          const semantic = SEMANTIC_CLASSES[utility];
          if (semantic) {
            seen.add(`${utilityOffset}:${utility}`);
            addOccurrence(file, utilityOffset, 'tailwind', utility, utility, { name: semantic[0], valueType: semantic[1], defaultValue: semantic[2], confidence: 0.98, evidence: semantic[3] });
            continue;
          }
          const arbitrary = utility.match(/^(?:([a-z-]+)-)\[(.+)\]$/i);
          if (arbitrary) {
            const prefix = arbitrary[1];
            const raw = arbitrary[2];
            const type = valueType(raw);
            const semanticRole = COLOR_PREFIXES[prefix];
            const mapped = raw.startsWith('var(--') && semanticRole ? { name: semanticRole, valueType: 'color' as TokenValueType, defaultValue: raw, confidence: 0.9, evidence: 'Explicit CSS variable in an arbitrary utility.' } : undefined;
            seen.add(`${utilityOffset}:${utility}`);
            addOccurrence(file, utilityOffset + utility.indexOf(raw), 'tailwind', utility, raw, mapped, 'Arbitrary Tailwind literals require explicit destination mapping.');
            void type;
            continue;
          }
          const spacing = utility.match(/^(?:-?(?:p|m|gap|space-[xy]|inset|w|h|size|top|right|bottom|left)(?:[trblxy])?)-([\d.]+)$/)?.[1];
          if (spacing && SPACING[spacing]) {
            seen.add(`${utilityOffset}:${utility}`);
            addOccurrence(file, utilityOffset, 'tailwind', utility, spacing, { name: SPACING[spacing][0], valueType: 'dimension', defaultValue: SPACING[spacing][1], confidence: 0.95, evidence: 'Supported Tailwind spacing scale.' });
            continue;
          }
          const radius = utility.match(/^rounded(?:-([\w]+))?$/)?.[1] ?? (utility === 'rounded' ? 'DEFAULT' : undefined);
          if (radius && RADIUS[radius]) {
            seen.add(`${utilityOffset}:${utility}`);
            addOccurrence(file, utilityOffset, 'tailwind', utility, radius, { name: RADIUS[radius][0], valueType: 'dimension', defaultValue: RADIUS[radius][1], confidence: 0.95, evidence: 'Supported Tailwind radius scale.' });
            continue;
          }
          const shadow = utility.match(/^shadow(?:-(sm|md|lg))?$/)?.[1] ?? (utility === 'shadow' ? 'md' : undefined);
          if (shadow) {
            seen.add(`${utilityOffset}:${utility}`);
            addOccurrence(file, utilityOffset, 'tailwind', utility, shadow, { name: `shadow.${shadow}`, valueType: 'shadow', defaultValue: utility, confidence: 0.9, evidence: 'Supported Tailwind shadow utility.' });
            continue;
          }
          const fontSize = utility.match(/^text-(xs|sm|base|lg|xl|2xl)$/)?.[1];
          if (fontSize) {
            seen.add(`${utilityOffset}:${utility}`);
            addOccurrence(file, utilityOffset, 'tailwind', utility, fontSize, { name: `font.size.${fontSize === 'base' ? 'md' : fontSize}`, valueType: 'dimension', defaultValue: utility, confidence: 0.9, evidence: 'Supported Tailwind typography scale.' });
            continue;
          }
          if (/^(?:[a-z-]+:)*(?:bg|text|border|from|to|ring|decoration)-/.test(utility)) {
            seen.add(`${utilityOffset}:${utility}`);
            addOccurrence(file, utilityOffset, 'tailwind', utility, utility, undefined, 'Tailwind theme utility is outside the published semantic subset.');
          }
        }
      }
    }
    // Local class helpers commonly assign a static utility string to a constant
    // instead of placing it directly in JSX. Inventory those strings as well.
    for (const literal of file.content.matchAll(/(['"])([^'"\n]*\b(?:bg|text|border|p|m|gap|rounded|shadow)-[^'"\n]*)\1/g)) {
      const value = literal[2];
      const valueOffset = literal.index! + 1;
      for (const utility of value.split(/\s+/).filter(Boolean)) {
        const utilityOffset = valueOffset + value.indexOf(utility);
        if (seen.has(`${utilityOffset}:${utility}`)) continue;
        const semantic = SEMANTIC_CLASSES[utility];
        if (semantic) {
          addOccurrence(file, utilityOffset, 'tailwind', utility, utility, { name: semantic[0], valueType: semantic[1], defaultValue: semantic[2], confidence: 0.98, evidence: semantic[3] });
          continue;
        }
        const spacing = utility.match(/^(?:-?(?:p|m|gap|space-[xy]|inset|w|h|size|top|right|bottom|left)(?:[trblxy])?)-([\d.]+)$/)?.[1];
        if (spacing && SPACING[spacing]) {
          addOccurrence(file, utilityOffset, 'tailwind', utility, spacing, { name: SPACING[spacing][0], valueType: 'dimension', defaultValue: SPACING[spacing][1], confidence: 0.95, evidence: 'Supported Tailwind spacing scale.' });
          continue;
        }
        const radius = utility.match(/^rounded(?:-([\w]+))?$/)?.[1] ?? (utility === 'rounded' ? 'DEFAULT' : undefined);
        if (radius && RADIUS[radius]) {
          addOccurrence(file, utilityOffset, 'tailwind', utility, radius, { name: RADIUS[radius][0], valueType: 'dimension', defaultValue: RADIUS[radius][1], confidence: 0.95, evidence: 'Supported Tailwind radius scale.' });
          continue;
        }
        if (/^(?:[a-z-]+:)*(?:bg|text|border|from|to|ring|decoration)-/.test(utility)) addOccurrence(file, utilityOffset, 'tailwind', utility, utility, undefined, 'Tailwind theme utility is outside the published semantic subset.');
      }
    }
  }

  function scanCss(file: FileInput): void {
    const kind: TokenOccurrenceKind = file.path.endsWith('.module.css') ? 'css-module' : 'css';
    const declarations = /(^|[;{\n])\s*([\w-]+)\s*:\s*([^;{}\n]+)(?=;|}|$)/g;
    let match: RegExpExecArray | null;
    while ((match = declarations.exec(file.content))) {
      const property = match[2];
      const raw = match[3].trim();
      if (property.startsWith('--') || raw.startsWith('url(') || raw === 'inherit' || raw === 'initial' || raw === 'unset') continue;
      const valueOffset = match.index + match[0].lastIndexOf(raw);
      const mappedRole = roleForProperty(property, raw);
      if (mappedRole) addOccurrence(file, valueOffset, kind, `${property}: ${raw}`, raw, { name: mappedRole[0], valueType: mappedRole[1], defaultValue: raw, confidence: raw.startsWith('var(') ? 0.92 : 0.9, evidence: raw.startsWith('var(') ? 'Explicit semantic CSS variable.' : 'Supported CSS scale value.' });
      else if (/color|background|fill|stroke|shadow|radius|padding|margin|gap|font-size|duration|transition/.test(property)) addOccurrence(file, valueOffset, kind, `${property}: ${raw}`, raw, undefined, `Static CSS literal '${raw}' has no explicit semantic variable mapping.`);
    }
  }

  function scanInline(file: FileInput): void {
    const styles = /\bstyle\s*=\s*\{\{([\s\S]*?)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = styles.exec(file.content))) {
      const body = match[1];
      const bodyOffset = match.index + match[0].indexOf(body);
      for (const property of body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:\s*([^,]+?)(?=,|$)/g)) {
        const prop = property[1];
        const raw = property[2].trim();
        const offset = bodyOffset + property.index! + property[0].indexOf(raw);
        const quoted = raw.match(/^(?:'([^']*)'|"([^"]*)")$/);
        const staticValue = quoted?.[1] ?? quoted?.[2] ?? (/^-?(?:\d+(?:\.\d+)?)$/.test(raw) ? raw : undefined);
        if (staticValue === undefined) {
          residuals.push(residual(file.path, file.content, offset, 'unsupported-syntax', `Inline style '${prop}' is runtime-derived; static values are required.`, raw, raw, 0));
          continue;
        }
        const mappedRole = roleForProperty(prop, staticValue);
        if (mappedRole) addOccurrence(file, offset, 'inline-style', `${prop}: ${raw}`, staticValue, { name: mappedRole[0], valueType: mappedRole[1], defaultValue: staticValue, confidence: staticValue.startsWith('var(') ? 0.92 : 0.9, evidence: staticValue.startsWith('var(') ? 'Explicit semantic CSS variable in a static inline style.' : 'Supported static inline scale value.' });
        else if (/color|background|fill|stroke|shadow|radius|padding|margin|gap|font|duration|transition/i.test(prop)) addOccurrence(file, offset, 'inline-style', `${prop}: ${raw}`, staticValue, undefined, `Static inline style literal '${staticValue}' has no explicit semantic variable mapping.`);
      }
    }
  }

  for (const file of files) {
    const extension = file.path.slice(file.path.lastIndexOf('.')).toLowerCase();
    if (extension === '.css') scanCss(file);
    else if (extension === '.tsx' || extension === '.jsx' || extension === '.ts' || extension === '.js') {
      scanTailwind(file);
      scanInline(file);
    }
  }

  const sourceHash = 'files' in input
    ? revisionHash(input)
    : sha256(stableStringify(files.map((file) => [file.path, file.content])));
  return {
    contract: { schemaVersion: CONTRACT_VERSION, contractId: contractId ?? `tokens_${sourceHash.slice(-12)}`, tokens: [...definitions.values()] },
    occurrences,
    residuals,
    coverage: { total: occurrences.length, normalized: occurrences.filter((entry) => entry.mapped).length, residual: residuals.length },
  };
}

export const extractTokenContract = extractTokens;
