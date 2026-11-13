import type { OperationName } from '@blockbase/contracts';

export type OperationDefinition = {
  operation: OperationName;
  command: string;
  description: string;
  json: boolean;
};

/** The single command inventory consumed by the CLI and agent integrations. */
export const OPERATION_REGISTRY: readonly OperationDefinition[] = [
  {
    operation: 'catalog.migrate',
    command: 'catalog migrate',
    description: 'Plan, apply, or resume an audited non-destructive migration from the legacy catalog.',
    json: true,
  },
  {
    operation: 'import',
    command: 'import <source>',
    description: 'Safely import a local React file, directory, stdin source, or 21st.dev paste into an immutable revision.',
    json: true,
  },
  {
    operation: 'catalog.locate',
    command: 'catalog locate',
    description: 'Resolve the catalog path without creating a catalog.',
    json: true,
  },
  {
    operation: 'catalog.list',
    command: 'catalog list',
    description: 'List every catalog component with its category, bucket, tags, and description, plus collections.',
    json: true,
  },
  {
    operation: 'catalog.rebuild',
    command: 'catalog rebuild',
    description: 'Rebuild the SQLite search index from committed manifests.',
    json: true,
  },
  {
    operation: 'search',
    command: 'search <query>',
    description: 'Search the manifest-derived SQLite FTS index with deterministic ranking and selection evidence.',
    json: true,
  },
  {
    operation: 'inspect',
    command: 'inspect <component-id-or-alias>',
    description: 'Inspect an exact component ID or alias and an optional immutable revision.',
    json: true,
  },
  {
    operation: 'catalog.validate',
    command: 'catalog validate',
    description: 'Read-only validation of the legacy catalog and metadata.',
    json: true,
  },
  {
    operation: 'doctor',
    command: 'doctor',
    description: 'Run read-only catalog health diagnostics.',
    json: true,
  },
  {
    operation: 'project.inspect',
    command: 'project inspect --cwd <path>',
    description: 'Read bounded React project conventions, tokens, dependencies, and validation commands.',
    json: true,
  },
  {
    operation: 'adapt',
    command: 'adapt <component-id>',
    description: 'Prepare a deterministic destination-native adaptation without changing the destination project.',
    json: true,
  },
  {
    operation: 'add',
    command: 'add <component-id>',
    description: 'Plan or explicitly apply manifest-listed adaptation files.',
    json: true,
  },
  {
    operation: 'validate',
    command: 'validate <adaptation-manifest>',
    description: 'Run only the validation commands declared by an adaptation manifest.',
    json: true,
  },
  {
    operation: 'agent.link',
    command: 'agent link',
    description: 'Link the repository-owned Blockbase skills and executable into an agent home.',
    json: true,
  },
  {
    operation: 'agent.check',
    command: 'agent check',
    description: 'Check the repository-owned Blockbase links in an agent home.',
    json: true,
  },
  {
    operation: 'agent.unlink',
    command: 'agent unlink',
    description: 'Remove only the repository-owned Blockbase links from an agent home.',
    json: true,
  },
  {
    operation: 'agent.install',
    command: 'agent install',
    description: 'Install a provider package into project or global scope with an ownership inventory.',
    json: true,
  },
  {
    operation: 'agent.update',
    command: 'agent update',
    description: 'Update only the Blockbase-owned provider payload and preserve unrelated configuration.',
    json: true,
  },
  {
    operation: 'agent.remove',
    command: 'agent remove',
    description: 'Remove only Blockbase-owned provider records from project or global scope.',
    json: true,
  },
  {
    operation: 'inbox.add',
    command: 'inbox add (--path | -)',
    description: 'Parks a paste, 21st.dev paste, or local path without importing it.',
    json: true,
  },
  {
    operation: 'inbox.list',
    command: 'inbox list',
    description: 'Lists parked inbox items.',
    json: true,
  },
  {
    operation: 'inbox.show',
    command: 'inbox show <id>',
    description: 'Shows one parked inbox item.',
    json: true,
  },
  {
    operation: 'inbox.import',
    command: 'inbox import <id>',
    description: 'Imports a parked inbox item into the catalog.',
    json: true,
  },
  {
    operation: 'inbox.discard',
    command: 'inbox discard <id>',
    description: 'Discards a parked inbox item.',
    json: true,
  },
  {
    operation: 'tag.add',
    command: 'tag add <component>',
    description: 'Adds a tag on one component manifest.',
    json: true,
  },
  {
    operation: 'tag.remove',
    command: 'tag remove <component>',
    description: 'Removes a tag from one component manifest.',
    json: true,
  },
  {
    operation: 'tag.list',
    command: 'tag list [component]',
    description: 'Lists tags for one component or the whole catalog.',
    json: true,
  },
  {
    operation: 'collection.create',
    command: 'collection create',
    description: 'Creates a catalog collection.',
    json: true,
  },
  {
    operation: 'collection.add',
    command: 'collection add',
    description: 'Adds a component slug to a collection.',
    json: true,
  },
  {
    operation: 'collection.remove',
    command: 'collection remove',
    description: 'Removes a component slug from a collection.',
    json: true,
  },
  {
    operation: 'collection.reorder',
    command: 'collection reorder',
    description: 'Moves a slug within a collection.',
    json: true,
  },
  {
    operation: 'collection.delete',
    command: 'collection delete',
    description: 'Deletes a collection other than favorites.',
    json: true,
  },
  {
    operation: 'collection.list',
    command: 'collection list',
    description: 'Lists catalog collections.',
    json: true,
  },
  {
    operation: 'family.set',
    command: 'family set <component>',
    description: 'Assigns a component family, creating it when requested.',
    json: true,
  },
  {
    operation: 'family.list',
    command: 'family list',
    description: 'Lists taxonomy families and unassigned categories.',
    json: true,
  },
  {
    operation: 'history.list',
    command: 'history list [component]',
    description: 'Lists recent catalog changes, newest first, for the whole catalog or one component.',
    json: true,
  },
  {
    operation: 'history.undo',
    command: 'history undo',
    description: 'Rolls the whole catalog back by --steps changes or --to a commit, as a new undoable commit.',
    json: true,
  },
  {
    operation: 'history.restore',
    command: 'history restore <component>',
    description: 'Puts one component back as it was at --to <commit>, leaving the rest of the catalog alone.',
    json: true,
  },
  {
    operation: 'setup',
    command: 'setup',
    description: 'Create the catalog if absent and install the user login service that serves the catalog page.',
    json: true,
  },
  {
    operation: 'ui',
    command: 'ui',
    description: 'Serve the local catalog page on a loopback port until interrupted.',
    json: true,
  },
  {
    operation: 'ui.status',
    command: 'ui status',
    description: 'Report whether the catalog page is answering on its loopback port.',
    json: true,
  },
  {
    operation: 'ui.service.install',
    command: 'ui service install',
    description: 'Install the user login service that keeps the catalog page running.',
    json: true,
  },
  {
    operation: 'ui.service.uninstall',
    command: 'ui service uninstall',
    description: 'Remove the user login service that Blockbase installed.',
    json: true,
  },
  {
    operation: 'ui.service.status',
    command: 'ui service status',
    description: 'Report the user login service state without changing it.',
    json: true,
  },
];

export function operationDefinition(operation: OperationName): OperationDefinition | undefined {
  return OPERATION_REGISTRY.find((entry) => entry.operation === operation);
}
