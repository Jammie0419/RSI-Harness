import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyEvolutionPatch } from "../src/harness/evolution/apply.ts";
import {
  compileEvolutionBundle,
  createEvolvedGenome,
  evolutionPatchHash,
} from "../src/harness/evolution/compile.ts";
import { loadHarnessGenomeFile } from "../src/harness/genome-bundle.ts";
import { createEvolutionBundle } from "./fixtures/evolution-bundle.ts";

const repository = join(import.meta.dirname, "..");

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rsih-evolution-compile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = createEvolutionBundle(join(root, "base"));
  return {
    root,
    base,
    genome: loadHarnessGenomeFile(join(base, "genome.json")).genome,
  };
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

function compile(
  root: string,
  base: string,
  baseGenome: Record<string, any>,
  operations: any[],
  output = join(root, "next"),
) {
  const patch = patchFor(baseGenome, operations);
  const applied = applyEvolutionPatch(
    { genome: baseGenome, baseDirectory: base },
    patch,
  );
  const evolved = createEvolvedGenome(applied.genome, evolutionPatchHash(patch), 2);
  const result = compileEvolutionBundle({
    baseDirectory: base,
    outputDirectory: output,
    genome: evolved,
    changedComponents: applied.changed_components,
    assetWrites: applied.asset_writes,
    assetRemovals: applied.asset_removals,
    metadata: {
      created_at: "2026-10-21T00:00:00.000Z",
      intent: "tighten one step",
      base_name: "fixture",
      patch_hash: evolutionPatchHash(patch),
      operation_count: applied.operations.length,
      baseline_at: "2026-10-01T00:00:00.000Z",
      baseline_source: "genome_created",
    },
  });
  return { patch, applied, evolved, result };
}

test("only changed components and assets are rewritten", (t) => {
  const { root, base, genome } = fixture(t);
  const { result, evolved } = compile(root, base, genome, [
    {
      op: "text.patch",
      target: { component: "instructions", field: "append_system_prompt" },
      find: "Keep runs reproducible.",
      replace: "Keep runs reproducible and measured.",
    },
    {
      op: "text.patch",
      target: { component: "skills", entry: "alpha", field: "content" },
      find: "step one",
      replace: "step 1",
    },
  ]);

  assert.deepEqual(result.components_written.sort(), ["instructions", "skills"]);
  assert.deepEqual(
    readFileSync(join(result.directory, "components", "commands.json")),
    readFileSync(join(base, "components", "commands.json")),
    "an untouched component file must stay byte-identical",
  );
  assert.deepEqual(
    readFileSync(join(result.directory, "skills", "beta", "SKILL.md")),
    readFileSync(join(base, "skills", "beta", "SKILL.md")),
  );

  const instructions = readFileSync(
    join(result.directory, "components", "instructions.json"),
    "utf8",
  );
  assert.match(instructions, /reproducible and measured/);
  assert.match(
    readFileSync(join(result.directory, "skills", "alpha", "SKILL.md"), "utf8"),
    /step 1/,
  );

  const manifest = JSON.parse(
    readFileSync(join(result.directory, "genome.json"), "utf8"),
  );
  assert.equal(manifest.version, 2);
  assert.equal(manifest.parent_id, genome.genome_id);
  assert.equal(manifest.genome_id, evolved.genome_id);
  assert.equal(manifest.base, "default");
  assert.equal(manifest.evolution.created_at, "2026-10-21T00:00:00.000Z");
  assert.equal(manifest.evolution.baseline_source, "genome_created");
  assert.deepEqual(manifest.evolution.changed_components, ["instructions", "skills"]);
  assert.equal(manifest.evolution.operation_count, 2);

  const loaded = loadHarnessGenomeFile(join(result.directory, "genome.json")).genome;
  assert.equal(loaded.append_system_prompt, evolved.append_system_prompt);
  assert.deepEqual(loaded.skills, evolved.skills);
});

test("a component absent from the base is added with its contract", (t) => {
  const { root, base, genome } = fixture(t);
  const { result } = compile(root, base, genome, [
    {
      op: "entry.upsert",
      target: { component: "memory", entry: "keep the dataset checksum" },
      value: { kind: "knowledge", content: "keep the dataset checksum" },
    },
  ]);

  const manifest = JSON.parse(
    readFileSync(join(result.directory, "genome.json"), "utf8"),
  );
  const added = manifest.components.find((component: any) => component.id === "policies");
  assert.ok(added, "the policies component should have been added");
  assert.equal(added.source, "./components/policies.json");
  assert.equal(added.contract, "./contracts/policies.dev.md");
  assert.ok(existsSync(join(result.directory, "components", "policies.json")));

  const policies = JSON.parse(
    readFileSync(join(result.directory, "components", "policies.json"), "utf8"),
  );
  assert.deepEqual(policies.config.memory.snapshot.entries, [
    { kind: "knowledge", content: "keep the dataset checksum" },
  ]);

  const loaded = loadHarnessGenomeFile(join(result.directory, "genome.json")).genome;
  assert.deepEqual(loaded.memory.snapshot.entries, [
    { kind: "knowledge", content: "keep the dataset checksum" },
  ]);
});

test("a missing resource fails the compile and removes the staging copy", (t) => {
  const { root, base, genome } = fixture(t);
  const output = join(root, "broken");
  assert.throws(
    () =>
      compile(root, base, genome, [
        {
          op: "entry.upsert",
          target: { component: "skills", entry: "missing" },
          value: { source: "./skills/missing" },
        },
      ], output),
    /does not exist inside the new bundle/,
  );
  assert.equal(existsSync(output), false);
});

test("a changed base hash and changed generated tools are refused before copying", (t) => {
  const { root, base, genome } = fixture(t);
  const patch = patchFor(genome, [
    {
      op: "text.set",
      target: { component: "instructions", field: "system_prompt" },
      text: "replacement",
    },
  ]);
  const applied = applyEvolutionPatch({ genome, baseDirectory: base }, patch);
  const evolved = createEvolvedGenome(applied.genome, evolutionPatchHash(patch), 2);
  const output = join(root, "hash");

  assert.throws(
    () =>
      compileEvolutionBundle({
        baseDirectory: base,
        outputDirectory: output,
        genome: evolved,
        changedComponents: applied.changed_components,
        assetWrites: applied.asset_writes,
        metadata: {},
        expectedBaseContentHash: "not-the-real-hash",
      }),
    /base bundle changed/,
  );
  assert.equal(existsSync(output), false);

  const withGeneratedTools = {
    ...evolved,
    generated_tools: [
      {
        name: "custom",
        description: "x",
        container_script: { script: "echo x" },
      },
    ],
    tools: [...(evolved.tools ?? []), { name: "custom" }],
  };
  assert.throws(
    () =>
      compileEvolutionBundle({
        baseDirectory: base,
        outputDirectory: output,
        genome: withGeneratedTools,
        changedComponents: applied.changed_components,
        assetWrites: applied.asset_writes,
        metadata: {},
      }),
    /Generated tools cannot be/,
  );
});

test("manifest overrides are folded into components and removed", (t) => {
  const { root, base } = fixture(t);
  const manifestPath = join(base, "genome.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.overrides = {
    append_system_prompt: "# Overridden mode\n\nKeep runs reproducible.\n",
  };
  writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const genome = loadHarnessGenomeFile(manifestPath).genome;
  assert.match(genome.append_system_prompt, /Overridden mode/);

  const patch = patchFor(genome, [
    {
      op: "text.patch",
      target: { component: "instructions", field: "append_system_prompt" },
      find: "Keep runs reproducible.",
      replace: "Keep runs reproducible and measured.",
    },
  ]);
  const applied = applyEvolutionPatch({ genome, baseDirectory: base }, patch);
  const evolved = createEvolvedGenome(applied.genome, evolutionPatchHash(patch), 2);
  const result = compileEvolutionBundle({
    baseDirectory: base,
    outputDirectory: join(root, "override-next"),
    genome: evolved,
    changedComponents: applied.changed_components,
    assetWrites: applied.asset_writes,
    metadata: { operation_count: 1 },
  });

  const output = JSON.parse(readFileSync(join(result.directory, "genome.json"), "utf8"));
  assert.equal(output.overrides, undefined);
  assert.equal(output.base, "default");
  assert.match(
    loadHarnessGenomeFile(join(result.directory, "genome.json")).genome
      .append_system_prompt,
    /Overridden mode[\s\S]*measured/,
  );
});

test("paperlab keeps its three file-backed skills when one body changes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rsih-evolution-paperlab-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, "paperlab");
  cpSync(join(repository, "config", "genomes", "paperlab"), base, { recursive: true });
  const genome = loadHarnessGenomeFile(join(base, "genome.json")).genome;
  const originalSources = genome.skills.map((skill: any) => skill.source);

  const patch = patchFor(genome, [
    {
      op: "text.patch",
      target: {
        component: "skills",
        entry: "experiment-bootstrap",
        asset: "skills/experiment-bootstrap/SKILL.md",
      },
      find: "# Experiment bootstrap",
      replace: "# Experiment bootstrap (evolved)",
    },
  ]);
  const applied = applyEvolutionPatch({ genome, baseDirectory: base }, patch);
  const evolved = createEvolvedGenome(applied.genome, evolutionPatchHash(patch), 2);
  const result = compileEvolutionBundle({
    baseDirectory: base,
    outputDirectory: join(root, "paperlab-next"),
    genome: evolved,
    changedComponents: applied.changed_components,
    assetWrites: applied.asset_writes,
    metadata: { base_name: "paperlab", operation_count: 1 },
  });

  const loaded = loadHarnessGenomeFile(join(result.directory, "genome.json")).genome;
  assert.deepEqual(
    loaded.skills.map((skill: any) => skill.source),
    originalSources,
    "file-backed skills must stay file-backed under the same sources",
  );
  assert.equal(loaded.version, 2);
  assert.match(
    readFileSync(
      join(result.directory, "skills", "experiment-bootstrap", "SKILL.md"),
      "utf8",
    ),
    /\(evolved\)/,
  );
});

/**
 * harness-rsi is the shipped bundle whose `components/policies.json` carries
 * both the `policies` and the `memory` field, so a single-component edit must
 * keep the sibling field in that shared file.
 */
function sharedPoliciesFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rsih-evolution-shared-policies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, "harness-rsi");
  cpSync(join(repository, "config", "genomes", "harness-rsi"), base, { recursive: true });
  const genome = loadHarnessGenomeFile(join(base, "genome.json")).genome;
  return {
    root,
    base,
    genome,
    originalPolicies: JSON.parse(JSON.stringify(genome.policies)),
    originalMemoryContents: genome.memory.snapshot.entries.map(
      (entry: any) => entry.content,
    ),
  };
}

test("a memory-only edit keeps the sibling policies field in the shared component file", (t) => {
  const { root, base, genome, originalPolicies, originalMemoryContents } =
    sharedPoliciesFixture(t);
  const { result } = compile(root, base, genome, [
    {
      op: "entry.upsert",
      target: { component: "memory", entry: "sibling field survives" },
      value: { kind: "knowledge", content: "sibling field survives" },
    },
  ]);

  const written = JSON.parse(
    readFileSync(join(result.directory, "components", "policies.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(written.config).sort(), ["memory", "policies"]);
  assert.deepEqual(
    written.config.policies,
    originalPolicies,
    "a memory-only edit must not touch the sibling policies field",
  );
  assert.deepEqual(
    written.config.memory.snapshot.entries.map((entry: any) => entry.content),
    [...originalMemoryContents, "sibling field survives"],
  );

  const loaded = loadHarnessGenomeFile(join(result.directory, "genome.json")).genome;
  assert.deepEqual(loaded.policies, originalPolicies);
  assert.deepEqual(
    loaded.memory.snapshot.entries.map((entry: any) => entry.content),
    [...originalMemoryContents, "sibling field survives"],
  );
});

test("a policies-only edit keeps the sibling memory field in the shared component file", (t) => {
  const { root, base, genome, originalMemoryContents } = sharedPoliciesFixture(t);
  const nextToolPolicy = {
    ...genome.policies.tool,
    blocked_tools: [
      ...(genome.policies.tool?.blocked_tools ?? []),
      "evolved_probe_cli",
    ],
  };
  const { result } = compile(root, base, genome, [
    {
      op: "field.set",
      target: { component: "policies", field: "tool" },
      value: nextToolPolicy,
    },
  ]);

  const written = JSON.parse(
    readFileSync(join(result.directory, "components", "policies.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(written.config).sort(), ["memory", "policies"]);
  assert.deepEqual(
    written.config.memory.snapshot.entries.map((entry: any) => entry.content),
    originalMemoryContents,
    "a policies-only edit must not touch the sibling memory field",
  );
  assert.ok(written.config.policies.tool.blocked_tools.includes("evolved_probe_cli"));

  const loaded = loadHarnessGenomeFile(join(result.directory, "genome.json")).genome;
  assert.deepEqual(
    loaded.memory.snapshot.entries.map((entry: any) => entry.content),
    originalMemoryContents,
  );
  assert.ok(loaded.policies.tool.blocked_tools.includes("evolved_probe_cli"));
});
