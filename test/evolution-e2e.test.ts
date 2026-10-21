import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runGenomeCommand } from "../src/cli/genome-command.ts";
import {
  applyProposalFile,
  diffEvolution,
  evolveEvolution,
  planEvolution,
  scanEvolution,
} from "../src/harness/evolution/evolve.ts";
import type {
  ReviewAction,
  ReviewCompleteSummary,
  ReviewFinalAction,
  ReviewItem,
  ReviewProgress,
  ReviewUI,
} from "../src/harness/evolution/review.ts";
import { loadHarnessGenomeFile } from "../src/harness/genome-bundle.ts";
import {
  evolutionStatePaths,
  loadEvolutionState,
} from "../src/harness/evolution/state.ts";
import { createEvolutionBundle } from "./fixtures/evolution-bundle.ts";

const repository = join(import.meta.dirname, "..");

function temporary(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rsih-evolution-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSession(path: string, reference: string, baseDirectory: string): void {  mkdirSync(join(path, ".."), { recursive: true });
  const entries = [
    { type: "session", id: "session-1", cwd: "/work/project" },
    {
      type: "custom",
      customType: "rsih.genome",
      data: {
        reference,
        baseDirectory,
        genome_id: `harness:${reference}`,
        genome: { genome_id: `harness:${reference}` },
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "run the unit tests before the full suite" }],
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
            arguments: { command: "pytest tests/unit -x" },
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
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

class ScriptedReviewUI implements ReviewUI {
  actions: ReviewAction[];
  finalAction: ReviewFinalAction;
  shown: number[] = [];
  doneMessage?: string;

  constructor(actions: ReviewAction[], finalAction: ReviewFinalAction = "install") {
    this.actions = [...actions];
    this.finalAction = finalAction;
  }

  stage(): void {}
  log(): void {}
  begin(): void {}

  async showItem(item: ReviewItem, progress: ReviewProgress): Promise<ReviewAction> {
    this.shown.push(progress.position);
    return this.actions.shift() ?? "reject";
  }

  async askComment(): Promise<string | undefined> {
    return undefined;
  }

  async complete(): Promise<ReviewFinalAction> {
    return this.finalAction;
  }

  async done(message: string): Promise<void> {
    this.doneMessage = message;
  }

  close(): void {}
}

test("paperlab auto-evolve installs one revision under the same name", async (t) => {
  const root = temporary(t);
  const home = join(root, "home");
  const agentDirectory = join(home, ".rsih");
  const base = join(root, "paperlab");
  cpSync(join(repository, "config", "genomes", "paperlab"), base, { recursive: true });
  const sessions = join(root, "sessions");
  writeSession(join(sessions, "session-1.jsonl"), "paperlab", base);
  const baseGenome = loadHarnessGenomeFile(join(base, "genome.json")).genome;

  const scanned = await scanEvolution(base, {
    cwd: root,
    homeDirectory: home,
    agentDirectory,
    evidenceRoots: { rsih: [sessions] },
  });
  assert.equal(scanned.digest.signals.strong.top_signatures.length, 1);
  assert.equal(
    scanned.digest.signals.strong.top_signatures[0].signature,
    "bash|pytest|tests/*",
  );

  const patch = {
    schema_version: "1",
    base_genome_id: baseGenome.genome_id,
    base_version: baseGenome.version,
    hypothesis: "The bootstrap skill should name the evolved flow.",
    evidence_refs: ["signature:bash|pytest|tests/*"],
    operations: [
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
    ],
    expected_effect: "The next bootstrap run follows the corrected heading.",
    risks: [],
  };

  const result = await evolveEvolution(base, {
    cwd: root,
    homeDirectory: home,
    agentDirectory,
    evidenceRoots: { rsih: [sessions] },
    auto: true,
    isTTY: false,
    propose: async () => ({
      decision: "change",
      reason: "one skill heading is stale",
      patch,
    }),
  });

  assert.equal(result.status, "installed");
  assert.equal(result.version, 2);
  const active = join(home, ".rsih", "genomes", "paperlab");
  assert.equal(result.activeDirectory, active);
  const installed = loadHarnessGenomeFile(join(active, "genome.json")).genome;
  assert.equal(installed.version, 2);
  assert.deepEqual(
    installed.skills.map((skill: any) => skill.source),
    baseGenome.skills.map((skill: any) => skill.source),
    "paperlab's file-backed skills must stay file-backed",
  );
  assert.match(
    readFileSync(join(active, "skills", "experiment-bootstrap", "SKILL.md"), "utf8"),
    /\(evolved\)/,
  );

  const paths = evolutionStatePaths("paperlab", agentDirectory);
  const state = loadEvolutionState(paths.directory);
  assert.ok(state);
  assert.equal(state.last_version, 2);
  assert.equal(state.history.at(-1)?.action, "evolve");
  assert.equal(state.history.at(-1)?.version, 2);
  assert.ok(Object.keys(state.watermark.files).length > 0);
  assert.ok(existsSync(paths.indexPath));
});

test("plan writes a proposal without installing; apply installs it", async (t) => {
  const root = temporary(t);
  const home = join(root, "home");
  const agentDirectory = join(home, ".rsih");
  const base = join(root, "fixture");
  createEvolutionBundle(base);
  const sessions = join(root, "sessions");
  writeSession(join(sessions, "session-1.jsonl"), "fixture", base);
  const baseGenome = loadHarnessGenomeFile(join(base, "genome.json")).genome;

  const patch = {
    schema_version: "1",
    base_genome_id: baseGenome.genome_id,
    base_version: baseGenome.version,
    hypothesis: "The operating mode should mention measurement.",
    evidence_refs: ["signature:bash|pytest|tests/*"],
    operations: [
      {
        op: "text.patch",
        target: { component: "instructions", field: "append_system_prompt" },
        find: "Keep runs reproducible.",
        replace: "Keep runs reproducible and measured.",
      },
    ],
    expected_effect: "Future runs mention measurement.",
    risks: [],
  };

  const plan = await planEvolution(base, {
    cwd: root,
    homeDirectory: home,
    agentDirectory,
    evidenceRoots: { rsih: [sessions] },
    propose: async () => ({
      decision: "change",
      reason: "the operating mode is incomplete",
      patch,
    }),
  });

  assert.ok(plan.path && existsSync(plan.path));
  const proposal = JSON.parse(readFileSync(plan.path!, "utf8"));
  assert.equal(proposal.decision, "change");
  assert.equal(proposal.validation.ok, true);
  assert.ok(proposal.evidence.watermark);
  assert.match(proposal.diff, /- Keep runs reproducible\./);
  assert.match(proposal.diff, /\+ Keep runs reproducible and measured\./);
  assert.equal(
    existsSync(join(home, ".rsih", "genomes", "fixture")),
    false,
    "plan must not install",
  );
  const paths = evolutionStatePaths("fixture", agentDirectory);
  assert.equal(
    existsSync(join(paths.directory, "state.json")),
    false,
    "plan must not advance state",
  );

  const diff = diffEvolution(base, {
    cwd: root,
    homeDirectory: home,
    agentDirectory,
    proposal: plan.path,
  });
  assert.ok(
    diff.changes.some((change) => change.field === "append_system_prompt"),
    "diff --proposal must show the changed instruction field",
  );

  const applied = applyProposalFile(plan.path!, {
    cwd: root,
    homeDirectory: home,
    agentDirectory,
  });
  assert.equal(applied.status, "installed");
  assert.equal(applied.version, 2);
  const installed = loadHarnessGenomeFile(
    join(home, ".rsih", "genomes", "fixture", "genome.json"),
  ).genome;
  assert.equal(
    installed.append_system_prompt,
    "# Base mode\n\nKeep runs reproducible and measured.\n",
  );
  const state = loadEvolutionState(paths.directory);
  assert.ok(state);
  assert.equal(state.last_version, 2);
  assert.equal(state.history.at(-1)?.action, "evolve");
});

test("--auto rejects a weak-only proposal without installing", async (t) => {
  const root = temporary(t);
  const home = join(root, "home");
  const agentDirectory = join(home, ".rsih");
  const base = join(root, "fixture");
  createEvolutionBundle(base);
  const sessions = join(root, "sessions");
  writeSession(join(sessions, "session-1.jsonl"), "fixture", base);
  const baseGenome = loadHarnessGenomeFile(join(base, "genome.json")).genome;

  const result = await evolveEvolution(base, {
    cwd: root,
    homeDirectory: home,
    agentDirectory,
    evidenceRoots: { rsih: [sessions] },
    auto: true,
    isTTY: false,
    propose: async () => ({
      decision: "change",
      reason: "weak evidence only",
      patch: {
        schema_version: "1",
        base_genome_id: baseGenome.genome_id,
        base_version: baseGenome.version,
        hypothesis: "weak",
        evidence_refs: ["skill:not-used"],
        operations: [
          {
            op: "text.patch",
            target: { component: "instructions", field: "append_system_prompt" },
            find: "Keep runs reproducible.",
            replace: "Keep runs measured.",
          },
        ],
        expected_effect: "measured",
        risks: [],
      },
    }),
  });

  assert.equal(result.status, "no_change");
  assert.equal(result.proposal?.weak_only, true);
  assert.equal(existsSync(join(home, ".rsih", "genomes", "fixture")), false);
  const paths = evolutionStatePaths("fixture", agentDirectory);
  const state = loadEvolutionState(paths.directory);
  assert.equal(state?.history.at(-1)?.action, "no_change");
});

test("per-item review applies one item, rejects another, and creates one version", async (t) => {
  const root = temporary(t);
  const home = join(root, "home");
  const agentDirectory = join(home, ".rsih");
  const base = join(root, "fixture");
  createEvolutionBundle(base);
  const sessions = join(root, "sessions");
  writeSession(join(sessions, "session-1.jsonl"), "fixture", base);
  const baseGenome = loadHarnessGenomeFile(join(base, "genome.json")).genome;
  const ui = new ScriptedReviewUI(["apply", "reject"]);

  const result = await evolveEvolution(base, {
    cwd: root,
    homeDirectory: home,
    agentDirectory,
    evidenceRoots: { rsih: [sessions] },
    auto: false,
    isTTY: true,
    reviewUI: ui,
    propose: async () => ({
      decision: "change",
      reason: "two independent edits",
      patch: {
        schema_version: "1",
        base_genome_id: baseGenome.genome_id,
        base_version: baseGenome.version,
        hypothesis: "two edits",
        evidence_refs: ["signature:bash|pytest|tests/*"],
        operations: [
          {
            op: "text.patch",
            target: { component: "instructions", field: "append_system_prompt" },
            find: "Keep runs reproducible.",
            replace: "Keep runs reproducible and measured.",
          },
          {
            op: "text.patch",
            target: { component: "skills", entry: "beta", field: "content" },
            find: "beta body",
            replace: "beta changed",
          },
        ],
        expected_effect: "one accepted edit",
        risks: [],
      },
    }),
  });

  assert.equal(result.status, "installed");
  assert.equal(result.version, 2);
  assert.deepEqual(ui.shown, [1, 2]);
  const active = join(home, ".rsih", "genomes", "fixture");
  const installed = loadHarnessGenomeFile(join(active, "genome.json")).genome;
  assert.match(installed.append_system_prompt, /measured/);
  assert.match(readFileSync(join(active, "skills", "beta", "SKILL.md"), "utf8"), /beta body/);
  const state = loadEvolutionState(evolutionStatePaths("fixture", agentDirectory).directory);
  assert.deepEqual(state?.history.at(-1)?.changed_components, ["instructions"]);
  assert.equal(installed.version, 2, "one evolve must create exactly one revision");
});

test("the genome command dispatches versions and rollback", async (t) => {
  const root = temporary(t);
  const home = join(root, "home");
  const agentDirectory = join(home, ".rsih");
  const base = join(root, "fixture");
  createEvolutionBundle(base);
  const sessions = join(root, "sessions");
  writeSession(join(sessions, "session-1.jsonl"), "fixture", base);
  const baseGenome = loadHarnessGenomeFile(join(base, "genome.json")).genome;

  const plan = await planEvolution(base, {
    cwd: root,
    homeDirectory: home,
    agentDirectory,
    evidenceRoots: { rsih: [sessions] },
    propose: async () => ({
      decision: "change",
      reason: "change one paragraph",
      patch: {
        schema_version: "1",
        base_genome_id: baseGenome.genome_id,
        base_version: baseGenome.version,
        hypothesis: "one paragraph",
        evidence_refs: ["signature:bash|pytest|tests/*"],
        operations: [
          {
            op: "text.patch",
            target: { component: "instructions", field: "append_system_prompt" },
            find: "Keep runs reproducible.",
            replace: "Keep runs reproducible and measured.",
          },
        ],
        expected_effect: "measured runs",
        risks: [],
      },
    }),
  });
  applyProposalFile(plan.path!, { cwd: root, homeDirectory: home, agentDirectory });

  const lines: string[] = [];
  await runGenomeCommand(["genome", "versions", base, "--json"], {
    cwd: root,
    homeDirectory: home,
    agentDirectory,
    io: { log: (line: string) => lines.push(String(line)) },
  });
  const versions = JSON.parse(lines.join("\n"));
  assert.equal(versions.active.version, 2);

  // Install v3 so there is something to roll back from.
  const activeBase = join(home, ".rsih", "genomes", "fixture");
  const sessions2 = join(root, "sessions-2");
  writeSession(join(sessions2, "session-2.jsonl"), "fixture", activeBase);
  const second = await planEvolution(activeBase, {
    cwd: root,
    homeDirectory: home,
    agentDirectory,
    evidenceRoots: { rsih: [sessions2] },
    propose: async () => ({
      decision: "change",
      reason: "another paragraph",
      patch: {
        schema_version: "1",
        base_genome_id: loadHarnessGenomeFile(
          join(activeBase, "genome.json"),
        ).genome.genome_id,
        base_version: 2,
        hypothesis: "another paragraph",
        evidence_refs: ["signature:bash|pytest|tests/*"],
        operations: [
          {
            op: "text.patch",
            target: { component: "instructions", field: "append_system_prompt" },
            find: "Keep runs reproducible and measured.",
            replace: "Keep runs reproducible, measured and logged.",
          },
        ],
        expected_effect: "logged runs",
        risks: [],
      },
    }),
  });
  applyProposalFile(second.path!, { cwd: root, homeDirectory: home, agentDirectory });

  const rollbackLines: string[] = [];
  await runGenomeCommand(["genome", "rollback", base, "--to", "2"], {
    cwd: root,
    homeDirectory: home,
    agentDirectory,
    io: { log: (line: string) => rollbackLines.push(String(line)) },
  });
  assert.match(rollbackLines.join("\n"), /to v2/);
  assert.equal(
    loadHarnessGenomeFile(join(home, ".rsih", "genomes", "fixture", "genome.json")).genome
      .version,
    2,
  );

  const rolledBack = diffEvolution(activeBase, {
    cwd: root,
    homeDirectory: home,
    agentDirectory,
    to: 3,
  });
  assert.ok(
    rolledBack.changes.some((change) => change.field === "append_system_prompt"),
    "diff --to must compare the archived revision with the active Genome",
  );
});
