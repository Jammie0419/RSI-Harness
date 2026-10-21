# Genome Evolution

[简体中文](genome_evolution.zh-CN.md)

Incremental, evidence-driven evolution of an **existing** Genome.

A normal `rsih` run uses a Genome. This subsystem reads what happened in sessions
that belong to that Genome, asks a model for a small set of edits, lets a human
review them, and materializes the accepted edits as the next revision of the same
Genome. The name does not change, the old revision is archived, and the new one can
be rolled back.

The subsystem is deliberately independent of the core `HarnessPatch` vocabulary
(`PATCH_OPERATIONS`, `applyHarnessPatch`, `harnessPatchSchema`). It owns its own
`EvolutionPatch`, its own apply engine and its own compiler, and only calls the core
loader/settings/complexity validators read-only at the end. Normal RSIH behavior is
unchanged unless one of the commands below runs.

## Commands

All commands live under `rsih genome`:

```bash
# Inspect new evidence only. No model, no state/index writes, no installation.
rsih genome scan paperlab
rsih genome scan paperlab --workspaces /work/proj --json

# Ask the model for a proposal, validate it by compiling to staging, save it.
# Does not install and does not advance the evidence state.
rsih genome plan paperlab --config providers.json --intent "make smoke tests stricter"

# Install a proposal that was saved by plan (or saved from review). No model call.
rsih genome apply ~/.rsih/evolution/paperlab/proposals/2026-10-21T10-00-00-000Z.json

# Review, compile, validate and install. One command creates at most one revision.
rsih genome evolve paperlab --config providers.json --intent "..."

# Same flow on a TTY, but no questions; validation still gates every item.
rsih genome evolve paperlab --auto --config providers.json

# Read-only comparisons.
rsih genome diff paperlab --to 1
rsih genome diff paperlab --proposal <proposal.json>

# Version history and rollback.
rsih genome versions paperlab
rsih genome rollback paperlab --to 1
```

### TTY behavior

| Situation | Behavior |
| --- | --- |
| `evolve` on a TTY | Enters the TUI, shows `baseline → scan → digest → model → proposal → review → compile → validate → install`, reviews each operation individually. |
| `evolve --auto` on a TTY | Uses the same pages and shows each change, but applies every item automatically. |
| `evolve` without a TTY | Equivalent to `plan`: writes a proposal and exits without installing. |
| `evolve --auto` without a TTY | Runs the full pipeline and installs. |
| `scan` / `plan` / `apply` / `diff` / `versions` / `rollback` | Text or `--json` output; no TUI. |

Review keys: `a` Apply, `r` Reject, `c` Comment, `d` Details, `q` Cancel.

## Pipeline

```text
resolve base Genome
        │
        ├─ baseline: --since → state → manifest evolution.created_at → all history
        │
        ├─ discover/read transcripts (rsih.genome marker, full stream, offsets)
        │
        ├─ evidence index + watermark
        │
        ├─ digest: strong / weak / context / coverage / excluded
        │
        ├─ base summary: current skill/template bodies + component metadata
        │
        ├─ proposal model → EvolutionPatch
        │
        ├─ per-item review → working set
        │
        ├─ compile: copy base, rewrite only changed components/assets
        │
        ├─ validate: semantic equality, resources, complexity, generated tools
        │
        └─ archive old revision → atomic swap → save state/history
```

`scan` stops after the digest. `plan` stops after writing the proposal. `apply`
skips evidence/model/review and starts from a saved proposal.

## Module map

| File | Responsibility |
| --- | --- |
| `events.ts` | Normalized `EvidenceEvent` schema and source ids. |
| `sources.ts` | Discovers RSIH/Pi/Claude/Codex/Copilot transcript files. Defaults to `rsih` only. |
| `reader.ts` | Full-stream JSONL reader, Pi/Claude/Codex/Copilot adapters, `rsih.genome` markers, skill/command extraction. |
| `watermark.ts` | Per-file size/mtime/offset/line/generation state; scan planning. |
| `index-store.ts` | Append-only `events.jsonl` with dedupe and cursor repair. |
| `scan.ts` | End-to-end file scan; isolates read errors and never advances a failed file. |
| `sequences.ts` | Transitions, retries, corrections, repeated sequences, session shapes. |
| `state.ts` | `state.json`: baseline, watermark, index cursor, history, single-writer lock. |
| `digest.ts` | Deterministic evidence digest and provenance; strong/weak gates. |
| `base-summary.ts` | Current skill/template bodies for fine-grained `find` text; 60k default cap. |
| `proposal.ts` | Proposal schema, prompt, parsing, weak-only check, model call wrapper. |
| `model.ts` | Provider profile resolution (`--config` / `--profile`). |
| `patch.ts` | `EvolutionPatch` schema, target validation, wide-operation classification. |
| `components.ts` | Evolution's local component/field/asset map; parity-tested against core. |
| `apply.ts` | Applies operations to an in-memory working model; produces asset writes/removals. |
| `compile.ts` | Materializes the working model into a self-contained v3 bundle; read-only core validation. |
| `versions.ts` | Archive, atomic install, version listing, rollback. |
| `review.ts` | Per-item review state machine; terminal and plain adapters. |
| `evolve.ts` | Orchestrates scan/plan/evolve/apply/diff/versions/rollback. |
| `src/cli/evolution-command.ts` | Parses the `rsih genome` evolution subcommands. |

`src/cli/genome-command.ts` dynamic-imports the evolution CLI only when the command
name matches. A normal session never loads these modules.

## Evidence and provenance

RSIH writes a custom session marker at session start:

```json
{
  "type": "custom",
  "customType": "rsih.genome",
  "data": {
    "reference": "paperlab",
    "baseDirectory": "C:\\Users\\...\\.rsih\\genomes\\paperlab",
    "genome_id": "harness:...",
    "genome": { "...": "snapshot" }
  }
}
```

- TUI, print, JSON and RPC runs all write it.
- `/switch-genome` appends a new marker; the reader segments the file, so one
  transcript can contain evidence for several Genomes.
- Matching uses the stable reference or the marker's `baseDirectory` realpath, so
  sessions from earlier revisions still count. `genome_id` is available but not used
  for default lineage matching.
- The default source is `rsih`. Pi/Claude/Codex/Copilot are opt-in via
  `--sources pi,claude,...` and are marked external/weak.
- Sessions without a marker are `unattributed` and excluded unless an external
  source was explicitly requested.

### Baseline

`--since` is optional. The first run that has no state uses:

1. `--since`, if provided;
2. the state's `baseline_at`;
3. the manifest's `evolution.created_at`;
4. all history.

The bundle's filesystem birthtime is deliberately not used: copying or reinstalling
changes it.

`--workspaces` accepts comma-separated roots. A root includes its subdirectories;
`/work/proj` includes `/work/proj/sub` but not `/work/project2`. Windows paths
compare case-insensitively.

## What `scan`, `plan`, `evolve` and `apply` write

| Command | Reads transcripts | Appends `events.jsonl` | Writes proposal | Saves state/watermark | Installs |
| --- | --- | --- | --- | --- | --- |
| `scan` | yes | no | no | no | no |
| `plan` | yes | yes | yes | no | no |
| `evolve` | yes | yes | on no-change/save | only on success | on accepted changes |
| `apply` | no | no | no | yes | yes |

`scan` is read-only on purpose: looking at evidence must not consume it. `plan`'s
index append is an evidence cache, not a consumption cursor; the state watermark is
what decides what is re-read. A failed plan/evolve never advances the watermark, so
the next run covers the same interval again.

## EvolutionPatch

```jsonc
{
  "schema_version": "1",
  "base_genome_id": "harness:...",
  "base_version": 1,
  "base_content_hash": "...",
  "hypothesis": "One step is wrong.",
  "evidence_refs": ["skill_use:/sessions/a.jsonl:12"],
  "operations": [
    {
      "op": "text.patch",
      "target": {
        "component": "skills",
        "entry": "experiment-bootstrap",
        "field": "content"
      },
      "find": "old step",
      "replace": "new step",
      "expected_occurrences": 1
    }
  ],
  "expected_effect": "The next bootstrap run follows the corrected step.",
  "risks": []
}
```

Target:

```ts
{
  component: "instructions" | "skills" | "tools" | "commands" | "memory"
           | "policies" | "runtime" | "integrations" | "model"
           | "appearance" | "settings" | "keybindings" | "resources";
  entry?: string;   // skill/tool/template/memory key/MCP server name
  field?: string;   // description/content/enabled/...
  asset?: string;   // skills/<name>/SKILL.md, prompts/<name>.md, ...
}
```

Operations:

| Operation | Granularity | Notes |
| --- | --- | --- |
| `text.patch` | exact `find`/`replace` | `expected_occurrences` defaults to 1; 0 or multiple matches fail. |
| `text.append` | append to a field/asset | |
| `text.set` | whole text replacement | wide |
| `entry.update` | one entry's fields | |
| `entry.upsert` | add or replace one entry | wide |
| `entry.remove` | remove one entry | protected tools cannot be removed |
| `asset.create` | new file | fails if it already exists |
| `asset.remove` | delete a file/directory | wide |
| `field.set` | one component field | review-only components are wide |
| `component.set` | whole component | wide; generated tools still blocked |

### File-backed skills

Representation is preserved. A file-backed skill stays file-backed:

- edit a body: `text.patch` with
  `target: {component:"skills", entry:"<name>", field:"content"}` (or `asset:
  "skills/<name>/SKILL.md"`);
- edit frontmatter: `entry.update` / `field.set` with `description`;
- create a new file-backed skill:

```jsonc
[
  {
    "op": "asset.create",
    "target": { "component": "skills", "entry": "new-skill", "asset": "skills/new-skill/SKILL.md" },
    "content": "---\nname: new-skill\ndescription: ...\n---\n\n# ...\n"
  },
  {
    "op": "entry.upsert",
    "target": { "component": "skills", "entry": "new-skill" },
    "value": { "source": "./skills/new-skill" }
  }
]
```

`source` is accepted on `entry.upsert` for skills/commands. It is not accepted by
`field.set`; changing representation is an explicit upsert.

Memory entries have no stable id. `entry.update` / `entry.remove` use the entry's
exact current `content` as the matching key; duplicate content is ambiguous and is
rejected.

Generated tools are hard-blocked in both apply and compile. Protected built-in tools
can be disabled but not removed.

## Review

Each patch operation is one review item. The counters are **per item**:

- `applyFailures`: max 3 Apply validation failures. After 3, Apply is blocked locally
  and the item must be rejected or revised.
- `revisionRounds`: max 3 Comment revisions. A submitted comment consumes a round
  even if the model's revision fails; cancelling the comment box does not.
- A successful revision resets `applyFailures` (the operation is new) but does not
  reset `revisionRounds`.
- `Comment` revises only the current item; other items and already applied items are
  untouched.
- In `--auto`, there is no Comment. The first Apply failure rejects that item.

The final accepted set is compiled once. One `evolve` command therefore creates at
most one revision, even though items were applied individually.

## Validation and hard blocks

Before installation, `compile.ts`:

1. copies the base bundle to staging and removes `.rsih-seed.json`;
2. rewrites only components whose fields changed;
3. writes changed asset files and new component files with contracts;
4. updates `genome.json` (`version + 1`, `parent_id`, new `genome_id`, `evolution`
   metadata);
5. loads the result with the core loader;
6. requires semantic equality with the working model (excluding `component_manifest`);
7. checks skills/templates/extensions/themes are relative and exist inside the
   bundle;
8. checks `DEFAULT_HARNESS_COMPLEXITY_LIMITS`;
9. confirms generated tools did not change;
10. checks the base content hash if a proposal was pinned to one.

Any failure deletes staging and leaves the active Genome untouched.

## Versions and rollback

```text
~/.rsih/genomes/paperlab/                     active, name never changes
~/.rsih/evolution/paperlab/
├── state.json                               baseline, watermark, cursor, history
├── events.jsonl                             append-only evidence index
├── proposals/<timestamp>.json               saved proposals
└── versions/
    ├── 1/                                   complete bundle
    └── 2/                                   complete bundle
```

- Revisions are integers (`1, 2, 3...`); `paperlab-v2` is never created.
- Installing archives the current active bundle first, then atomically replaces it.
- `versions` lists the active revision and every archive.
- `rollback --to N` archives the current revision, then restores `N` from its archive.
  The archive is copied, not moved, so it remains available.
- `nextEvolutionVersion` takes the maximum of the active and archived revisions plus
  one, so evolving after a rollback does not collide with an archive.

## Decoupling from core RSIH

- No changes to `PATCH_OPERATIONS`, `applyHarnessPatch`, `harnessPatchSchema`,
  `COMPONENT_OPERATIONS`, existing extensions or the normal session path.
- `EvolutionPatch`, `applyEvolutionPatch` and the compiler are evolution-owned.
- Core calls are read-only: `loadHarnessGenomeFile`, `validateHarnessGenome`,
  `projectGenomeSettings` / `mergeManagedSettings`, `assertHarnessComplexity`.
- The CLI is dynamically imported only for evolution subcommands.
- `components.ts` is parity-tested against the core component list; adding a core
  component requires updating that map and its tests.

## Tests

```bash
npm run typecheck
npm test
npm run check        # typecheck + test + build
```

Relevant suites:

- `test/evolution-evidence.test.ts` — reader, markers, watermark, index, sequences.
- `test/evolution-state.test.ts` — baseline order, state roundtrip, lock.
- `test/evolution-digest.test.ts` — tiers, caps, provenance, skill/command usage.
- `test/evolution-proposal.test.ts` — schema, weak-only gate, model call.
- `test/evolution-model.test.ts` — profile resolution.
- `test/evolution-patch.test.ts` — EvolutionPatch schema/validation/parity.
- `test/evolution-base-summary.test.ts` — current bodies, traversal, cap.
- `test/evolution-apply.test.ts` — fine-grained operations and guards.
- `test/evolution-compile.test.ts` — materialization, semantic equality, paperlab.
- `test/evolution-versions.test.ts` — archive, swap, rollback, conflicts.
- `test/evolution-review.test.ts` — review state machine and counters.
- `test/evolution-e2e.test.ts` — paperlab auto-evolve, plan/apply, per-item review,
  weak-only rejection, CLI versions/rollback.
- `test/evolution-cli.test.ts` — command parsing and dispatch.

Current baseline: **299/299** tests pass; `npm run typecheck` and `npm run build`
pass.

## Known limitations

- **Commands usage is weak**: Pi expands `/command` templates before recording the
  user turn, so the command name is usually absent. The digest reports
  `command_usage_signal: "unknown"` rather than inventing zero.
- **Skill use is not skill effectiveness**: `load_skill`/`read SKILL.md` proves the
  skill was loaded, not that it helped. Failures and corrections are correlation, not
  causation.
- **Instructions/memory have no usage counter**: relevance comes from current text
  plus corrections/failures/compaction.
- **Base body cap**: `base-summary.ts` defaults to 60k characters. When a body is
  omitted, the model must not guess a `find` string; use a whole-file replacement.
- **Exact find/replace**: 0 or multiple matches are rejected.
- **Representation preservation**: file-backed skills stay file-backed; inline stays
  inline. A new skill defaults to `skills/<name>/SKILL.md`.
- **TUI raw-key behavior is not automated**: CI has no real TTY. The state machine
  and adapter selection are tested with a fake UI; run `rsih genome evolve paperlab`
  in a terminal to verify `a/r/c/d/q`, Comment input, and `--auto` display.
- **Old indexes**: events written before the `genome`/`skill`/`command` fields existed
  need `--reset-watermark` to be rebuilt with provenance.
- **Model planning needs a provider profile**: pass `--config <providers.json>`
  (and optionally `--profile <id>`). Embedded/test callers can inject `propose`.

## Status

| Phase | Content | Status |
| --- | --- | --- |
| A | reader, events, watermark, index, sequences, genome attribution, skill/command evidence | done |
| B | state/baseline, digest tiers, proposal/model, current bodies, weak-only gate | done |
| C0 | `EvolutionPatch`, component map, validator | done |
| C1 | apply engine, compiler, archive/install/rollback | done |
| D | CLI, TUI review, plans/proposals/apply/diff/versions/rollback, paperlab E2E | done |
| E | documentation, `npm run check`, commit | done |
| F | session-end/scheduled triggers, promote | not implemented |

The full design record, decisions and acceptance criteria are in
`.zcode/plans/evolution-plan.md`.
