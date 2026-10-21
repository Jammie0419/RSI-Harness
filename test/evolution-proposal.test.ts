import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "../src/model/model-runtime.ts";
import { assertJsonSchema } from "../src/core/schema.ts";
import {
  buildProposalPrompt,
  createProposalSchema,
  evaluateProposalEvidence,
  parseProposal,
  proposeWithModel,
} from "../src/harness/evolution/proposal.ts";

function validPatch(overrides: Record<string, any> = {}) {
  return {
    schema_version: "1",
    base_genome_id: "harness:paperlab",
    base_version: 1,
    hypothesis: "The bootstrap memory is stale.",
    evidence_refs: ["skill:paper-experiment"],
    operations: [
      {
        op: "entry.update",
        target: { component: "memory", entry: "old fact" },
        value: { content: "new fact" },
      },
    ],
    expected_effect: "Future sessions see the corrected fact.",
    risks: [],
    ...overrides,
  };
}

const digestLike = {
  signals: {
    strong: {
      top_signatures: [],
      skill_usage: [
        {
          skill: "paper-experiment",
          loads: 2,
          sessions: 1,
          failures: 1,
          corrections: 1,
          examples: [{ session: "/s", line: 2 }],
        },
      ],
      transitions: [],
      corrections: [],
      correction_after_failure: [],
    },
  },
} as any;

test("the proposal schema accepts both decisions", () => {
  const schema = createProposalSchema();
  assertJsonSchema({ decision: "no_change", reason: "nothing to add" }, schema);
  assertJsonSchema(
    { decision: "change", reason: "add a habit", patch: validPatch() },
    schema,
  );
});

test("parseProposal validates an EvolutionPatch and the base Genome", () => {
  const noChange = parseProposal({ decision: "no_change", reason: "thin evidence" });
  assert.equal(noChange.decision, "no_change");
  assert.equal(noChange.patch, undefined);

  const change = parseProposal(
    { decision: "change", reason: "update memory", patch: validPatch() },
    { baseGenomeId: "harness:paperlab" },
  );
  assert.equal(change.decision, "change");
  assert.equal(change.patch?.operations[0].op, "entry.update");

  assert.throws(
    () => parseProposal({ decision: "change", reason: "missing patch" }),
    /patch is required/,
  );
  assert.throws(
    () =>
      parseProposal(
        {
          decision: "change",
          reason: "wrong base",
          patch: validPatch({ base_genome_id: "harness:other" }),
        },
        { baseGenomeId: "harness:paperlab" },
      ),
    /targets harness:other/,
  );
  assert.throws(
    () =>
      parseProposal({
        decision: "change",
        reason: "bad op",
        patch: validPatch({
          operations: [
            { op: "not_a_real_op", target: { component: "memory", entry: "x" } },
          ],
        }),
      }),
    /Unknown evolution operation/,
  );
});

test("the weak-only gate distinguishes strong and weak references", () => {
  const strong = evaluateProposalEvidence(
    {
      decision: "change",
      reason: "strong",
      patch: validPatch(),
    },
    digestLike,
  );
  assert.equal(strong.weakOnly, false);
  assert.ok(strong.matched.includes("skill:paper-experiment"));

  const weak = evaluateProposalEvidence(
    {
      decision: "change",
      reason: "weak",
      patch: validPatch({ evidence_refs: ["skill:imported"] }),
    },
    digestLike,
  );
  assert.equal(weak.weakOnly, true);
  assert.deepEqual(weak.matched, []);

  const noChange = evaluateProposalEvidence(
    { decision: "no_change", reason: "none" },
    digestLike,
  );
  assert.equal(noChange.weakOnly, false);
});

test("the prompt names the strong tier and carries the intent", () => {
  const prompt = buildProposalPrompt({
    baseSummary: { genome_id: "harness:paperlab" },
    digest: digestLike,
    intent: "make paper experiments repeatable",
    history: [],
  });
  assert.ok(prompt.system.includes("signals.strong"));
  assert.ok(prompt.system.includes("EvolutionPatch"));
  assert.ok(prompt.system.includes("text.patch"));
  assert.ok(prompt.messages[0].content.includes("make paper experiments repeatable"));
});

test("proposeWithModel parses a model response through a fake model", async () => {
  const model = {
    async generateStructured() {
      return {
        value: {
          decision: "change",
          reason: "update memory",
          patch: validPatch(),
        },
      };
    },
  };
  const proposal = await proposeWithModel({
    model,
    profileId: "mock",
    prompt: { system: "", messages: [] },
    baseGenomeId: "harness:paperlab",
  });
  assert.equal(proposal.decision, "change");
});

test("proposeWithModel works through ModelRuntime's mock profile", async () => {
  const runtime = new ModelRuntime({
    profiles: { mock: { kind: "mock", model: "mock" } },
    mockResponses: {
      mock: [
        JSON.stringify({
          decision: "change",
          reason: "update memory",
          patch: validPatch(),
        }),
      ],
    },
  });
  const proposal = await proposeWithModel({
    model: runtime,
    profileId: "mock",
    prompt: { system: "", messages: [] },
    baseGenomeId: "harness:paperlab",
  });
  assert.equal(proposal.decision, "change");
  assert.equal(proposal.patch?.operations[0].op, "entry.update");
});
