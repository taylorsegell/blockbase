import {
  optionalString,
  parseVersioned,
  requiredArray,
  requiredObject,
  requiredString,
  stringAt,
  stringArrayAt,
  type JsonObject,
} from './runtime.js';
import { parseTokenContract, type CanonicalTokenContract } from './tokens.js';
import type { ContractVersion } from './runtime.js';

export type ComponentDependency = {
  name: string;
  range: string;
  kind: 'runtime' | 'peer' | 'optional' | 'local';
};

export type ComponentManifest = {
  schemaVersion: ContractVersion;
  componentId: string;
  namespace: string;
  slug: string;
  displayName: string;
  description: string;
  aliases: string[];
  tags: string[];
  category: string;
  framework: string;
  stylingModes: string[];
  currentRevision: string;
  /** Relative POSIX path of the component's entry file inside the revision's original/ tree. */
  entryPoint?: string;
  provenance: {
    sourceType: string;
    locator: string;
    license: string;
    attributionStatus: 'known' | 'unknown' | 'required';
    /** Who made the component, when known. Absent means unknown. */
    author?: string;
  };
  compatibility: {
    language: string;
    runtime: string;
    frameworkRange: string;
    clientServer: 'client' | 'server' | 'either';
  };
  interface: {
    props: string[];
    slots: string[];
    events: string[];
    accessibilityNotes: string[];
  };
  dependencies: ComponentDependency[];
  tokens: CanonicalTokenContract;
  quality: {
    parseStatus: 'passed' | 'partial' | 'failed';
    previewStatus: 'passed' | 'partial' | 'failed' | 'unknown';
    normalizationCoverage: number;
    riskLevel: 'low' | 'medium' | 'high';
    warnings: string[];
  };
  integrity: {
    sourceHash: string;
    assetHashes: string[];
  };
};

function validateDependencies(value: unknown): void {
  requiredArray({ value }, 'value').forEach((entry, index) => {
    const dependency = entry as JsonObject;
    requiredString(dependency, 'name');
    requiredString(dependency, 'range');
    stringAt(dependency.kind, `$.dependencies[${index}].kind`);
  });
}

export function parseComponentManifest(input: unknown): ComponentManifest {
  return parseVersioned<ComponentManifest>(input, 'ComponentManifest', (object) => {
    for (const key of ['componentId', 'namespace', 'slug', 'displayName', 'description', 'category', 'framework', 'currentRevision']) {
      requiredString(object, key);
    }
    if (object.entryPoint !== undefined) {
      const entry = object.entryPoint;
      if (typeof entry !== 'string' || entry.length === 0 || entry.startsWith('/') || entry.split(/[\\/]/).includes('..')) {
        throw new Error('$.entryPoint must be a non-empty relative path without ".." segments.');
      }
    }
    stringArrayAt(object.aliases, '$.aliases');
    stringArrayAt(object.tags, '$.tags');
    stringArrayAt(object.stylingModes, '$.stylingModes');

    const provenance = requiredObject(object, 'provenance');
    requiredString(provenance, 'sourceType');
    requiredString(provenance, 'locator');
    requiredString(provenance, 'license');
    stringAt(provenance.attributionStatus, '$.provenance.attributionStatus');
    optionalString(provenance, 'author');

    const compatibility = requiredObject(object, 'compatibility');
    requiredString(compatibility, 'language');
    requiredString(compatibility, 'runtime');
    requiredString(compatibility, 'frameworkRange');
    stringAt(compatibility.clientServer, '$.compatibility.clientServer');

    const componentInterface = requiredObject(object, 'interface');
    stringArrayAt(componentInterface.props, '$.interface.props');
    stringArrayAt(componentInterface.slots, '$.interface.slots');
    stringArrayAt(componentInterface.events, '$.interface.events');
    stringArrayAt(componentInterface.accessibilityNotes, '$.interface.accessibilityNotes');
    validateDependencies(object.dependencies);
    parseTokenContract(object.tokens);

    const quality = requiredObject(object, 'quality');
    stringAt(quality.parseStatus, '$.quality.parseStatus');
    stringAt(quality.previewStatus, '$.quality.previewStatus');
    requiredString(quality, 'riskLevel');
    stringArrayAt(quality.warnings, '$.quality.warnings');
    const integrity = requiredObject(object, 'integrity');
    requiredString(integrity, 'sourceHash');
    stringArrayAt(integrity.assetHashes, '$.integrity.assetHashes');
  });
}
