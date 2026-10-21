import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";
import {
  EVIDENCE_EVENT_SCHEMA_VERSION,
  type EvidenceEvent,
} from "../src/harness/evolution/events.ts";
import { EventIndex } from "../src/harness/evolution/index-store.ts";
import { readEvidenceFile } from "../src/harness/evolution/reader.ts";
import { scanEvidence } from "../src/harness/evolution/scan.ts";
import {
  buildEvidenceAggregates,
  isCorrectionText,
} from "../src/harness/evolution/sequences.ts";
import {
  DEFAULT_EVOLUTION_SOURCES,
  discoverEvidenceFiles,
  zstdSupported,
} from "../src/harness/evolution/sources.ts";
import {
  createWatermark,
  planEvidenceScan,
  recordFileScan,
} from "../src/harness/evolution/watermark.ts";

function temporary(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "rsih-evolution-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJsonl(path: string, entries: unknown[]) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function piFixture(path: string) {
  writeJsonl(path, [
    { type: "session", id: "session-1", cwd: "/home/dev/project" },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "run the tests" }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: "cd /home/dev/project && pytest tests/unit -x" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "ok" }],
      },
    },
  ]);
}

test("a Pi transcript becomes ordered evidence events", async () => {
  const directory = temporary(test);
  const path = join(directory, "session.jsonl");
  piFixture(path);

  const result = await readEvidenceFile(path, "rsih");
  assert.equal(result.summary.calls, 1);
  assert.equal(result.summary.userTurns, 1);
  assert.equal(result.summary.successes, 1);
  assert.equal(result.summary.failures, 0);
  assert.equal(result.summary.cwd, "/home/dev/project");
  assert.equal(result.summary.sessionId, "session-1");

  const call = result.events.find((event) => event.kind === "tool_call");
  assert.ok(call);
  assert.equal(call.tool, "bash");
  assert.equal(call.verb, "pytest");
  assert.equal(call.path_class, "tests/*");
  assert.equal(call.signature, "bash|pytest|tests/*");

  const completion = result.events.find((event) => event.kind === "tool_result");
  assert.ok(completion);
  assert.equal(completion.outcome, "ok");
  assert.equal(completion.call_id, "call-1");
});

test("a failed call is attributed to its call id", async () => {
  const directory = temporary(test);
  const path = join(directory, "session.jsonl");
  writeJsonl(path, [
    { type: "session", id: "session-2", cwd: "/home/dev/project" },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "a", name: "bash", arguments: { command: "pytest tests/a" } },
          { type: "toolCall", id: "b", name: "read", arguments: { file_path: "README.md" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "a",
        toolName: "bash",
        isError: true,
        content: "boom",
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "b",
        toolName: "read",
        isError: false,
        content: "hello",
      },
    },
  ]);

  const result = await readEvidenceFile(path, "rsih");
  assert.equal(result.summary.failures, 1);
  assert.equal(result.summary.successes, 1);
  const failed = result.events.find(
    (event) => event.kind === "tool_result" && event.call_id === "a",
  );
  const succeeded = result.events.find(
    (event) => event.kind === "tool_result" && event.call_id === "b",
  );
  assert.equal(failed?.outcome, "fail");
  assert.equal(succeeded?.outcome, "ok");
});

test("skill usage is extracted from load_skill and skill-file reads", async () => {
  const directory = temporary(test);
  const path = join(directory, "session.jsonl");
  writeJsonl(path, [
    { type: "session", cwd: "/work/proj" },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "load-1",
            name: "load_skill",
            arguments: { name: "inline-skill" },
          },
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: { file_path: "skills/paper-experiment/SKILL.md" },
          },
          {
            type: "toolCall",
            id: "read-2",
            name: "read",
            arguments: { file_path: "README.md" },
          },
        ],
      },
    },
  ]);

  const result = await readEvidenceFile(path, "rsih");
  const calls = result.events.filter((event) => event.kind === "tool_call");
  assert.equal(calls[0].skill, "inline-skill");
  assert.equal(calls[1].skill, "paper-experiment");
  assert.equal(calls[2].skill, undefined);
  assert.equal(calls[1].quote, "skills/paper-experiment/SKILL.md");
  assert.deepEqual(result.summary.skills, ["inline-skill", "paper-experiment"]);
});

test("a slash command is recorded as a weak command signal", async () => {
  const directory = temporary(test);
  const path = join(directory, "session.jsonl");
  writeJsonl(path, [
    { type: "session", cwd: "/work/proj" },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "/run all" }],
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    },
  ]);

  const result = await readEvidenceFile(path, "rsih");
  const turns = result.events.filter((event) => event.kind === "user_turn");
  assert.equal(turns[0].command, "run");
  assert.equal(turns[1].command, undefined);
});

test("rsih.genome markers segment a session by genome", async () => {
  const directory = temporary(test);
  const path = join(directory, "session.jsonl");
  writeJsonl(path, [
    { type: "session", cwd: "/work/proj" },
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "before marker" }] },
    },
    {
      type: "custom",
      customType: "rsih.genome",
      data: {
        reference: "paperlab",
        baseDirectory: "/genomes/paperlab",
        genome_id: "g1",
        genome: { genome_id: "g1" },
      },
    },
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "paperlab" }] },
    },
    {
      type: "custom",
      customType: "rsih.genome",
      data: {
        reference: "other",
        baseDirectory: "/genomes/other",
        genome_id: "g2",
        genome: { genome_id: "g2" },
      },
    },
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "other" }] },
    },
  ]);

  const result = await readEvidenceFile(path, "rsih");
  const changes = result.events.filter((event) => event.kind === "genome_change");
  assert.equal(changes.length, 2);
  const turns = result.events.filter((event) => event.kind === "user_turn");
  assert.equal(turns[0].genome_reference, undefined);
  assert.equal(turns[1].genome_reference, "paperlab");
  assert.equal(turns[1].genome_base_directory, "/genomes/paperlab");
  assert.equal(turns[2].genome_reference, "other");
  assert.deepEqual(result.summary.genomeReferences, ["other", "paperlab"]);
});

test("Claude tool results keep their own outcome signal", async () => {
  const directory = temporary(test);
  const path = join(directory, "claude.jsonl");
  writeJsonl(path, [
    {
      type: "user",
      cwd: "/home/dev/project",
      message: { role: "user", content: "run the tests" },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "git status" } }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu-1", is_error: true, content: "failed" },
        ],
      },
    },
  ]);

  const result = await readEvidenceFile(path, "claude");
  assert.equal(result.summary.calls, 1);
  assert.equal(result.summary.failures, 1);
  const call = result.events.find((event) => event.kind === "tool_call");
  const completion = result.events.find((event) => event.kind === "tool_result");
  assert.equal(call?.tool, "bash");
  assert.equal(call?.verb, "git");
  assert.equal(completion?.outcome, "fail");
});

test("Claude Desktop sdk prompts count as user turns", async () => {
  const directory = temporary(test);
  const path = join(directory, "claude-desktop.jsonl");
  writeJsonl(path, [
    {
      type: "user",
      promptSource: "sdk",
      cwd: "/home/dev/project",
      message: { role: "user", content: "a real prompt" },
    },
    {
      type: "user",
      promptSource: "system",
      message: { role: "user", content: "a system prompt" },
    },
    {
      type: "user",
      promptSource: "sdk",
      message: { role: "user", content: "<command-name>echo</command-name>" },
    },
  ]);

  const result = await readEvidenceFile(path, "claude");
  assert.equal(result.summary.userTurns, 1);
  assert.equal(result.summary.unknownTypes.prompt_source, 2);
});

test("Codex exit codes and event messages are understood", async () => {
  const directory = temporary(test);
  const path = join(directory, "codex.jsonl");
  writeJsonl(path, [
    { type: "session_meta", payload: { id: "codex-1", cwd: "/home/dev/project", source: "cli" } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "pytest tests/unit" }),
        call_id: "call-1",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "Process exited with code 1",
      },
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "run the tests" },
    },
  ]);

  const result = await readEvidenceFile(path, "codex");
  assert.equal(result.summary.calls, 1);
  assert.equal(result.summary.failures, 1);
  assert.equal(result.summary.userTurns, 1);
  const call = result.events.find((event) => event.kind === "tool_call");
  assert.equal(call?.tool, "exec_command");
  assert.equal(call?.verb, "pytest");
  assert.equal(call?.path_class, "tests/*");
});

test("Copilot execution events become calls and results", async () => {
  const directory = temporary(test);
  const path = join(directory, "events.jsonl");
  writeJsonl(path, [
    {
      type: "session.start",
      data: { context: { cwd: "/home/dev/project" }, sessionId: "copilot-1" },
    },
    {
      type: "user.message",
      data: { content: "run the tests", source: "user" },
    },
    {
      type: "tool.execution_start",
      data: { toolName: "bash", toolCallId: "call-1", arguments: { command: "pytest tests/unit" } },
    },
    {
      type: "tool.execution_complete",
      data: { toolCallId: "call-1", status: "error", error: "boom" },
    },
  ]);

  const result = await readEvidenceFile(path, "copilot");
  assert.equal(result.summary.calls, 1);
  assert.equal(result.summary.failures, 1);
  assert.equal(result.summary.userTurns, 1);
  const call = result.events.find((event) => event.kind === "tool_call");
  assert.equal(call?.tool, "bash");
  assert.equal(call?.verb, "pytest");
});

test("unknown record types are counted instead of disappearing", async () => {
  const directory = temporary(test);
  const path = join(directory, "unknown.jsonl");
  writeJsonl(path, [
    { type: "session", id: "s", cwd: "/home/dev/project" },
    { type: "mystery.event", payload: { type: "nested.mystery", message: "hello" } },
  ]);

  const result = await readEvidenceFile(path, "rsih");
  const mysteryKey = Object.keys(result.summary.unknownTypes).find((key) =>
    key.includes("mystery"),
  );
  assert.ok(mysteryKey);
  assert.equal(result.summary.unknownTypes[mysteryKey], 1);
  const other = result.events.find(
    (event) =>
      event.kind === "other" && event.raw_type?.includes("mystery"),
  );
  assert.ok(other);
});

test("correction markers do not fire on ordinary Chinese words", () => {
  assert.equal(isCorrectionText("会话是根据genome分别存储吗"), undefined);
  assert.equal(isCorrectionText("特别想用 pytest"), undefined);
  assert.equal(isCorrectionText("不对，用 pytest"), "不对");
  assert.equal(isCorrectionText("别再跑 npm test"), "别再");
  assert.equal(isCorrectionText("actually use pytest"), "actually");
});

test("machine prefixes and code fragments do not become path classes", async () => {
  const directory = temporary(test);
  const path = join(directory, "paths.jsonl");
  writeJsonl(path, [
    { type: "session", id: "s", cwd: "/home/dev/project" },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "ls-1",
            name: "bash",
            arguments: { command: "ls /mnt/c/Users/me/project/.rsih/sessions" },
          },
          {
            type: "toolCall",
            id: "py-1",
            name: "bash",
            arguments: {
              command: 'python3 -c \'d=json.load(open("/mnt/c/Users/me/x.json"))\'',
            },
          },
        ],
      },
    },
  ]);

  const result = await readEvidenceFile(path, "rsih");
  const calls = result.events.filter((event) => event.kind === "tool_call");
  assert.equal(calls[0].path_class, "project/*");
  assert.equal(calls[1].path_class, undefined);
});

test("a file watermark resumes at the last complete newline", async () => {
  const directory = temporary(test);
  const root = join(directory, "rsih-root");
  const path = join(root, "--home-dev-project--", "session.jsonl");
  piFixture(path);

  const firstDiscovery = discoverEvidenceFiles({
    sources: ["rsih"],
    roots: { rsih: [root] },
  });
  assert.equal(firstDiscovery.files.length, 1);
  const firstPlan = planEvidenceScan(firstDiscovery.files, undefined);
  assert.equal(firstPlan.plans[0].mode, "full");
  const firstRead = await readEvidenceFile(
    firstDiscovery.files[0].realPath,
    "rsih",
    firstPlan.plans[0],
  );
  let watermark = recordFileScan(createWatermark(), firstDiscovery.files[0], firstRead.summary);
  const first = watermark.files[firstDiscovery.files[0].realPath];
  assert.equal(first.line, 4);
  assert.ok(first.offset > 0);

  appendFileSync(
    path,
    `${JSON.stringify({
      type: "message",
      message: { role: "user", content: "one more test" },
    })}\n`,
  );

  const secondDiscovery = discoverEvidenceFiles({
    sources: ["rsih"],
    roots: { rsih: [root] },
  });
  const secondPlan = planEvidenceScan(secondDiscovery.files, watermark);
  assert.equal(secondPlan.plans[0].mode, "tail");
  assert.equal(secondPlan.plans[0].startLine, 5);
  const secondRead = await readEvidenceFile(
    secondDiscovery.files[0].realPath,
    "rsih",
    secondPlan.plans[0],
  );
  assert.equal(secondRead.events.length, 1);
  assert.equal(secondRead.events[0].kind, "user_turn");
  assert.equal(secondRead.events[0].line, 5);

  watermark = recordFileScan(watermark, secondDiscovery.files[0], secondRead.summary);
  assert.equal(watermark.files[secondDiscovery.files[0].realPath].line, 5);
});

test("a torn final line waits for its newline", async () => {
  const directory = temporary(test);
  const root = join(directory, "rsih-root");
  const path = join(root, "session.jsonl");
  writeJsonl(path, [{ type: "session", id: "s", cwd: "/home/dev/project" }]);
  const discovery = discoverEvidenceFiles({ sources: ["rsih"], roots: { rsih: [root] } });
  const plan = planEvidenceScan(discovery.files, undefined);
  const read = await readEvidenceFile(discovery.files[0].realPath, "rsih", plan.plans[0]);
  let watermark = recordFileScan(createWatermark(), discovery.files[0], read.summary);
  const before = watermark.files[discovery.files[0].realPath];

  appendFileSync(path, '{"type":"message","message":{"role":"user","content":"tail"}}');
  const partialDiscovery = discoverEvidenceFiles({ sources: ["rsih"], roots: { rsih: [root] } });
  const partialPlan = planEvidenceScan(partialDiscovery.files, watermark);
  assert.equal(partialPlan.plans[0].mode, "tail");
  const partialRead = await readEvidenceFile(
    partialDiscovery.files[0].realPath,
    "rsih",
    partialPlan.plans[0],
  );
  assert.equal(partialRead.events.length, 0);
  watermark = recordFileScan(watermark, partialDiscovery.files[0], partialRead.summary);
  const afterPartial = watermark.files[partialDiscovery.files[0].realPath];
  assert.equal(afterPartial.offset, before.offset);
  assert.equal(afterPartial.line, before.line);

  appendFileSync(path, "\n");
  const completedDiscovery = discoverEvidenceFiles({ sources: ["rsih"], roots: { rsih: [root] } });
  const completedPlan = planEvidenceScan(completedDiscovery.files, watermark);
  const completedRead = await readEvidenceFile(
    completedDiscovery.files[0].realPath,
    "rsih",
    completedPlan.plans[0],
  );
  assert.equal(completedRead.events.length, 1);
  assert.equal(completedRead.events[0].kind, "user_turn");
});

test("scanEvidence applies since to files that have no watermark yet", async () => {
  const directory = temporary(test);
  const root = join(directory, "rsih-root");
  const path = join(root, "session.jsonl");
  piFixture(path);
  const discovery = discoverEvidenceFiles({ sources: ["rsih"], roots: { rsih: [root] } });

  const skipped = await scanEvidence({
    files: discovery.files,
    since: Date.now() + 60_000,
  });
  assert.equal(skipped.events.length, 0);
  assert.equal(skipped.coverage.skipped.beforeSince, 1);

  const included = await scanEvidence({ files: discovery.files, since: 0 });
  assert.ok(included.events.length > 0);
  assert.equal(included.coverage.calls, 1);
});

test("scanEvidence resumes from the watermark and appends to the index", async () => {
  const directory = temporary(test);
  const root = join(directory, "rsih-root");
  const path = join(root, "session.jsonl");
  piFixture(path);
  const index = new EventIndex(join(directory, "index"));

  const firstDiscovery = discoverEvidenceFiles({ sources: ["rsih"], roots: { rsih: [root] } });
  const first = await scanEvidence({ files: firstDiscovery.files, index });
  assert.ok(first.events.length > 0);
  assert.equal(first.index?.appended, first.events.length);
  assert.equal(index.cursor(), first.events.length);

  const secondDiscovery = discoverEvidenceFiles({ sources: ["rsih"], roots: { rsih: [root] } });
  const second = await scanEvidence({
    files: secondDiscovery.files,
    watermark: first.watermark,
    index,
  });
  assert.equal(second.events.length, 0);
  assert.equal(second.coverage.skipped.unchanged, 1);
  assert.equal(second.index?.appended, 0);

  appendFileSync(
    path,
    `${JSON.stringify({
      type: "message",
      message: { role: "user", content: "after the watermark" },
    })}\n`,
  );
  const thirdDiscovery = discoverEvidenceFiles({ sources: ["rsih"], roots: { rsih: [root] } });
  const third = await scanEvidence({
    files: thirdDiscovery.files,
    watermark: second.watermark,
    index,
  });
  assert.equal(third.events.length, 1);
  assert.equal(third.events[0].kind, "user_turn");
  assert.equal(third.index?.appended, 1);
  assert.equal(index.cursor(), first.events.length + 1);
});

test("an existing watermark ignores since and still reads appended lines", async () => {
  const directory = temporary(test);
  const root = join(directory, "rsih-root");
  const path = join(root, "session.jsonl");
  piFixture(path);
  const firstDiscovery = discoverEvidenceFiles({ sources: ["rsih"], roots: { rsih: [root] } });
  const first = await scanEvidence({ files: firstDiscovery.files });

  appendFileSync(
    path,
    `${JSON.stringify({
      type: "message",
      message: { role: "user", content: "one more" },
    })}\n`,
  );
  const nextDiscovery = discoverEvidenceFiles({ sources: ["rsih"], roots: { rsih: [root] } });
  const next = await scanEvidence({
    files: nextDiscovery.files,
    watermark: first.watermark,
    since: Date.now() + 60_000,
  });
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].kind, "user_turn");
});

test("a rewritten file starts a new generation", async () => {
  const directory = temporary(test);
  const root = join(directory, "rsih-root");
  const path = join(root, "session.jsonl");
  writeJsonl(path, [{ type: "session", id: "one", cwd: "/home/dev/project" }]);
  const discovery = discoverEvidenceFiles({ sources: ["rsih"], roots: { rsih: [root] } });
  const plan = planEvidenceScan(discovery.files, undefined);
  const read = await readEvidenceFile(discovery.files[0].realPath, "rsih", plan.plans[0]);
  let watermark = recordFileScan(createWatermark(), discovery.files[0], read.summary);
  const previous = watermark.files[discovery.files[0].realPath];

  writeFileSync(path, `${JSON.stringify({ type: "session", id: "two", cwd: "/home/dev/other" })}\n`);
  const rewrittenDiscovery = discoverEvidenceFiles({ sources: ["rsih"], roots: { rsih: [root] } });
  const rewrittenPlan = planEvidenceScan(rewrittenDiscovery.files, watermark);
  assert.equal(rewrittenPlan.plans[0].mode, "full");
  assert.equal(rewrittenPlan.plans[0].generation, previous.generation + 1);
});

test("the event index deduplicates and repairs a torn write", async () => {
  const directory = temporary(test);
  const indexPath = join(directory, "index");
  const index = new EventIndex(indexPath);
  const event: EvidenceEvent = {
    schema_version: EVIDENCE_EVENT_SCHEMA_VERSION,
    session: "/tmp/session.jsonl",
    generation: 1,
    line: 1,
    seq: 0,
    source: "rsih",
    kind: "user_turn",
    quote: "hello",
  };

  assert.equal(index.append([event]).appended, 1);
  assert.equal(index.append([event]).duplicates, 1);
  assert.equal(index.readSince(0).length, 1);

  const second: EvidenceEvent = { ...event, line: 2, quote: "world" };
  const appended = index.append([second]);
  assert.equal(appended.appended, 1);
  assert.equal(index.readSince(appended.cursor - 1).length, 1);

  appendFileSync(join(indexPath, "events.jsonl"), '{"broken":');
  const reopened = new EventIndex(indexPath);
  const loaded = reopened.load();
  assert.equal(loaded.malformed, 1);
  assert.equal(loaded.repaired, true);
  assert.equal(loaded.events.length, 2);
});

test("workflow aggregates expose retries and corrections", () => {
  const session = "/tmp/session.jsonl";
  const event = (
    line: number,
    kind: EvidenceEvent["kind"],
    extra: Partial<EvidenceEvent> = {},
  ): EvidenceEvent => ({
    schema_version: EVIDENCE_EVENT_SCHEMA_VERSION,
    session,
    generation: 1,
    line,
    seq: 0,
    source: "rsih",
    kind,
    ...extra,
  });

  const events: EvidenceEvent[] = [
    event(1, "tool_call", { tool: "bash", signature: "bash|pytest|tests/*", call_id: "c1" }),
    event(2, "tool_result", { call_id: "c1", outcome: "fail" }),
    event(3, "tool_call", { tool: "bash", signature: "bash|pytest|tests/*", call_id: "c2" }),
    event(4, "tool_result", { call_id: "c2", outcome: "ok" }),
    event(5, "tool_call", { tool: "bash", signature: "bash|git|src/*", call_id: "c3" }),
    event(6, "user_turn", { quote: "不对，应该先跑 pytest" }),
    event(7, "tool_call", { tool: "bash", signature: "bash|pytest|tests/*", call_id: "c4" }),
  ];

  const aggregates = buildEvidenceAggregates(events);
  assert.equal(aggregates.outcomes.fail, 1);
  assert.equal(aggregates.outcomes.ok, 1);
  assert.equal(aggregates.outcomes.unknown, 2);
  assert.ok(
    aggregates.transitions.some(
      (item) => item.from === "bash|pytest|tests/*" && item.to === "bash|pytest|tests/*",
    ),
  );
  assert.equal(aggregates.failure_retry[0].signature, "bash|pytest|tests/*");
  assert.equal(aggregates.failure_retry[0].retries, 1);
  assert.equal(aggregates.correction_after_failure.length, 1);
  assert.equal(aggregates.correction_after_failure[0].marker, "不对");

  const repeated = buildEvidenceAggregates(
    [1, 2, 3, 4].map((line) =>
      event(line, "tool_call", {
        tool: "bash",
        signature: "bash|pytest|tests/*",
        call_id: `r${line}`,
      }),
    ),
  );
  assert.ok(repeated.repeated_sequences.length > 0);
});

test("discovery deduplicates roots and reports unknown sources", (t) => {
  const directory = temporary(t);
  const root = join(directory, "root");
  writeJsonl(join(root, "one", "session.jsonl"), [
    { type: "session", id: "s", cwd: "/home/dev/project" },
  ]);
  const discovery = discoverEvidenceFiles({
    sources: ["rsih", "typo"],
    roots: { rsih: [root, root] },
  });
  assert.equal(discovery.files.length, 1);
  assert.deepEqual(discovery.unknownSources, ["typo"]);
  assert.equal(discovery.sources.find((source) => source.id === "rsih")?.files, 1);
  assert.deepEqual([...DEFAULT_EVOLUTION_SOURCES], ["rsih"]);
});

test("Codex zstd archives are read when the runtime supports zstd", async (t) => {
  const directory = temporary(t);
  const root = join(directory, "codex");
  const path = join(root, "session.jsonl.zst");
  mkdirSync(root, { recursive: true });
  const jsonl = `${JSON.stringify({
    type: "session_meta",
    payload: { id: "zstd-1", cwd: "/home/dev/project", source: "cli" },
  })}\n${JSON.stringify({
    type: "event_msg",
    payload: { type: "user_message", message: "hello" },
  })}\n`;

  if (zstdSupported() && typeof (zlib as any).zstdCompressSync === "function") {
    writeFileSync(path, (zlib as any).zstdCompressSync(Buffer.from(jsonl)));
    const discovery = discoverEvidenceFiles({
      sources: ["codex"],
      roots: { codex: [root] },
    });
    assert.equal(discovery.files[0]?.kind, "zstd");
    const result = await readEvidenceFile(discovery.files[0].realPath, "codex");
    assert.equal(result.summary.userTurns, 1);
  } else {
    writeFileSync(path, "not-zstd");
    const discovery = discoverEvidenceFiles({
      sources: ["codex"],
      roots: { codex: [root] },
    });
    assert.equal(discovery.files[0]?.kind, "zstd");
    const result = await readEvidenceFile(discovery.files[0].realPath, "codex");
    assert.equal(result.summary.unsupported, "zstd");
  }
});
