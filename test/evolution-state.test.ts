import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
  acquireEvolutionLock,
  createEvolutionState,
  evolutionStatePaths,
  loadEvolutionState,
  resolveBaseline,
  saveEvolutionState,
} from "../src/harness/evolution/state.ts";

function temporary(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "rsih-state-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function stateAt(baselineAt: number, source: "genome_created" | "all_history" = "genome_created") {
  return createEvolutionState({
    baseName: "paperlab",
    baseGenomeId: "harness:paperlab",
    baseContentHash: "hash",
    intent: "improve paper experiments",
    sources: ["rsih", "claude"],
    workspaces: ["/work/proj"],
    baseline: {
      at: baselineAt,
      iso: new Date(baselineAt).toISOString(),
      source,
    },
  });
}

test("baseline resolution follows explicit, state, genome, all-history", () => {
  const state = stateAt(1_000);
  assert.equal(
    resolveBaseline({ explicitSince: 5_000, state, genomeCreatedAt: 3_000 }).source,
    "explicit",
  );
  assert.equal(
    resolveBaseline({ state, genomeCreatedAt: 3_000 }).source,
    "genome_created",
  );
  assert.equal(
    resolveBaseline({ genomeCreatedAt: 3_000 }).source,
    "genome_created",
  );
  assert.equal(resolveBaseline({}).source, "all_history");

  const allHistory = stateAt(0, "all_history");
  assert.equal(resolveBaseline({ state: allHistory }).source, "all_history");
});

test("state round-trips and malformed state is rejected", (t) => {
  const directory = temporary(t);
  const state = stateAt(1_000);
  saveEvolutionState(state, directory);
  const loaded = loadEvolutionState(directory);
  assert.deepEqual(loaded, state);

  writeFileSync(join(directory, "state.json"), '{"schema_version":"1"}\n');
  assert.throws(() => loadEvolutionState(directory), /Invalid evolution state/);
});

test("state paths cannot escape the evolution directory", (t) => {
  const agentDirectory = temporary(t);
  const paths = evolutionStatePaths("../../paperlab", agentDirectory);
  const inside = relative(agentDirectory, paths.directory);
  assert.ok(inside.startsWith(`evolution`));
  assert.ok(!inside.split(/[\\/]/).includes(".."));
});

test("the lock is exclusive, releasable, and stale locks are reclaimed", (t) => {
  const directory = temporary(t);
  const first = acquireEvolutionLock(directory, { now: 1_000, staleMs: 1_000 });
  assert.throws(
    () => acquireEvolutionLock(directory, { now: 1_500, staleMs: 1_000 }),
    /holds/,
  );
  first.release();

  const second = acquireEvolutionLock(directory, { now: 1_500, staleMs: 1_000 });
  second.release();

  acquireEvolutionLock(directory, { now: 2_000, staleMs: 1_000 });
  // The lock file says 2000; a run at 3500 is stale and may reclaim it.
  const reclaimed = acquireEvolutionLock(directory, { now: 3_500, staleMs: 1_000 });
  reclaimed.release();
});
