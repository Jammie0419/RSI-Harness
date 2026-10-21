import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBaseSummary } from "../src/harness/evolution/base-summary.ts";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "rsih-base-summary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "skills", "bootstrap"), { recursive: true });
  mkdirSync(join(directory, "prompts"), { recursive: true });
  writeFileSync(
    join(directory, "skills", "bootstrap", "SKILL.md"),
    "old skill body\nstep 2",
  );
  writeFileSync(join(directory, "prompts", "run.md"), "run template body");
  return directory;
}

test("the base summary includes current skill and template bodies", (t) => {
  const directory = fixture(t);
  const summary = buildBaseSummary({
    baseDirectory: directory,
    genome: {
      genome_id: "harness:paperlab",
      version: 1,
      system_prompt: "system",
      append_system_prompt: "append",
      skills: [
        { source: "./skills/bootstrap" },
        { name: "inline", description: "small", content: "inline body" },
      ],
      prompt_templates: [{ name: "run", source: "./prompts/run.md" }],
      tools: [{ name: "bash" }],
      component_manifest: { components: [{ id: "skills" }] },
    },
  });

  const bootstrap = summary.skills.find((skill) => skill.name === "bootstrap");
  assert.equal(bootstrap?.content, "old skill body\nstep 2");
  assert.equal(bootstrap?.source, "./skills/bootstrap");
  const inline = summary.skills.find((skill) => skill.name === "inline");
  assert.equal(inline?.content, "inline body");
  const run = summary.commands.find((command) => command.name === "run");
  assert.equal(run?.content, "run template body");
  assert.equal(summary.instructions.system_prompt, "system");
  assert.deepEqual(summary.components, ["skills"]);
});

test("the base summary refuses traversal and reports omitted bodies", (t) => {
  const directory = fixture(t);
  const summary = buildBaseSummary({
    baseDirectory: directory,
    maxContentChars: 5,
    genome: {
      skills: [
        { name: "outside", source: "../outside/SKILL.md" },
        { name: "bootstrap", source: "./skills/bootstrap" },
      ],
      prompt_templates: [],
    },
  });
  const outside = summary.skills.find((skill) => skill.name === "outside");
  assert.equal(outside?.content, undefined);
  assert.ok(summary.notes.some((note) => note.includes("outside the base bundle")));
  const bootstrap = summary.skills.find((skill) => skill.name === "bootstrap");
  assert.equal(bootstrap?.content, undefined);
  assert.equal(bootstrap?.content_omitted, true);
  assert.ok(summary.notes.some((note) => note.includes("omitted")));
});
