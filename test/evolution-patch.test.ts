import assert from "node:assert/strict";
import test from "node:test";
import { assertJsonSchema } from "../src/core/schema.ts";
import { PROTECTED_BUILTIN_TOOL_NAMES } from "../src/harness/genome.ts";
import { HARNESS_COMPONENT_IDS } from "../src/harness/genome-bundle.ts";
import {
  EVOLUTION_COMPONENT_IDS,
} from "../src/harness/evolution/components.ts";
import {
  createEvolutionPatchSchema,
  isWideEvolutionOperation,
  validateEvolutionPatch,
} from "../src/harness/evolution/patch.ts";

function validPatch(overrides: Record<string, any> = {}) {
  return {
    schema_version: "1",
    base_genome_id: "harness:paperlab",
    base_version: 1,
    base_content_hash: "hash",
    hypothesis: "The bootstrap skill needs one corrected step.",
    evidence_refs: ["skill_use:/sessions/a.jsonl:12"],
    operations: [
      {
        op: "text.patch",
        target: {
          component: "skills",
          entry: "experiment-bootstrap",
          asset: "skills/experiment-bootstrap/SKILL.md",
        },
        find: "old step",
        replace: "new step",
      },
      {
        op: "entry.update",
        target: { component: "memory", entry: "old fact" },
        value: { content: "new fact" },
      },
      {
        op: "component.set",
        target: { component: "model" },
        value: { id: "provider/model" },
      },
    ],
    expected_effect: "The next bootstrap run follows the corrected step.",
    risks: ["The skill wording may be project-specific."],
    ...overrides,
  };
}

test("a valid EvolutionPatch carries all component levels", () => {
  const patch = validateEvolutionPatch(validPatch());
  assert.equal(patch.operations.length, 3);
  assert.equal(patch.operations[0].op, "text.patch");
  assert.equal(patch.operations[0].expected_occurrences, 1);
  assert.equal(patch.operations[1].op, "entry.update");
  assert.equal(patch.operations[2].op, "component.set");
  assert.equal(isWideEvolutionOperation(patch.operations[0]), false);
  assert.equal(isWideEvolutionOperation(patch.operations[1]), false);
  assert.equal(isWideEvolutionOperation(patch.operations[2]), true);
});

test("the EvolutionPatch JSON schema accepts the same patch", () => {
  assertJsonSchema(validPatch(), createEvolutionPatchSchema());
});

test("the evolution component map covers every core component", () => {
  for (const id of HARNESS_COMPONENT_IDS) {
    assert.ok(
      (EVOLUTION_COMPONENT_IDS as readonly string[]).includes(id),
      `missing core component ${id}`,
    );
  }
});

test("every core protected tool is rejected for entry.remove", () => {
  for (const name of PROTECTED_BUILTIN_TOOL_NAMES) {
    assert.throws(
      () =>
        validateEvolutionPatch(
          validPatch({
            operations: [
              { op: "entry.remove", target: { component: "tools", entry: name } },
            ],
          }),
        ),
      /Protected tool/,
      name,
    );
  }
});

test("invalid targets and operations are rejected", () => {
  assert.throws(
    () =>
      validateEvolutionPatch(
        validPatch({
          operations: [
            { op: "entry.remove", target: { component: "generated_tools" } },
          ],
        }),
      ),
    /Unknown evolution component/,
  );
  assert.throws(
    () =>
      validateEvolutionPatch(
        validPatch({
          operations: [
            { op: "entry.update", target: { component: "instructions", entry: "x" }, value: {} },
          ],
        }),
      ),
    /does not have named entries/,
  );
  assert.throws(
    () =>
      validateEvolutionPatch(
        validPatch({
          operations: [
            { op: "entry.update", target: { component: "memory" }, value: {} },
          ],
        }),
      ),
    /requires target.entry/,
  );
  assert.throws(
    () =>
      validateEvolutionPatch(
        validPatch({
          operations: [
            {
              op: "asset.create",
              target: {
                component: "skills",
                entry: "x",
                asset: "C:\\absolute\\SKILL.md",
              },
              content: "body",
            },
          ],
        }),
      ),
    /must be relative/,
  );
  assert.throws(
    () =>
      validateEvolutionPatch(
        validPatch({
          operations: [
            {
              op: "asset.create",
              target: { component: "skills", entry: "x", asset: "../outside/SKILL.md" },
              content: "body",
            },
          ],
        }),
      ),
    /may not escape/,
  );
  assert.throws(
    () =>
      validateEvolutionPatch(
        validPatch({
          operations: [
            {
              op: "text.patch",
              target: { component: "skills", entry: "x", asset: "skills/x/SKILL.md" },
              find: "",
              replace: "new",
            },
          ],
        }),
      ),
    /find must be a non-empty string/,
  );
  assert.throws(
    () =>
      validateEvolutionPatch(
        validPatch({
          operations: [
            {
              op: "text.patch",
              target: { component: "skills", entry: "x", asset: "skills/x/SKILL.md" },
              find: "old",
              replace: "new",
              expected_occurrences: 0,
            },
          ],
        }),
      ),
    /positive integer/,
  );
  assert.throws(
    () =>
      validateEvolutionPatch(
        validPatch({
          operations: [
            {
              op: "field.set",
              target: { component: "skills", entry: "x", field: "nope" },
              value: 1,
            },
          ],
        }),
      ),
    /not editable/,
  );
  assert.throws(
    () =>
      validateEvolutionPatch(
        validPatch({
          operations: [
            {
              op: "text.set",
              target: { component: "tools", entry: "bash", field: "description" },
              text: "new",
            },
          ],
        }),
      ),
    /does not have patchable text/,
  );
  assert.throws(
    () =>
      validateEvolutionPatch(
        validPatch({
          operations: [
            {
              op: "component.set",
              target: { component: "model", entry: "x" },
              value: {},
            },
          ],
        }),
      ),
    /may not set entry/,
  );
});

test("wide operations are classified for review", () => {
  const widen = (operation: any) =>
    isWideEvolutionOperation(validateEvolutionPatch(validPatch({ operations: [operation] })).operations[0]);
  assert.equal(
    widen({ op: "text.set", target: { component: "instructions", field: "append_system_prompt" }, text: "x" }),
    true,
  );
  assert.equal(
    widen({ op: "entry.upsert", target: { component: "skills", entry: "x" }, value: { content: "x" } }),
    true,
  );
  assert.equal(
    widen({ op: "entry.remove", target: { component: "skills", entry: "x" } }),
    true,
  );
  assert.equal(
    widen({ op: "asset.remove", target: { component: "skills", entry: "x", asset: "skills/x/SKILL.md" } }),
    true,
  );
  assert.equal(
    widen({ op: "field.set", target: { component: "model", field: "id" }, value: "x" }),
    true,
  );
  assert.equal(
    widen({ op: "text.patch", target: { component: "instructions", field: "system_prompt" }, find: "a", replace: "b" }),
    false,
  );
});
