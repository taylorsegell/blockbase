/**
 * The `data` of `blockbase add --json` (dry run or apply), validated, plus the plan preview text.
 * Only the fields the extension shows or acts on are typed; the CLI may send more.
 */

export interface AddFile {
  path: string;
  operation: string;
  contentHash: string;
  targetHash?: string;
  content?: string;
}

export interface AddDependency {
  name: string;
  range: string;
  kind: string;
}

export interface AddResult {
  applied: boolean;
  componentId: string;
  projectPath: string;
  files: AddFile[];
  dependencies: AddDependency[];
  dependencyConflicts: string[];
  placement: { directory: string; importPath: string };
  residuals: string[];
  warnings: string[];
  risk: string;
  validationCommands: string[];
  blocked: string[];
  /** The CLI's bundle exactly as sent (full file content), so apply can reuse the reviewed plan. */
  bundle: unknown;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} is not a list`);
  return value.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`missing ${name}`);
  return value;
}

/** Mirrors core's `safeRelative`, plus backslash and drive-letter paths: a file path must stay inside the project. */
function safePath(value: string, name: string): string {
  const unsafe =
    value === "" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((segment) => segment === "..");
  if (unsafe) throw new Error(`unsafe file path in ${name}: ${JSON.stringify(value)}`);
  return value;
}

export function readAddResult(data: unknown): AddResult {
  if (!isObject(data) || !isObject(data.bundle)) throw new Error("missing bundle");
  const bundle = data.bundle;
  const plan = isObject(data.plan) ? data.plan : {};
  if (!Array.isArray(bundle.files)) throw new Error("missing bundle.files");
  const files = bundle.files.map((entry, index): AddFile => {
    if (!isObject(entry)) throw new Error(`bundle.files[${index}] is not an object`);
    return {
      path: safePath(text(entry.path, `bundle.files[${index}].path`), `bundle.files[${index}].path`),
      operation: text(entry.operation, `bundle.files[${index}].operation`),
      contentHash: text(entry.contentHash, `bundle.files[${index}].contentHash`),
      targetHash: typeof entry.targetHash === "string" ? entry.targetHash : undefined,
      content: typeof entry.content === "string" ? entry.content : undefined,
    };
  });
  const delta = isObject(bundle.dependencyDelta) ? bundle.dependencyDelta : {};
  const dependencies = (Array.isArray(delta.add) ? delta.add : []).map((entry): AddDependency => {
    if (typeof entry === "string") return { name: entry, range: "*", kind: "runtime" };
    if (!isObject(entry)) throw new Error("dependencyDelta.add has a bad entry");
    return { name: text(entry.name, "dependency name"), range: String(entry.range ?? "*"), kind: String(entry.kind ?? "runtime") };
  });
  const placement = isObject(bundle.placement) ? bundle.placement : {};
  return {
    applied: data.applied === true,
    componentId: String(bundle.componentId ?? ""),
    projectPath: String(bundle.projectPath ?? ""),
    files,
    dependencies,
    dependencyConflicts: strings(delta.conflicts, "dependencyDelta.conflicts"),
    placement: { directory: String(placement.directory ?? ""), importPath: String(placement.importPath ?? "") },
    residuals: strings(bundle.residuals, "residuals"),
    warnings: strings(bundle.warnings, "warnings"),
    risk: String(bundle.risk ?? "unknown"),
    validationCommands: strings(bundle.validationCommands, "validationCommands"),
    blocked: strings(plan.blocked, "plan.blocked"),
    bundle,
  };
}

/**
 * Files the apply would change that already hold different content. Applying over them would
 * lose local edits, so the extension refuses. A `replace` with the same hash is a no-op and allowed.
 */
export function collisions(result: AddResult): AddFile[] {
  return result.files.filter((file) => file.operation !== "create" && file.targetHash !== file.contentHash);
}

/** Why the plan cannot be applied, or undefined when it can. */
export function applyRefusal(result: AddResult): string | undefined {
  if (result.blocked.length > 0) return `Blockbase blocked this add: ${result.blocked.join("; ")}`;
  if (result.files.length === 0) return "The plan writes no files.";
  const clashing = collisions(result);
  if (clashing.length > 0) {
    return `These files already exist with different content and would be overwritten: ${clashing.map((file) => file.path).join(", ")}. Move or delete them first.`;
  }
  return undefined;
}

const code = (value: string) => "`" + value.replace(/`/g, "'") + "`";
const md = (value: string) => value.replace(/([\\`*_[\]<>#|])/g, "\\$1");

/** The readable plan shown before apply: files, dependencies, risk, residuals and validation commands. */
export function renderPlanMarkdown(result: AddResult, blockName: string, folderName: string): string {
  const lines: string[] = [];
  lines.push(`# Add ${md(blockName)} to ${md(folderName)}`, "");
  lines.push("Nothing has been written yet. Review the plan, then confirm in the dialog.", "");
  const refusal = applyRefusal(result);
  if (refusal) lines.push(`> **Cannot apply:** ${md(refusal)}`, "");

  lines.push(`**Risk:** ${md(result.risk)}`, "");
  lines.push(`**Import:** ${code(result.placement.importPath)} (folder ${code(result.placement.directory)})`, "");

  lines.push(`## Files (${result.files.length})`, "");
  for (const file of result.files) {
    const note = file.operation === "create" ? "new" : file.targetHash === file.contentHash ? "unchanged" : "overwrites existing file";
    lines.push(`- ${code(file.path)} (${note})`);
  }
  lines.push("");

  lines.push("## Dependencies to install", "");
  if (result.dependencies.length === 0) lines.push("None.");
  for (const dep of result.dependencies) lines.push(`- ${code(`${dep.name}@${dep.range}`)}${dep.kind === "development" ? " (dev)" : ""}`);
  if (result.dependencies.length > 0) lines.push("", "Blockbase does not install these. Add them with your package manager after applying.");
  for (const conflict of result.dependencyConflicts) lines.push(`- Conflict: ${md(conflict)}`);
  lines.push("");

  lines.push("## Residuals (needs a human)", "");
  if (result.residuals.length === 0) lines.push("None.");
  for (const residual of result.residuals) lines.push(`- ${md(residual)}`);
  lines.push("");

  if (result.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of result.warnings) lines.push(`- ${md(warning)}`);
    lines.push("");
  }

  lines.push("## Validate after applying", "");
  if (result.validationCommands.length === 0) lines.push("None suggested.");
  for (const command of result.validationCommands) lines.push(`- ${code(command)}`);
  lines.push("");

  for (const file of result.files) {
    if (file.content === undefined) continue;
    const fence = file.content.includes("```") ? "````" : "```";
    const language = file.path.split(".").pop() ?? "";
    lines.push(`### ${code(file.path)}`, "", fence + language, file.content.replace(/\n$/, ""), fence, "");
  }
  return lines.join("\n");
}
