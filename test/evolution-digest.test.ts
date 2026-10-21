import assert from "node:assert/strict";
import test from "node:test";
import {
  EVIDENCE_EVENT_SCHEMA_VERSION,
  emptyEventCounts,
  type EvidenceEvent,
} from "../src/harness/evolution/events.ts";
import {
  buildDigest,
  strongReferences,
} from "../src/harness/evolution/digest.ts";
import type { FileScanSummary } from "../src/harness/evolution/reader.ts";
import type { EvidenceScanCoverage } from "../src/harness/evolution/scan.ts";

const baseline = {
  at: 0,
  iso: new Date(0).toISOString(),
  source: "all_history" as const,
};

function summary(
  session: string,
  overrides: Partial<FileScanSummary> = {},
): FileScanSummary {
  return {
    session,
    source: "rsih",
    size: 100,
    mtimeMs: 1,
    cwd: "/work/proj",
    startOffset: 0,
    endOffset: 100,
    startLine: 1,
    endLine: 10,
    linesRead: 10,
    malformed: 0,
    calls: 0,
    userTurns: 0,
    assistantMessages: 0,
    failures: 0,
    successes: 0,
    unknownOutcomes: 0,
    eventCounts: emptyEventCounts(),
    unknownTypes: {},
    ...overrides,
  };
}

function event(
  session: string,
  line: number,
  kind: EvidenceEvent["kind"],
  extra: Partial<EvidenceEvent> = {},
): EvidenceEvent {
  return {
    schema_version: EVIDENCE_EVENT_SCHEMA_VERSION,
    session,
    generation: 1,
    line,
    seq: 0,
    source: "rsih",
    kind,
    ...extra,
  };
}

function coverage(
  overrides: Partial<EvidenceScanCoverage> = {},
): EvidenceScanCoverage {
  return {
    files: 0,
    read: 0,
    events: 0,
    skipped: { unchanged: 0, filtered: 0, unsupported: 0, beforeSince: 0 },
    filtered: [],
    unsupported: [],
    errors: [],
    unknownTypes: {},
    malformed: 0,
    calls: 0,
    userTurns: 0,
    failures: 0,
    successes: 0,
    unknownOutcomes: 0,
    ...overrides,
  };
}

function strongAndImported() {
  const events: EvidenceEvent[] = [
    event("/s1", 1, "user_turn", { quote: "run tests" }),
    event("/s1", 2, "tool_call", {
      signature: "bash|pytest|tests/*",
      call_id: "c1",
      quote: "pytest tests/unit",
      tool: "bash",
    }),
    event("/s1", 3, "tool_result", { call_id: "c1", outcome: "fail" }),
    event("/s1", 4, "user_turn", { quote: "不对，应该用 pytest" }),
    event("/s1", 5, "tool_call", {
      signature: "bash|pytest|tests/*",
      call_id: "c2",
      quote: "pytest tests/unit",
      tool: "bash",
    }),
    event("/s1", 6, "tool_result", { call_id: "c2", outcome: "ok" }),
    event("/s1", 7, "assistant_message", { quote: "assistant secret" }),
    event("/s1", 8, "other", { raw_type: "thinking", quote: "thinking secret" }),
    event("/s1", 9, "compaction"),
    event("/s2", 1, "tool_call", {
      signature: "bash|ls|src/*",
      call_id: "c3",
      quote: "ls src",
      tool: "bash",
    }),
    event("/s2", 2, "tool_result", { call_id: "c3", outcome: "ok" }),
    event("/s2", 3, "assistant_message", { quote: "imported assistant" }),
  ];
  const summaries = [
    summary("/s1", { calls: 2, userTurns: 2, failures: 1, assistantMessages: 1 }),
    summary("/s2", { calls: 1, userTurns: 0, assistantMessages: 1 }),
  ];
  return { events, summaries };
}

test("the digest splits strong, weak, context and excluded content", () => {
  const { events, summaries } = strongAndImported();
  const digest = buildDigest({
    events,
    summaries,
    coverage: coverage({ files: 2, read: 2, unknownTypes: { thinking: 1 } }),
    baseline,
    generatedAt: new Date("2026-10-20T00:00:00.000Z"),
  });

  assert.equal(digest.signals.strong.top_signatures.length, 1);
  const strong = digest.signals.strong.top_signatures[0];
  assert.equal(strong.signature, "bash|pytest|tests/*");
  assert.equal(strong.count, 2);
  assert.equal(strong.failures, 1);
  assert.equal(strong.successes, 1);
  assert.equal(strong.sessions, 1);
  assert.ok(strong.examples.length >= 1);

  assert.equal(digest.signals.strong.corrections[0].marker, "不对");
  assert.equal(digest.signals.strong.failure_retry[0].retries, 1);
  assert.ok(digest.signals.weak.imported_sessions.some((item) => item.session === "/s2"));
  assert.ok(
    digest.signals.weak.imported_signatures.some(
      (item) => item.signature === "bash|ls|src/*",
    ),
  );
  assert.equal(digest.signals.weak.compactions, 1);

  const strongSession = digest.context.sessions.find((item) => item.session === "/s1");
  const importedSession = digest.context.sessions.find((item) => item.session === "/s2");
  assert.equal(strongSession?.origin, "user");
  assert.equal(importedSession?.origin, "imported");
  assert.equal(importedSession?.in_scope, true);

  assert.equal(digest.coverage.excluded.assistant_messages, 2);
  assert.equal(digest.coverage.excluded.other_events, 1);
  assert.equal(digest.coverage.event_kinds.assistant_message, 2);
  assert.equal(digest.coverage.event_kinds.other, 1);
  assert.equal(digest.signals.weak.command_usage_signal, "unknown");
  assert.ok(
    digest.coverage.notes.some((note) => note.includes("Command usage is unknown")),
  );

  const serialized = JSON.stringify(digest);
  assert.ok(!serialized.includes("assistant secret"));
  assert.ok(!serialized.includes("thinking secret"));
  assert.ok(!serialized.includes("imported assistant"));

  const refs = strongReferences(digest);
  assert.ok(refs.has("signature:bash|pytest|tests/*"));
  assert.ok(refs.has("correction:/s1:4"));
  assert.ok(
    refs.has(
      "transition:bash|pytest|tests/*->bash|pytest|tests/*",
    ),
  );
});

test("caps are applied and reported", () => {
  const events = [
    event("/s1", 1, "user_turn", { quote: "run" }),
    event("/s1", 2, "tool_call", { signature: "bash|a|src/*", call_id: "a" }),
    event("/s1", 3, "tool_result", { call_id: "a", outcome: "ok" }),
    event("/s1", 4, "tool_call", { signature: "bash|b|src/*", call_id: "b" }),
    event("/s1", 5, "tool_result", { call_id: "b", outcome: "fail" }),
    event("/s1", 6, "user_turn", { quote: "不对，换一个" }),
    event("/s1", 7, "user_turn", { quote: "别再跑这个" }),
    event("/s1", 8, "tool_call", { signature: "bash|c|src/*", call_id: "c" }),
    event("/s1", 9, "tool_result", { call_id: "c", outcome: "ok" }),
  ];
  const digest = buildDigest({
    events,
    summaries: [summary("/s1", { calls: 3, userTurns: 3, failures: 1 })],
    coverage: coverage({ files: 1, read: 1 }),
    baseline,
    caps: { signatures: 1, corrections: 1, transitions: 1 },
  });

  assert.equal(digest.signals.strong.top_signatures.length, 1);
  assert.ok(
    digest.coverage.truncated.some(
      (item) => item.kind === "signatures" && item.dropped >= 1,
    ),
  );
  assert.equal(digest.signals.strong.corrections.length, 1);
  assert.ok(
    digest.coverage.truncated.some(
      (item) => item.kind === "corrections" && item.dropped === 1,
    ),
  );
  assert.ok(
    digest.coverage.truncated.some(
      (item) => item.kind === "transitions" && item.dropped === 1,
    ),
  );
});

test("workspace scope uses event-level cwd", () => {
  const events = [
    event("/in", 1, "user_turn", { quote: "run", cwd: "/work/proj" }),
    event("/in", 2, "tool_call", {
      signature: "bash|a|src/*",
      call_id: "a",
      cwd: "/work/proj",
    }),
    event("/out", 1, "user_turn", { quote: "run other", cwd: "/other" }),
    event("/out", 2, "tool_call", {
      signature: "bash|b|src/*",
      call_id: "b",
      cwd: "/other",
    }),
    event("/out", 3, "compaction", { cwd: "/other" }),
    event("/moved", 1, "user_turn", { quote: "moved", cwd: "/work/proj" }),
    event("/moved", 2, "tool_call", {
      signature: "bash|c|src/*",
      call_id: "c",
      cwd: "/work/proj",
    }),
    event("/sub", 1, "user_turn", { quote: "sub", cwd: "/work/proj/sub" }),
    event("/sub", 2, "tool_call", {
      signature: "bash|sub|src/*",
      call_id: "d",
      cwd: "/work/proj/sub",
    }),
    event("/similar", 1, "user_turn", {
      quote: "similar",
      cwd: "/work/project2",
    }),
    event("/similar", 2, "tool_call", {
      signature: "bash|similar|src/*",
      call_id: "e",
      cwd: "/work/project2",
    }),
  ];
  const summaries = [
    summary("/in", { calls: 1, userTurns: 1, cwd: "/work/proj" }),
    summary("/out", { calls: 1, userTurns: 1, cwd: "/other" }),
    summary("/moved", { calls: 1, userTurns: 1, cwd: "/other" }),
    summary("/sub", { calls: 1, userTurns: 1, cwd: "/work/proj/sub" }),
    summary("/similar", { calls: 1, userTurns: 1, cwd: "/work/project2" }),
  ];
  const digest = buildDigest({
    events,
    summaries,
    coverage: coverage({ files: 5, read: 5 }),
    baseline,
    workspaces: ["/work/proj"],
  });

  const out = digest.context.sessions.find((item) => item.session === "/out");
  const moved = digest.context.sessions.find((item) => item.session === "/moved");
  const sub = digest.context.sessions.find((item) => item.session === "/sub");
  const similar = digest.context.sessions.find(
    (item) => item.session === "/similar",
  );
  assert.equal(out?.in_scope, false);
  assert.equal(moved?.in_scope, true);
  assert.equal(sub?.in_scope, true);
  assert.equal(similar?.in_scope, false);
  assert.ok(
    digest.signals.strong.top_signatures.some(
      (item) => item.signature === "bash|a|src/*",
    ),
  );
  assert.ok(
    !digest.signals.strong.top_signatures.some(
      (item) => item.signature === "bash|b|src/*",
    ),
  );
  assert.ok(
    digest.signals.strong.top_signatures.some(
      (item) => item.signature === "bash|sub|src/*",
    ),
  );
  assert.ok(
    !digest.signals.strong.top_signatures.some(
      (item) => item.signature === "bash|similar|src/*",
    ),
  );
  assert.equal(digest.signals.weak.compactions, 0);
});

test("the digest filters by target Genome and reports provenance", () => {
  const events = [
    event("/paper", 1, "genome_change", {
      genome_reference: "paperlab",
      genome_base_directory: "/genomes/paperlab",
    }),
    event("/paper", 2, "user_turn", {
      quote: "run",
      genome_reference: "paperlab",
      genome_base_directory: "/genomes/paperlab",
    }),
    event("/paper", 3, "tool_call", {
      signature: "bash|paper|src/*",
      call_id: "p1",
      genome_reference: "paperlab",
      genome_base_directory: "/genomes/paperlab",
    }),
    event("/paper", 4, "tool_result", {
      call_id: "p1",
      outcome: "ok",
      genome_reference: "paperlab",
      genome_base_directory: "/genomes/paperlab",
    }),
    event("/copy", 1, "genome_change", {
      genome_reference: "paperlab",
      genome_base_directory: "/genomes/paperlab-copy",
    }),
    event("/copy", 2, "user_turn", {
      quote: "copy",
      genome_reference: "paperlab",
      genome_base_directory: "/genomes/paperlab-copy",
    }),
    event("/copy", 3, "tool_call", {
      signature: "bash|copy|src/*",
      call_id: "c1",
      genome_reference: "paperlab",
      genome_base_directory: "/genomes/paperlab-copy",
    }),
    event("/ext", 1, "user_turn", { quote: "external", source: "claude" }),
    event("/ext", 2, "tool_call", {
      signature: "bash|external|src/*",
      call_id: "e1",
      source: "claude",
    }),
  ];
  const summaries = [
    summary("/paper", {
      calls: 1,
      userTurns: 1,
      cwd: "/work/proj",
      genomeReferences: ["paperlab"],
    }),
    summary("/copy", {
      calls: 1,
      userTurns: 1,
      cwd: "/work/proj",
      genomeReferences: ["paperlab"],
    }),
    summary("/ext", {
      calls: 1,
      userTurns: 1,
      cwd: "/work/proj",
      source: "claude",
    }),
  ];
  const input = {
    events,
    summaries,
    coverage: coverage({ files: 3, read: 3 }),
    baseline,
    targetGenome: {
      reference: "paperlab",
      baseDirectory: "/genomes/paperlab",
    },
  };
  const digest = buildDigest(input);

  assert.ok(
    digest.signals.strong.top_signatures.some(
      (item) => item.signature === "bash|paper|src/*",
    ),
  );
  assert.ok(
    !digest.signals.strong.top_signatures.some(
      (item) => item.signature === "bash|copy|src/*",
    ),
  );
  assert.ok(
    !digest.signals.strong.top_signatures.some(
      (item) => item.signature === "bash|external|src/*",
    ),
  );

  const paper = digest.context.sessions.find((item) => item.session === "/paper");
  const copy = digest.context.sessions.find((item) => item.session === "/copy");
  const ext = digest.context.sessions.find((item) => item.session === "/ext");
  assert.equal(paper?.provenance, "genome");
  assert.equal(copy?.provenance, "other_genome");
  assert.equal(ext?.provenance, "external");

  assert.equal(digest.coverage.provenance.genome_changes, 2);
  assert.ok(digest.coverage.provenance.matched_events > 0);
  assert.ok(digest.coverage.provenance.other_genome_events > 0);
  assert.ok(digest.coverage.provenance.external_events > 0);
  assert.equal(digest.signals.weak.external_signatures.length, 0);

  const withExternal = buildDigest({ ...input, includeExternal: true });
  assert.ok(
    withExternal.signals.weak.external_signatures.some(
      (item) => item.signature === "bash|external|src/*",
    ),
  );
  assert.ok(
    withExternal.signals.weak.external_sessions.some(
      (item) => item.session === "/ext",
    ),
  );
  assert.ok(
    !withExternal.signals.strong.top_signatures.some(
      (item) => item.signature === "bash|external|src/*",
    ),
  );
});

test("the digest aggregates skill usage and exposes skill refs", () => {
  const events = [
    event("/s", 1, "genome_change", {
      genome_reference: "paperlab",
      genome_base_directory: "/genomes/paperlab",
    }),
    event("/s", 2, "tool_call", {
      tool: "load_skill",
      skill: "paper-experiment",
      call_id: "s1",
      quote: "paper-experiment",
    }),
    event("/s", 3, "tool_result", { call_id: "s1", outcome: "ok" }),
    event("/s", 4, "tool_call", {
      tool: "read",
      skill: "bootstrap",
      call_id: "s2",
      quote: "skills/bootstrap/SKILL.md",
    }),
    event("/s", 5, "tool_result", { call_id: "s2", outcome: "fail" }),
    event("/s", 6, "user_turn", { quote: "不对，bootstrap 又失败了" }),
    event("/s", 7, "user_turn", { quote: "/run all", command: "run" }),
  ];
  const digest = buildDigest({
    events,
    summaries: [summary("/s", { calls: 2, userTurns: 1, failures: 1 })],
    coverage: coverage({ files: 1, read: 1 }),
    baseline,
  });
  assert.equal(digest.signals.strong.skill_usage.length, 2);
  const bootstrap = digest.signals.strong.skill_usage.find(
    (item) => item.skill === "bootstrap",
  );
  assert.equal(bootstrap?.loads, 1);
  assert.equal(bootstrap?.failures, 1);
  assert.equal(bootstrap?.corrections, 1);
  const refs = strongReferences(digest);
  assert.ok(refs.has("skill:paper-experiment"));
  assert.ok(refs.has("skill_use:/s:2"));
  assert.ok(refs.has("skill:bootstrap"));
  assert.equal(digest.signals.weak.command_usage_signal, "observed");
  assert.equal(digest.signals.weak.command_usage[0].command, "run");
  assert.equal(digest.signals.weak.command_usage[0].uses, 1);
});

test("evidence_hash is stable for the same policy and input", () => {
  const { events, summaries } = strongAndImported();
  const input = {
    events,
    summaries,
    coverage: coverage({ files: 2, read: 2, unknownTypes: { thinking: 1 } }),
    baseline,
  };
  const first = buildDigest({ ...input, generatedAt: new Date(1_000) });
  const second = buildDigest({ ...input, generatedAt: new Date(9_000) });
  assert.equal(first.evidence_hash, second.evidence_hash);

  const changed = buildDigest({
    ...input,
    events: events.map((item) =>
      item.kind === "tool_call" ? { ...item, quote: "different" } : item,
    ),
    generatedAt: new Date(1_000),
  });
  assert.notEqual(first.evidence_hash, changed.evidence_hash);
});
