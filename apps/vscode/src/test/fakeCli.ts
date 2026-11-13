/** Fake CLI runner for tests, answering with envelopes recorded from a real temp-catalog run. */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CliResult, CliRunner } from "../cli/runner";

export function fixture(name: string): string {
  return readFileSync(path.resolve(__dirname, "fixtures", name), "utf8");
}

export type FakeAnswer = CliResult | Error | ((args: readonly string[]) => CliResult);

/** Answers by command prefix (`catalog list`, `search`, ...); records every argument array. */
export function fakeRunner(answers: Record<string, FakeAnswer>): CliRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = async (args: readonly string[]) => {
    calls.push([...args]);
    const key = Object.keys(answers)
      .sort((a, b) => b.length - a.length)
      .find((prefix) => args.join(" ").startsWith(prefix));
    if (!key) throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(args) : answer;
  };
  return Object.assign(runner, { calls });
}

export const ok = (stdout: string): CliResult => ({ exitCode: 0, stdout, stderr: "" });

/** Recorded envelopes: one imported block, tagged, in Favorites, plus an empty Ideas collection. */
export const recorded = {
  list: () => ok(fixture("catalog-list.json")),
  search: () => ok(fixture("search.json")),
  searchEmpty: () => ok(fixture("search-empty.json")),
  locate: () => ok(fixture("catalog-locate.json")),
};
