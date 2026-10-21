import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyEvolutionPatch } from "../src/harness/evolution/apply.ts";
import { loadHarnessGenomeFile } from "../src/harness/genome-bundle.ts";
import { createEvolutionBundle } from "./fixtures/evolution-bundle.ts";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "rsih-evolution-apply-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  createEvolutionBundle(directory);
  return { directory, genome: loadHarnessGenomeFile(join(directory, "genome.json")).genome };
}

function patchFor(genome: Record<string, any>, operations: any[]) {
  return {
    schema_version: "1",
    base_genome_id: genome.genome_id,
    base_version: genome.version,
    hypothesis: "The evidence points at one local edit.",
    evidence_refs: ["signature:read:x"],
    operations,
    expected_effect: "The next run follows the edited text.",
    risks: [],
  };
}

test("text.patch edits a file-backed skill without replacing its source entry", (t) => {
  const { directory, genome } = fixture(t);
  const before = structuredClone(genome.skills[0]);
  const result = applyEvolutionPatch({ genome, baseDirectory: directory }, patchFor(genome, [
    {
      op: "text.patch",
      target: { component: "skills", entry: "alpha", field: "content" },
      find: "step one",
      replace: "step 1",
    },
  ]));

  const write = result.asset_writes.find((asset) => asset.path === "skills/alpha/SKILL.md");
  assert.ok(write);
  assert.match(write.content, /step 1\nstep two/);
  assert.match(write.content, /Keep the rest\./);
  assert.deepEqual(result.genome.skills[0], before);
  assert.deepEqual(result.changed_components, ["skills"]);
});

test("text.patch rejects zero and multiple matches", (t) => {
  const { directory, genome } = fixture(t);
  const run = (find: string) =>
    applyEvolutionPatch({ genome, baseDirectory: directory }, patchFor(genome, [
      {
        op: "text.patch",
        target: { component: "skills", entry: "alpha", field: "content" },
        find,
        replace: "changed",
      },
    ]));

  assert.throws(() => run("missing text"), /found 0/);
  assert.throws(() => run("step"), /found 2/);
  assert.throws(
    () =>
      applyEvolutionPatch({ genome, baseDirectory: directory }, patchFor(genome, [
        {
          op: "text.patch",
          target: { component: "skills", entry: "alpha", field: "content" },
          find: "step one",
          replace: "step one",
        },
      ])),
    /made no change/,
  );
});

test("instructions, memory and tools are edited at entry/field granularity", (t) => {
  const { directory, genome } = fixture(t);
  const result = applyEvolutionPatch({ genome, baseDirectory: directory }, patchFor(genome, [
    {
      op: "text.patch",
      target: { component: "instructions", field: "append_system_prompt" },
      find: "Keep runs reproducible.",
      replace: "Keep runs reproducible and measured.",
    },
    {
      op: "entry.upsert",
      target: { component: "memory", entry: "run facts belong in the run log" },
      value: { kind: "knowledge", content: "run facts belong in the run log" },
    },
    {
      op: "entry.upsert",
      target: { component: "tools", entry: "custom_tool" },
      value: {
        description: "A narrowed tool.",
        parameters: { type: "object", properties: {} },
      },
    },
  ]));

  assert.match(result.genome.append_system_prompt, /reproducible and measured/);
  assert.deepEqual(result.genome.memory.snapshot.entries, [
    { kind: "knowledge", content: "run facts belong in the run log" },
  ]);
  assert.deepEqual(result.genome.tools, [
    {
      name: "custom_tool",
      enabled: true,
      description: "A narrowed tool.",
      parameters: { type: "object", properties: {} },
    },
  ]);
  assert.deepEqual(result.changed_components, ["instructions", "memory", "tools"]);
});

test("a new file-backed skill is created through asset.create + entry.upsert", (t) => {
  const { directory, genome } = fixture(t);
  const result = applyEvolutionPatch({ genome, baseDirectory: directory }, patchFor(genome, [
    {
      op: "asset.create",
      target: {
        component: "skills",
        entry: "gamma",
        asset: "skills/gamma/SKILL.md",
      },
      content: "---\nname: gamma\ndescription: Gamma workflow.\n---\n\n# Gamma\n",
    },
    {
      op: "entry.upsert",
      target: { component: "skills", entry: "gamma" },
      value: { source: "./skills/gamma" },
    },
  ]));

  assert.deepEqual(result.genome.skills.at(-1), { source: "./skills/gamma" });
  assert.deepEqual(result.asset_writes, [
    {
      path: "skills/gamma/SKILL.md",
      content: "---\nname: gamma\ndescription: Gamma workflow.\n---\n\n# Gamma\n",
    },
  ]);
});

test("generated tools, protected removals and base mismatches are blocked", (t) => {
  const { directory, genome } = fixture(t);
  const run = (operations: any[]) =>
    applyEvolutionPatch({ genome, baseDirectory: directory }, patchFor(genome, operations));

  assert.throws(
    () =>
      run([
        {
          op: "component.set",
          target: { component: "tools" },
          value: { tools: [], generated_tools: [{ name: "x" }] },
        },
      ]),
    /Generated tools cannot be changed/,
  );

  assert.throws(
    () =>
      applyEvolutionPatch(
        { genome, baseDirectory: directory },
        {
          ...patchFor(genome, [
            {
              op: "text.set",
              target: { component: "instructions", field: "system_prompt" },
              text: "x",
            },
          ]),
          base_genome_id: "harness:other",
        },
      ),
    /targets "harness:other"/,
  );
});

test("entry.update on memory is a single-entry change and rejects no-ops", (t) => {
  const { directory, genome } = fixture(t);
  const withMemory = applyEvolutionPatch({ genome, baseDirectory: directory }, patchFor(genome, [
    {
      op: "entry.upsert",
      target: { component: "memory", entry: "old fact" },
      value: { content: "old fact" },
    },
    {
      op: "entry.upsert",
      target: { component: "memory", entry: "keep me" },
      value: { content: "keep me" },
    },
    {
      op: "entry.update",
      target: { component: "memory", entry: "old fact" },
      value: { content: "new fact" },
    },
  ]));

  assert.deepEqual(withMemory.genome.memory.snapshot.entries, [
    { kind: "knowledge", content: "new fact" },
    { kind: "knowledge", content: "keep me" },
  ]);

  assert.throws(
    () =>
      applyEvolutionPatch({ genome: withMemory.genome, baseDirectory: directory }, patchFor(genome, [
        {
          op: "entry.update",
          target: { component: "memory", entry: "new fact" },
          value: { content: "new fact" },
        },
      ])),
    /made no change/,
  );
});
