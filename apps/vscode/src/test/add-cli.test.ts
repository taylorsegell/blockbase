/**
 * End to end against the real CLI: import a block into a temp catalog, then run the extension's
 * plan and apply calls into a temp copy of fixture-a. Opt-in; needs `@blockbase/cli` built.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyRefusal } from "../add/addPlan";
import { BlockbaseCli } from "../cli/blockbaseCli";
import { execFileRunner } from "../cli/runner";

const repo = path.resolve(__dirname, "../../../..");
const cliEntry = path.join(repo, "packages/cli/dist/index.js");

// Opt-in: this runs the real built CLI, so it only runs when BLOCKBASE_E2E=1 (and the CLI is built).
const e2eEnabled = process["env"]["BLOCKBASE_E2E"] === "1";

describe.skipIf(!e2eEnabled || !existsSync(cliEntry))("add against the real CLI", () => {
  const root = mkdtempSync(path.join(tmpdir(), "blockbase-add-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const source = path.join(root, "glow-card");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const node = execFileRunner({ command: process.execPath, timeoutMs: 60_000 });
  // BLOCKBASE_HOME is passed through the environment of the child; the temp dir keeps ~/.blocks untouched.
  const run = (args: readonly string[]) => {
    const previous = process.env.BLOCKBASE_HOME;
    process.env.BLOCKBASE_HOME = home;
    return node([cliEntry, ...args]).finally(() => {
      if (previous === undefined) delete process.env.BLOCKBASE_HOME;
      else process.env.BLOCKBASE_HOME = previous;
    });
  };

  it("writes the planned files into the project", async () => {
    cpSync(path.join(repo, "tests/fixtures/destinations/fixture-a"), project, { recursive: true });
    mkdirSync(source);
    writeFileSync(
      path.join(source, "GlowCard.tsx"),
      "import { motion } from 'motion/react';\nexport function GlowCard() { return <motion.div className=\"bg-background p-4\" />; }\n",
    );
    const imported = await run(["import", source, "--slug", "glow-card", "--name", "Glow Card", "--json"]);
    expect(imported.exitCode).toBe(0);

    const cli = new BlockbaseCli(run);
    const plan = await cli.planAdd("cmp_local_glow-card", project);
    expect(plan.applied).toBe(false);
    expect(applyRefusal(plan)).toBeUndefined();
    expect(existsSync(path.join(project, "src/components/glow-card"))).toBe(false);

    const result = await cli.applyAdd("cmp_local_glow-card", project, plan.bundle);
    expect(result.applied).toBe(true);
    expect(result.files.map((file) => file.path)).toEqual(plan.files.map((file) => file.path));
    expect(result.dependencies.map((dep) => dep.name)).toEqual(["motion"]);
    expect(result.placement.importPath).toBe("@/components/glow-card/GlowCard");
    expect(readFileSync(path.join(project, result.files[0].path), "utf8")).toContain("motion.div");
  }, 120_000);
});
