import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAddResult, type AddResult } from "../add/addPlan";
import type { CliRunner } from "./runner";

/** Envelope schema versions this extension understands. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly string[] = ["1"];

export interface CatalogComponent {
  componentId: string;
  namespace: string;
  slug: string;
  displayName: string;
  description: string;
  category: string;
  tags: string[];
  bucket: string | null;
}

export interface CatalogCollection {
  id: string;
  title: string;
  reserved: boolean;
  slugs: string[];
}

export interface CatalogList {
  components: CatalogComponent[];
  collections: CatalogCollection[];
}

export interface SearchHit {
  componentId: string;
  namespace: string;
  slug: string;
  displayName: string;
  score: number;
  favorite: boolean;
}

export interface CatalogLocation {
  found: boolean;
  rootPath: string;
}

/** The CLI ran but returned an error envelope, unreadable output, or an unknown schema. */
export class CliCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly args: readonly string[],
  ) {
    super(message);
    this.name = "CliCommandError";
  }
}

/**
 * Typed wrapper over `blockbase <command> --json`. Every call is an argument array.
 * Add new commands (for example copy handoff or add to workspace) as methods here.
 */
export class BlockbaseCli {
  constructor(private readonly run: CliRunner) {}

  listCatalog(): Promise<CatalogList> {
    return this.call(["catalog", "list"], (data) => {
      const value = data as Partial<CatalogList>;
      if (!Array.isArray(value.components) || !Array.isArray(value.collections)) throw new Error("missing components or collections");
      return { components: value.components, collections: value.collections };
    });
  }

  search(query: string): Promise<SearchHit[]> {
    return this.call(["search", query], (data) => {
      const results = (data as { results?: unknown }).results;
      if (!Array.isArray(results)) throw new Error("missing results");
      return results as SearchHit[];
    });
  }

  locate(): Promise<CatalogLocation> {
    return this.call(["catalog", "locate"], (data) => {
      const value = data as Partial<CatalogLocation>;
      return { found: value.found === true, rootPath: String(value.rootPath ?? "") };
    });
  }

  /** `blockbase add <id> --project <folder> --dry-run --json`: the plan, nothing written. */
  planAdd(componentId: string, projectPath: string): Promise<AddResult> {
    return this.call(["add", componentId, "--project", projectPath, "--dry-run"], readAddResult);
  }

  /**
   * `blockbase add <id> --project <folder> --apply --manifest <bundle> --json`: writes the reviewed
   * bundle (not a fresh re-plan) into the folder, so core's target-changed check can fire.
   */
  async applyAdd(componentId: string, projectPath: string, bundle: unknown): Promise<AddResult> {
    const directory = await mkdtemp(join(tmpdir(), "blockbase-add-"));
    try {
      const manifest = join(directory, "bundle.json");
      await writeFile(manifest, JSON.stringify(bundle), "utf8");
      return await this.call(["add", componentId, "--project", projectPath, "--apply", "--manifest", manifest], readAddResult);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** Runs `blockbase <command> --json` and returns the validated `data` of a success envelope. */
  async call<T>(command: readonly string[], read: (data: unknown) => T): Promise<T> {
    const args = [...command, "--json"];
    const result = await this.run(args);
    let envelope: { schemaVersion?: unknown; ok?: unknown; data?: unknown; error?: { code?: string; message?: string } };
    try {
      envelope = JSON.parse(result.stdout);
    } catch {
      throw new CliCommandError(result.stderr.trim() || `blockbase ${command.join(" ")} printed no JSON (exit ${result.exitCode}).`, "INVALID_OUTPUT", args);
    }
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(String(envelope.schemaVersion))) {
      throw new CliCommandError(`Unsupported blockbase output schema ${String(envelope.schemaVersion)}; update the extension or the CLI.`, "UNSUPPORTED_SCHEMA", args);
    }
    if (envelope.ok !== true) {
      throw new CliCommandError(envelope.error?.message ?? "The command failed.", envelope.error?.code ?? "UNKNOWN", args);
    }
    try {
      return read(envelope.data);
    } catch (error) {
      throw new CliCommandError(`Unexpected output from blockbase ${command.join(" ")}: ${(error as Error).message}`, "INVALID_OUTPUT", args);
    }
  }
}
