/** The block fields a handoff needs; catalog entries from the page, CLI and extension all fit. */
export type HandoffTarget = {
  componentId: string;
  displayName?: string;
  category?: string;
};

/**
 * Text copied as an agent handoff from the catalog page and the editor extension.
 * Pasted into an agent running in the destination project, so `--project .` is
 * that project and the lead line says what the commands are for.
 */
export function handoffText(block: HandoffTarget): string {
  const id = block.componentId;
  const name = block.displayName ? `"${block.displayName}"` : id;
  const kind = block.category ? ` (${block.category})` : '';
  return [
    `Add ${name}${kind} from my Blockbase catalog to this project. Show me the add plan before applying it.`,
    '',
    `blockbase inspect ${id} --json`,
    `blockbase adapt ${id} --project . --json`,
  ].join('\n');
}
