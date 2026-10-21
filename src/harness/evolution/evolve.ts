/**
 * Evolution orchestration: evidence -> digest -> proposal -> review ->
 * materialize -> install -> state.
 *
 * This is the only module that knows the whole sequence. Every step below it
 * is independently testable, and the review UI is injected, so an end-to-end
 * run can be exercised without a terminal or a model.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  resolve,
} from "node:path";
import { canonicalJson, contentHash } from "../../core/json.ts";
import {
  genomeContentHash,
  genomeInstallName,
  resolveHarnessGenome,
  GENOME_MANIFEST_NAME,
} from "../genome-loader.ts";
import { loadHarnessGenomeFile as loadBundleFile } from "../genome-bundle.ts";
import { applyEvolutionPatch, type EvolutionAppliedOperation } from "./apply.ts";
import { buildBaseSummary } from "./base-summary.ts";
import {
  compileEvolutionBundle,
  createEvolvedGenome,
  evolutionPatchHash,
  type CompiledEvolutionBundle,
} from "./compile.ts";
import { buildDigest, type EvidenceDigest } from "./digest.ts";
import type { EvidenceSourceId } from "./events.ts";
import { EventIndex } from "./index-store.ts";
import {
  createEvolutionModel,
  type EvolutionModel,
} from "./model.ts";
import {
  buildProposalPrompt,
  evaluateProposalEvidence,
  proposeWithModel,
  type EvolutionProposal,
} from "./proposal.ts";
import {
  isWideEvolutionOperation,
  type EvolutionOperation,
  type EvolutionPatch,
} from "./patch.ts";
import {
  createReviewUI,
  reviewProposal,
  type ReviewItem,
  type ReviewUI,
} from "./review.ts";
import { scanEvidence } from "./scan.ts";
import {
  DEFAULT_EVOLUTION_SOURCES,
  discoverEvidenceFiles,
  type EvidenceDiscovery,
} from "./sources.ts";
import {
  acquireEvolutionLock,
  createEvolutionState,
  defaultAgentDirectory,
  evolutionStatePaths,
  loadEvolutionState,
  resolveBaseline,
  saveEvolutionState,
  type Baseline,
  type EvolutionHistoryEntry,
  type EvolutionState,
  type EvolutionStatePaths,
} from "./state.ts";
import { createWatermark, type WatermarkState } from "./watermark.ts";
import {
  evolutionVersionPaths,
  installEvolutionBundle,
  listEvolutionVersions,
  nextEvolutionVersion,
  rollbackEvolutionVersion,
  type EvolutionVersionInfo,
} from "./versions.ts";

export interface EvolutionIO {
  log(line: string): void;
}

export interface EvolutionRunOptions {
  cwd?: string;
  homeDirectory?: string;
  agentDirectory?: string;
  packageDirectory?: string;
  sources?: readonly string[];
  workspaces?: readonly string[];
  since?: string;
  resetWatermark?: boolean;
  intent?: string;
  configPath?: string;
  profileId?: string;
  name?: string;
  auto?: boolean;
  json?: boolean;
  io?: EvolutionIO;
  /** Test hook: replace the default session-store roots. */
  evidenceRoots?: Partial<Record<EvidenceSourceId, readonly string[]>>;
  /** Test/embedding hook: replace the model proposal call. */
  propose?: (request: EvolutionProposalRequest) => Promise<EvolutionProposal>;
  /** Test/embedding hook: replace the model revision call. */
  revise?: (request: EvolutionRevisionRequest) => Promise<EvolutionOperation | undefined>;
  reviewUI?: ReviewUI;
  isTTY?: boolean;
  now?: () => Date;
}

export interface EvolutionBaseInfo {
  reference: string;
  name: string;
  manifestPath: string;
  baseDirectory: string;
  genome: Record<string, any>;
  contentHash: string;
  createdAt?: string;
}

export interface EvolutionProposalRequest {
  base: EvolutionBaseInfo;
  targetName: string;
  baseSummary: ReturnType<typeof buildBaseSummary>;
  digest: EvidenceDigest;
  intent: string;
  history: readonly unknown[];
}

export interface EvolutionRevisionRequest extends EvolutionProposalRequest {
  operation: EvolutionOperation;
  comment: string;
}

export interface EvolutionContext {
  base: EvolutionBaseInfo;
  targetName: string;
  statePaths: EvolutionStatePaths;
  state?: EvolutionState;
  sources: string[];
  workspaces: string[];
  baseline: Baseline;
  discovery: EvidenceDiscovery;
  scan: ReturnType<typeof scanEvidence>;
  digest: EvidenceDigest;
  indexCursor: number;
}

export interface ProposalFile {
  schema_version: "1";
  created_at: string;
  base_name: string;
  base_reference: string;
  base_path: string;
  target_name: string;
  base_genome_id: string;
  base_version: number;
  base_content_hash: string;
  intent: string;
  evidence_hash: string;
  weak_only: boolean;
  decision: "change" | "no_change";
  reason: string;
  patch?: EvolutionPatch;
  changed_components: string[];
  operations: EvolutionAppliedOperation[];
  diff: string;
  validation: { ok: boolean; error?: string; components: string[] };
  digest_summary: Record<string, any>;
  evidence: {
    baseline_at: string;
    baseline_source: string;
    index_cursor: number;
    watermark: WatermarkState;
  };
}

export interface PlanResult {
  proposal: ProposalFile;
  path?: string;
}

export interface EvolveResult {
  status: "installed" | "no_change" | "proposal" | "saved" | "cancelled";
  proposal?: ProposalFile;
  proposalPath?: string;
  version?: number;
  activeDirectory?: string;
  archived?: EvolutionVersionInfo;
}

interface StageReporter {
  (name: string, status: "pending" | "active" | "done" | "failed", detail?: string): void;
}

interface WorkingSet {
  genome: Record<string, any>;
  assetWrites: Map<string, string>;
  assetRemovals: Set<string>;
  changedComponents: Set<string>;
  operations: EvolutionOperation[];
}

const STAGES = [
  "baseline",
  "scan",
  "digest",
  "model",
  "proposal",
  "review",
  "compile",
  "validate",
  "install",
] as const;

function noopStage(): void {}

export function evolutionStages(): readonly string[] {
  return STAGES;
}

/* --------------------------------------------------------------- base */

export function resolveEvolutionBase(
  reference: string,
  options: EvolutionRunOptions = {},
): EvolutionBaseInfo {
  if (!reference || reference === "default") {
    throw new Error("Evolution needs an existing Genome bundle, not the default Genome.");
  }
  const resolved = resolveHarnessGenome(reference, {
    cwd: options.cwd ?? process.cwd(),
    homeDirectory: options.homeDirectory,
    packageDirectory: options.packageDirectory,
    seedBuiltins: false,
  });
  if (!resolved.path) {
    throw new Error(`Genome "${reference}" has no on-disk bundle to evolve.`);
  }
  if (basename(resolved.path) !== GENOME_MANIFEST_NAME) {
    throw new Error(
      `Evolution requires a directory bundle (${GENOME_MANIFEST_NAME}), got ${resolved.path}.`,
    );
  }
  const baseDirectory = dirname(resolved.path);
  const contentHash = genomeContentHash(baseDirectory);
  if (!contentHash) {
    throw new Error(`Cannot hash the Genome bundle at ${baseDirectory}.`);
  }
  const manifest = JSON.parse(readFileSync(resolved.path, "utf8"));
  return {
    reference,
    name: genomeInstallName(resolved),
    manifestPath: resolved.path,
    baseDirectory,
    genome: resolved.genome,
    contentHash,
    createdAt:
      typeof manifest.evolution?.created_at === "string"
        ? manifest.evolution.created_at
        : undefined,
  };
}

/* ------------------------------------------------------------- state */

function stateFor(base: EvolutionBaseInfo, options: EvolutionRunOptions): {
  paths: EvolutionStatePaths;
  state?: EvolutionState;
} {
  const agentDirectory =
    options.agentDirectory ?? defaultAgentDirectory();
  const paths = evolutionStatePaths(base.name, agentDirectory);  return { paths, state: loadEvolutionState(paths.directory) };
}

function resolvedSources(options: EvolutionRunOptions): string[] {
  return [
    ...new Set(
      (options.sources?.length ? options.sources : DEFAULT_EVOLUTION_SOURCES).map(
        (id) => String(id).trim().toLowerCase(),
      ),
    ),
  ].filter(Boolean);
}

function resolvedWorkspaces(options: EvolutionRunOptions): string[] {
  const cwd = options.cwd ?? process.cwd();
  return [...(options.workspaces ?? [])]
    .map((path) => resolve(cwd, path))
    .filter(Boolean);
}

function organizationTarget(
  base: EvolutionBaseInfo,
  options: EvolutionRunOptions,
): string {
  return options.name?.trim() || base.name;
}

/* ----------------------------------------------------------- evidence */

function timelineFor(base: EvolutionBaseInfo, options: EvolutionRunOptions): {
  paths: EvolutionStatePaths;
  state?: EvolutionState;
  sources: string[];
  workspaces: string[];
  baseline: Baseline;
  watermark: WatermarkState;
} {
  const { paths, state } = stateFor(base, options);
  const baseline = resolveBaseline({
    explicitSince: options.since,
    state,
    genomeCreatedAt: base.createdAt,
  });
  const watermark =
    options.resetWatermark === true
      ? createWatermark()
      : state?.watermark ?? createWatermark();
  return {
    paths,
    state,
    sources: resolvedSources(options),
    workspaces: resolvedWorkspaces(options),
    baseline,
    watermark,
  };
}

async function prepareContext(
  base: EvolutionBaseInfo,
  options: EvolutionRunOptions,
  { writeIndex, stage = noopStage }: { writeIndex: boolean; stage?: StageReporter },
): Promise<EvolutionContext> {
  const timeline = timelineFor(base, options);
  stage("baseline", "done", `${timeline.baseline.iso} (${timeline.baseline.source})`);

  stage("scan", "active");
  const discovery = discoverEvidenceFiles({
    sources: timeline.sources,
    roots: options.evidenceRoots,
  });
  if (discovery.unknownSources.length > 0) {
    throw new Error(
      `Unknown evidence source(s): ${discovery.unknownSources.join(", ")}.`,
    );
  }
  const index = writeIndex ? new EventIndex(timeline.paths.directory) : undefined;
  const scan = await scanEvidence({
    files: discovery.files,
    watermark: timeline.watermark,
    index,
    since: timeline.baseline.at,
  });
  stage(
    "scan",
    "done",
    `${scan.coverage.read}/${scan.coverage.files} files, ${scan.events.length} events`,
  );

  stage("digest", "active");
  const digest = buildDigest({
    events: scan.events,
    summaries: scan.summaries,
    coverage: scan.coverage,
    baseline: timeline.baseline,
    workspaces: timeline.workspaces,
    targetGenome: {
      reference: base.reference,
      baseDirectory: base.baseDirectory,
    },
    includeExternal: timeline.sources.some((source) => source !== "rsih"),
    notes: discovery.notes,
  });
  stage("digest", "done", digest.evidence_hash.slice(0, 12));

  return {
    base,
    targetName: organizationTarget(base, options),
    statePaths: timeline.paths,
    state: timeline.state,
    sources: timeline.sources,
    workspaces: timeline.workspaces,
    baseline: timeline.baseline,
    discovery,
    scan,
    digest,
    indexCursor:
      scan.index?.cursor ??
      timeline.state?.index_cursor ??
      0,
  };
}

function focusSkills(digest: EvidenceDigest): string[] {
  return [
    ...new Set([
      ...digest.signals.strong.skill_usage.map((skill) => skill.skill),
      ...digest.signals.weak.skill_usage.map((skill) => skill.skill),
    ]),
  ];
}

export function digestSummary(digest: EvidenceDigest): Record<string, any> {
  return {
    policy_version: digest.policy_version,
    evidence_hash: digest.evidence_hash,
    baseline: digest.baseline,
    sessions: digest.context.sessions.length,
    strong: {
      signatures: digest.signals.strong.top_signatures.length,
      corrections: digest.signals.strong.corrections.length,
      failure_retry: digest.signals.strong.failure_retry.length,
      transitions: digest.signals.strong.transitions.length,
      repeated_sequences: digest.signals.strong.repeated_sequences.length,
      skill_usage: digest.signals.strong.skill_usage,
      outcomes: digest.signals.strong.outcomes,
    },
    weak: {
      imported_sessions: digest.signals.weak.imported_sessions.length,
      external_sessions: digest.signals.weak.external_sessions.length,
      skill_usage: digest.signals.weak.skill_usage,
      command_usage: digest.signals.weak.command_usage,
      command_usage_signal: digest.signals.weak.command_usage_signal,
      compactions: digest.signals.weak.compactions,
    },
    provenance: digest.coverage.provenance,
    coverage: {
      files: digest.coverage.files,
      read: digest.coverage.read,
      skipped: digest.coverage.skipped,
      unknown_event_types: digest.coverage.unknown_event_types,
      filtered: digest.coverage.filtered.length,
      unsupported: digest.coverage.unsupported.length,
      errors: digest.coverage.errors,
      truncated: digest.coverage.truncated,
      notes: digest.coverage.notes,
    },
  };
}

/* ---------------------------------------------------------- proposal */

function hasActionableSessions(digest: EvidenceDigest): boolean {
  const attributed =
    digest.coverage.provenance.matched_events +
    digest.coverage.provenance.external_events;
  return (
    attributed > 0 &&
    digest.context.sessions.some(
      (session) =>
        session.origin === "user" &&
        (session.user_turns > 0 || session.calls > 0),
    )
  );
}

function intentFor(context: EvolutionContext, options: EvolutionRunOptions): string {
  return options.intent?.trim() || context.state?.intent || "";
}

function historyFor(context: EvolutionContext): unknown[] {
  return (context.state?.history ?? []).slice(-5);
}

async function defaultProposal(
  request: EvolutionProposalRequest,
  options: EvolutionRunOptions,
  modelRef: { model?: EvolutionModel },
): Promise<EvolutionProposal> {
  if (!modelRef.model) {
    modelRef.model = createEvolutionModel({
      configPath: options.configPath,
      profileId: options.profileId,
    });
  }
  return proposeWithModel({
    model: modelRef.model.runtime,
    profileId: modelRef.model.profileId,
    prompt: buildProposalPrompt({
      baseSummary: request.baseSummary,
      digest: request.digest,
      intent: request.intent,
      history: request.history,
    }),
    baseGenomeId: request.base.genome.genome_id,
  });
}

async function propose(
  context: EvolutionContext,
  options: EvolutionRunOptions,
  stage: StageReporter,
  modelRef: { model?: EvolutionModel },
): Promise<EvolutionProposal> {
  const intent = intentFor(context, options);
  const baseSummary = buildBaseSummary({
    genome: context.base.genome,
    baseDirectory: context.base.baseDirectory,
    focusSkills: focusSkills(context.digest),
  });
  if (!hasActionableSessions(context.digest)) {
    return {
      decision: "no_change",
      reason: "No attributable user sessions produced new evidence.",
    };
  }
  stage("model", "active");
  const request: EvolutionProposalRequest = {
    base: context.base,
    targetName: context.targetName,
    baseSummary,
    digest: context.digest,
    intent,
    history: historyFor(context),
  };
  const proposal = options.propose
    ? await options.propose(request)
    : await defaultProposal(request, options, modelRef);
  stage("model", "done", proposal.decision);
  return proposal;
}

/* ----------------------------------------------------------- working */

function singleOperationPatch(
  base: EvolutionBaseInfo,
  operation: EvolutionOperation,
  proposal: EvolutionProposal,
): EvolutionPatch {
  return {
    schema_version: "1",
    base_genome_id: base.genome.genome_id,
    base_version: base.genome.version,
    base_content_hash: base.contentHash,
    hypothesis: proposal.patch?.hypothesis ?? "",
    evidence_refs: proposal.patch?.evidence_refs ?? [],
    operations: [operation],
    expected_effect: proposal.patch?.expected_effect ?? "",
    risks: proposal.patch?.risks ?? [],
  };
}

function snapshotWorking(working: WorkingSet): WorkingSet {
  return {
    genome: structuredClone(working.genome),
    assetWrites: new Map(working.assetWrites),
    assetRemovals: new Set(working.assetRemovals),
    changedComponents: new Set(working.changedComponents),
    operations: [...working.operations],
  };
}

function applyWorkingOperation(
  base: EvolutionBaseInfo,
  working: WorkingSet,
  proposal: EvolutionProposal,
  operation: EvolutionOperation,
) {
  const result = applyEvolutionPatch(
    {
      genome: working.genome,
      baseDirectory: base.baseDirectory,
      assetWrites: [...working.assetWrites.entries()].map(([path, content]) => ({
        path,
        content,
      })),
      assetRemovals: [...working.assetRemovals],
    },
    singleOperationPatch(base, operation, proposal),
  );
  working.genome = result.genome;
  working.assetWrites = new Map(
    result.asset_writes.map((asset) => [asset.path, asset.content]),
  );
  working.assetRemovals = new Set(result.asset_removals);
  for (const component of result.changed_components) {
    working.changedComponents.add(component);
  }
  working.operations.push(operation);
  return result;
}

function validateWorkingSet(
  base: EvolutionBaseInfo,
  working: WorkingSet,
  options: EvolutionRunOptions,
): { ok: true; compiled: CompiledEvolutionBundle } | { ok: false; error: string } {
  const root = mkdtempSync(join(tmpdir(), "rsih-evolve-validate-"));
  const output = join(root, "bundle");
  try {
    const version = Math.max(
      1,
      Number(base.genome.version ?? 1) + 1,
      nextEvolutionVersion(organizationTarget(base, options), {
        homeDirectory: options.homeDirectory,
        agentDirectory: options.agentDirectory,
      }),
    );
    const evolved = createEvolvedGenome(
      working.genome,
      contentHash({
        operations: working.operations,
        changed: [...working.changedComponents].sort(),
      }),
      version,
    );
    const compiled = compileEvolutionBundle({
      baseDirectory: base.baseDirectory,
      outputDirectory: output,
      genome: evolved,
      changedComponents: [...working.changedComponents] as any,
      assetWrites: [...working.assetWrites.entries()].map(([path, content]) => ({
        path,
        content,
      })),
      assetRemovals: [...working.assetRemovals],
      metadata: {
        base_name: base.name,
        base_content_hash: base.contentHash,
        operation_count: working.operations.length,
      },
      expectedBaseContentHash: base.contentHash,
    });
    return { ok: true, compiled };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function clip(text: string, maximum = 1200): string {
  const value = String(text ?? "");
  return value.length > maximum ? `${value.slice(0, maximum)}\n…` : value;
}

function operationPreview(operation: EvolutionOperation): { before: string; after: string } {
  switch (operation.op) {
    case "text.patch":
      return {
        before: `- ${clip(operation.find)}`,
        after: `+ ${clip(operation.replace)}`,
      };
    case "text.append":
      return { before: "(append to the existing text)", after: `+ ${clip(operation.text)}` };
    case "text.set":
      return { before: "(replace the whole text)", after: `+ ${clip(operation.text)}` };
    case "entry.update":
      return {
        before: `entry ${operation.target.entry ?? ""} (current value)`,
        after: `+ ${clip(JSON.stringify(operation.value, null, 2))}`,
      };
    case "entry.upsert":
      return {
        before: `entry ${operation.target.entry ?? ""}`,
        after: `+ ${clip(JSON.stringify(operation.value, null, 2))}`,
      };
    case "entry.remove":
      return { before: `- entry ${operation.target.entry ?? ""}`, after: "(removed)" };
    case "asset.create":
      return { before: `(missing ${operation.target.asset ?? "asset"})`, after: `+ ${clip(operation.content)}` };
    case "asset.remove":
      return { before: `- ${operation.target.asset ?? "asset"}`, after: "(removed)" };
    case "field.set":
      return {
        before: `${operation.target.component}.${operation.target.field ?? ""} (current value)`,
        after: `+ ${clip(JSON.stringify(operation.value, null, 2))}`,
      };
    case "component.set":
      return {
        before: `${operation.target.component} (whole component)`,
        after: `+ ${clip(JSON.stringify(operation.value, null, 2))}`,
      };
    default:
      return { before: "(unsupported preview)", after: "" };
  }
}

function itemFor(
  index: number,
  operation: EvolutionOperation,
  proposal: EvolutionProposal,
  validation: { ok: boolean; error?: string },
  weakOnly: boolean,
): ReviewItem {
  const preview = operationPreview(operation);
  const risks = [...(proposal.patch?.risks ?? [])];
  if (weakOnly) {
    risks.push(
      "Weak evidence only: no evidence_ref matched a strong signal; --auto will reject this proposal.",
    );
  }
  return {
    index,
    operation,
    wide: isWideEvolutionOperation(operation),
    summary: `${operation.op} ${[operation.target.component, operation.target.entry, operation.target.field, operation.target.asset].filter(Boolean).join(".")}`,
    evidence_refs: proposal.patch?.evidence_refs ?? [],
    risks,
    before: preview.before,
    after: preview.after,
    validation,
  };
}

async function reviseWithModel(
  request: EvolutionRevisionRequest,
  options: EvolutionRunOptions,
  modelRef: { model?: EvolutionModel },
): Promise<EvolutionOperation | undefined> {
  if (!modelRef.model) {
    modelRef.model = createEvolutionModel({
      configPath: options.configPath,
      profileId: options.profileId,
    });
  }
  const prompt = buildProposalPrompt({
    baseSummary: {
      ...request.baseSummary,
      current_operation: request.operation,
      reviewer_comment: request.comment,
    },
    digest: request.digest,
    intent: request.intent,
    history: request.history,
  });
  prompt.system = [
    prompt.system,
    "",
    "The reviewer rejected the current operation and asked for a revision.",
    "Return a proposal whose patch contains exactly one operation: the replacement for the current operation.",
    "Keep the same base_genome_id. Change only what the comment asks for.",
  ].join("\n");
  const proposal = await proposeWithModel({
    model: modelRef.model.runtime,
    profileId: modelRef.model.profileId,
    prompt,
    baseGenomeId: request.base.genome.genome_id,
  });
  if (!proposal.patch || proposal.patch.operations.length !== 1) {
    throw new Error("The revision must contain exactly one operation.");
  }
  return proposal.patch.operations[0];
}

async function reviseItem(
  item: ReviewItem,
  comment: string,
  context: EvolutionContext,
  proposal: EvolutionProposal,
  options: EvolutionRunOptions,
  modelRef: { model?: EvolutionModel },
): Promise<{ ok: true; item: ReviewItem } | { ok: false; error: string }> {
  try {
    const operation = options.revise
      ? await options.revise({
          base: context.base,
          targetName: context.targetName,
          baseSummary: buildBaseSummary({
            genome: context.base.genome,
            baseDirectory: context.base.baseDirectory,
            focusSkills: focusSkills(context.digest),
          }),
          digest: context.digest,
          intent: intentFor(context, options),
          history: historyFor(context),
          operation: item.operation,
          comment,
        })
      : await reviseWithModel(
          {
            base: context.base,
            targetName: context.targetName,
            baseSummary: buildBaseSummary({
              genome: context.base.genome,
              baseDirectory: context.base.baseDirectory,
              focusSkills: focusSkills(context.digest),
            }),
            digest: context.digest,
            intent: intentFor(context, options),
            history: historyFor(context),
            operation: item.operation,
            comment,
          },
          options,
          modelRef,
        );
    if (!operation) return { ok: false, error: "The model declined to revise this item." };
    return {
      ok: true,
      item: itemFor(item.index, operation, proposal, { ok: true }, false),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* -------------------------------------------------------------- state */

function historyEntry(
  entry: Omit<EvolutionHistoryEntry, "created_at">,
  now: () => Date,
): EvolutionHistoryEntry {
  return { ...entry, created_at: now().toISOString() };
}

function saveState(
  context: EvolutionContext,
  options: EvolutionRunOptions,
  history: EvolutionHistoryEntry,
  lastVersion: number,
): void {
  const baseline = context.state
    ? {
        at: Date.parse(context.state.baseline_at),
        iso: context.state.baseline_at,
        source: context.state.baseline_source,
      }
    : context.baseline;
  const state = createEvolutionState({
    baseName: context.base.name,
    baseGenomeId: context.base.genome.genome_id,
    baseContentHash: context.base.contentHash,
    intent: intentFor(context, options),
    sources: context.sources,
    workspaces: context.workspaces,
    baseline,
    watermark: context.scan.watermark,
    indexCursor: context.indexCursor,
    lastVersion,
    history: [...(context.state?.history ?? []), history],
  });
  saveEvolutionState(state, context.statePaths.directory);
}

/* ----------------------------------------------------------- proposal */

function buildProposalFile(
  context: EvolutionContext,
  options: EvolutionRunOptions,
  proposal: EvolutionProposal,
  applied?: { operations: EvolutionAppliedOperation[]; changed: string[] },
  validation: { ok: boolean; error?: string } = { ok: true },
  diffText?: string,
): ProposalFile {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const weak = evaluateProposalEvidence(proposal, context.digest).weakOnly;
  return {
    schema_version: "1",
    created_at: now,
    base_name: context.base.name,
    base_reference: context.base.reference,
    base_path: context.base.manifestPath,
    target_name: context.targetName,
    base_genome_id: context.base.genome.genome_id,
    base_version: Number(context.base.genome.version ?? 1),
    base_content_hash: context.base.contentHash,
    intent: intentFor(context, options),
    evidence_hash: context.digest.evidence_hash,
    weak_only: weak,
    decision: proposal.decision,
    reason: proposal.reason,
    patch: proposal.patch,
    changed_components: applied?.changed ?? [],
    operations: applied?.operations ?? [],
    diff:
      diffText ??
      (applied?.operations ?? [])
        .map(
          (operation) =>
            `${operation.summary}${operation.wide ? " [wide]" : ""}`,
        )
        .join("\n"),
    validation: {
      ok: validation.ok,
      error: validation.error,
      components: applied?.changed ?? [],
    },
    digest_summary: digestSummary(context.digest),
    evidence: {
      baseline_at: context.baseline.iso,
      baseline_source: context.baseline.source,
      index_cursor: context.indexCursor,
      watermark: context.scan.watermark,
    },
  };
}

function proposalFileName(createdAt: string): string {
  return `${createdAt.replace(/[:.]/g, "-")}.json`;
}

function saveProposalFile(
  context: EvolutionContext,
  proposal: ProposalFile,
): string {
  const directory = context.statePaths.proposalsDirectory;
  const path = join(directory, proposalFileName(proposal.created_at));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  return path;
}

/* --------------------------------------------------------------- scan */

export async function scanEvolution(
  reference: string,
  options: EvolutionRunOptions = {},
): Promise<{ context: EvolutionContext; digest: EvidenceDigest }> {
  const base = resolveEvolutionBase(reference, options);
  const context = await prepareContext(base, options, { writeIndex: false });
  return { context, digest: context.digest };
}

/* --------------------------------------------------------------- plan */

function applyAll(
  context: EvolutionContext,
  proposal: EvolutionProposal,
): { working: WorkingSet; result: ReturnType<typeof applyEvolutionPatch> } {
  const patch = proposal.patch;
  if (!patch) throw new Error("A change proposal has no patch.");
  const result = applyEvolutionPatch(
    { genome: context.base.genome, baseDirectory: context.base.baseDirectory },
    patch,
  );
  return {
    working: {
      genome: result.genome,
      assetWrites: new Map(result.asset_writes.map((asset) => [asset.path, asset.content])),
      assetRemovals: new Set(result.asset_removals),
      changedComponents: new Set(result.changed_components),
      operations: [...patch.operations],
    },
    result,
  };
}

function assetChanges(
  baseDirectory: string,
  writes: ReadonlyMap<string, string>,
  removals: ReadonlySet<string>,
): GenomeDiff[] {
  const changes: GenomeDiff[] = [];
  for (const [path, after] of writes) {
    const target = resolve(baseDirectory, path);
    const before = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (before !== after) changes.push({ field: `asset:${path}`, before, after });
  }
  for (const path of removals) {
    const target = resolve(baseDirectory, path);
    if (!existsSync(target)) continue;
    changes.push({
      field: `asset:${path}`,
      before: readFileSync(target, "utf8"),
      after: "",
    });
  }
  return changes;
}

function workingDiff(base: EvolutionBaseInfo, working: WorkingSet): GenomeDiff[] {
  return [
    ...diffGenomes(base.genome, working.genome),
    ...assetChanges(base.baseDirectory, working.assetWrites, working.assetRemovals),
  ];
}

function planInternal(
  context: EvolutionContext,
  proposal: EvolutionProposal,
  options: EvolutionRunOptions,
): PlanResult {
  if (proposal.decision === "no_change" || !proposal.patch) {
    const file = buildProposalFile(context, options, proposal, undefined, { ok: true });
    const path = saveProposalFile(context, file);
    return { proposal: file, path };
  }
  const { working, result } = applyAll(context, proposal);
  const validation = validateWorkingSet(context.base, working, options);
  if (!validation.ok) {
    throw new Error(`Proposal failed validation: ${validation.error}`);
  }
  const file = buildProposalFile(
    context,
    options,
    proposal,
    { operations: result.operations, changed: result.changed_components },
    { ok: true },
    renderDiff(workingDiff(context.base, working)),
  );
  const path = saveProposalFile(context, file);
  return { proposal: file, path };
}

export async function planEvolution(
  reference: string,
  options: EvolutionRunOptions = {},
): Promise<PlanResult> {
  const base = resolveEvolutionBase(reference, options);
  const statePaths = evolutionStatePaths(
    base.name,
    options.agentDirectory ?? defaultAgentDirectory(),
  );
  const lock = acquireEvolutionLock(statePaths.directory);
  try {
    const context = await prepareContext(base, options, { writeIndex: true });
    const modelRef: { model?: EvolutionModel } = {};
    const proposal = await propose(context, options, noopStage, modelRef);
    return planInternal(context, proposal, options);
  } finally {
    lock.release();
  }
}

/* -------------------------------------------------------------- evolve */

export async function evolveEvolution(
  reference: string,
  options: EvolutionRunOptions = {},
): Promise<EvolveResult> {
  const base = resolveEvolutionBase(reference, options);
  const isTTY =
    options.isTTY ??
    Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTTY && options.auto !== true) {
    return {
      status: "proposal",
      ...(await planEvolution(reference, options)),
    };
  }

  const auto = options.auto === true;
  const ui: ReviewUI =
    options.reviewUI ??
    createReviewUI({
      auto,
      isTTY,
      io: options.io ?? console,
    });
  const stage: StageReporter = (name, status, detail) =>
    ui.stage(name, status, detail);
  const now = options.now ?? (() => new Date());
  const modelRef: { model?: EvolutionModel } = {};

  try {
    const statePaths = evolutionStatePaths(
      base.name,
      options.agentDirectory ?? defaultAgentDirectory(),
    );
    const lock = acquireEvolutionLock(statePaths.directory);
    try {
      const context = await prepareContext(base, options, { writeIndex: true, stage });
      stage("model", "pending");
      stage("proposal", "pending");
      stage("review", "pending");
      stage("compile", "pending");
      stage("validate", "pending");
      stage("install", "pending");

      const proposal = await propose(context, options, stage, modelRef);
      stage("proposal", proposal.decision === "change" ? "done" : "done", proposal.reason);

      if (proposal.decision === "no_change" || !proposal.patch) {
        const file = buildProposalFile(context, options, proposal);
        const path = saveProposalFile(context, file);
        saveState(
          context,
          options,
          historyEntry(
            {
              action: "no_change",
              decision: "no_change",
              evidence_hash: context.digest.evidence_hash,
              changed_components: [],
            },
            now,
          ),
          context.state?.last_version ?? Number(base.genome.version ?? 1),
        );
        await ui.done?.(`No change. ${proposal.reason}`);
        return { status: "no_change", proposal: file, proposalPath: path };
      }

      const weak = evaluateProposalEvidence(proposal, context.digest).weakOnly;
      if (auto && weak) {
        const rejected: EvolutionProposal = {
          decision: "no_change",
          reason:
            "Rejected in --auto: the proposal cites no strong evidence (weak-only).",
        };
        const file = buildProposalFile(context, options, rejected);
        file.weak_only = true;
        const path = saveProposalFile(context, file);
        saveState(
          context,
          options,
          historyEntry(
            {
              action: "no_change",
              decision: "no_change",
              evidence_hash: context.digest.evidence_hash,
              changed_components: [],
            },
            now,
          ),
          context.state?.last_version ?? Number(base.genome.version ?? 1),
        );
        await ui.done?.(rejected.reason);
        return { status: "no_change", proposal: file, proposalPath: path };
      }

      stage("review", "active");
      const plannedVersion = Math.max(
        Number(base.genome.version ?? 1) + 1,
        nextEvolutionVersion(context.targetName, {
          homeDirectory: options.homeDirectory,
          agentDirectory: options.agentDirectory,
        }),
      );
      const patch = proposal.patch;
      const items: ReviewItem[] = patch.operations.map((operation, index) =>
        itemFor(index, operation, proposal, { ok: true }, weak),
      );

      const working: WorkingSet = {
        genome: structuredClone(base.genome),
        assetWrites: new Map(),
        assetRemovals: new Set(),
        changedComponents: new Set(),
        operations: [],
      };

      const result = await reviewProposal(
        items,
        ui,
        {
          async apply(item) {
            const before = snapshotWorking(working);
            try {
              applyWorkingOperation(base, working, proposal, item.operation);
              const validation = validateWorkingSet(base, working, options);
              if (!validation.ok) {
                Object.assign(working, before);
                return { ok: false, error: validation.error! };
              }
              return { ok: true };
            } catch (error) {
              Object.assign(working, before);
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
          async revise(item, comment) {
            return reviseItem(item, comment, context, proposal, options, modelRef);
          },
        },
        {
          auto,
          title: `${context.targetName} v${String(base.genome.version ?? 1)} → v${plannedVersion}`,
        },
      );
      if (result.status === "cancelled" || result.finalAction === "cancel") {
        await ui.done?.("Evolution cancelled; the active Genome was not changed.");
        return { status: "cancelled" };
      }

      if (result.finalAction === "save") {
        if (result.applied.length === 0) {
          const noChange: EvolutionProposal = {
            decision: "no_change",
            reason: "No changes were applied during review.",
          };
          const file = buildProposalFile(context, options, noChange);
          const path = saveProposalFile(context, file);
          await ui.done?.(`Proposal saved to ${path}.`);
          return { status: "saved", proposal: file, proposalPath: path };
        }
        const accepted: EvolutionProposal = {
          ...proposal,
          patch: {
            ...patch,
            operations: result.applied.map((item) => item.operation),
          },
        };
        const validation = result.applied.length
          ? validateWorkingSet(base, working, options)
          : { ok: true as const };
        const file = buildProposalFile(
          context,
          options,
          accepted,
          {
            operations: result.applied.map((item) => ({
              index: item.index,
              op: item.operation.op,
              component: item.operation.target.component,
              entry: item.operation.target.entry,
              field: item.operation.target.field,
              asset: item.operation.target.asset,
              wide: item.wide,
              summary: item.summary,
            })),
            changed: [...working.changedComponents].sort(),
          },
          validation.ok ? { ok: true } : validation,
          renderDiff(workingDiff(base, working)),
        );
        const path = saveProposalFile(context, file);
        stage("review", "done", `saved ${basename(path)}`);
        await ui.done?.(`Proposal saved to ${path}.`);
        return { status: "saved", proposal: file, proposalPath: path };
      }

      stage("review", "done", `applied ${result.applied.length}`);
      if (result.applied.length === 0) {
        const noChange: EvolutionProposal = {
          decision: "no_change",
          reason: "All changes were rejected during review.",
        };
        const file = buildProposalFile(context, options, noChange);
        const path = saveProposalFile(context, file);
        saveState(
          context,
          options,
          historyEntry(
            {
              action: "no_change",
              decision: "no_change",
              evidence_hash: context.digest.evidence_hash,
              changed_components: [],
            },
            now,
          ),
          context.state?.last_version ?? Number(base.genome.version ?? 1),
        );
        await ui.done?.(
          "All changes were rejected; the active Genome was not changed.",
        );
        return { status: "no_change", proposal: file, proposalPath: path };
      }

      const acceptedPatch: EvolutionPatch = {
        ...patch,
        operations: result.applied.map((item) => item.operation),
      };
      const patchHash = evolutionPatchHash(acceptedPatch);
      stage("compile", "active");
      const root = mkdtempSync(join(tmpdir(), "rsih-evolve-"));
      const output = join(root, "bundle");
      let compiled: CompiledEvolutionBundle;
      try {
        const version = Math.max(
          Number(base.genome.version ?? 1) + 1,
          nextEvolutionVersion(context.targetName, {
            homeDirectory: options.homeDirectory,
            agentDirectory: options.agentDirectory,
          }),
        );
        const evolved = createEvolvedGenome(working.genome, patchHash, version);
        compiled = compileEvolutionBundle({
          baseDirectory: base.baseDirectory,
          outputDirectory: output,
          genome: evolved,
          changedComponents: [...working.changedComponents] as any,
          assetWrites: [...working.assetWrites.entries()].map(([path, content]) => ({
            path,
            content,
          })),
          assetRemovals: [...working.assetRemovals],
          metadata: {
            created_at: now().toISOString(),
            intent: intentFor(context, options),
            base_name: base.name,
            base_content_hash: base.contentHash,
            evidence_hash: context.digest.evidence_hash,
            patch_hash: patchHash,
            patch_id: acceptedPatch.patch_id,
            hypothesis: acceptedPatch.hypothesis,
            operation_count: acceptedPatch.operations.length,
            model: modelRef.model
              ? { profile: modelRef.model.profileId }
              : options.profileId
                ? { profile: options.profileId }
                : undefined,
            baseline_at: context.baseline.iso,
            baseline_source: context.baseline.source,
          },
          expectedBaseContentHash: base.contentHash,
        });
        stage("compile", "done", `${compiled.components_written.length} component(s)`);
        stage("validate", "done", `complexity ${compiled.complexity.genome_bytes} bytes`);
        stage("install", "active");
        const installed = installEvolutionBundle(context.targetName, compiled.directory, {
          homeDirectory: options.homeDirectory,
          agentDirectory: options.agentDirectory,
        });
        stage("install", "done", installed.activeDirectory);

        saveState(
          context,
          options,
          historyEntry(
            {
              action: "evolve",
              from_version: Number(base.genome.version ?? 1),
              version: evolved.version,
              active_path: installed.activeDirectory,
              archive_path: installed.archived?.path,
              patch_hash: patchHash,
              evidence_hash: context.digest.evidence_hash,
              decision: "change",
              changed_components: [...working.changedComponents].sort(),
            },
            now,
          ),
          evolved.version,
        );
        const message = `Installed ${context.targetName} v${evolved.version} at ${installed.activeDirectory}.`;
        await ui.done?.(message);
        return {
          status: "installed",
          version: evolved.version,
          activeDirectory: installed.activeDirectory,
          archived: installed.archived,
        };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    ui.close?.();
  }
}

/* -------------------------------------------------------------- apply */

export function applyProposalFile(
  proposalPath: string,
  options: EvolutionRunOptions = {},
): EvolveResult {
  const path = resolve(options.cwd ?? process.cwd(), proposalPath);
  if (!existsSync(path)) throw new Error(`Proposal file does not exist: ${path}`);
  const proposal = JSON.parse(readFileSync(path, "utf8")) as ProposalFile;
  if (proposal.schema_version !== "1") {
    throw new Error("Unsupported proposal schema_version.");
  }
  if (proposal.decision !== "change" || !proposal.patch) {
    throw new Error("This proposal has no accepted change to apply.");
  }
  const reference =
    proposal.base_path && existsSync(proposal.base_path)
      ? proposal.base_path
      : proposal.base_name;
  const base = resolveEvolutionBase(reference, options);
  if (proposal.base_genome_id !== base.genome.genome_id) {
    throw new Error(
      `Proposal targets ${proposal.base_genome_id}, but the base is ${base.genome.genome_id}.`,
    );
  }
  if (proposal.base_content_hash !== base.contentHash) {
    throw new Error(
      "The base Genome changed after this proposal was written; re-plan before applying it.",
    );
  }
  const targetName = proposal.target_name || base.name;
  const agentDirectory = options.agentDirectory ?? defaultAgentDirectory();
  const statePaths = evolutionStatePaths(base.name, agentDirectory);
  const lock = acquireEvolutionLock(statePaths.directory);
  try {
    const applied = applyEvolutionPatch(
      { genome: base.genome, baseDirectory: base.baseDirectory },
      proposal.patch,
    );
    const patchHash = evolutionPatchHash(proposal.patch);
    const version = Math.max(
      Number(base.genome.version ?? 1) + 1,
      nextEvolutionVersion(targetName, {
        homeDirectory: options.homeDirectory,
        agentDirectory: options.agentDirectory,
      }),
    );
    const evolved = createEvolvedGenome(applied.genome, patchHash, version);
    const root = mkdtempSync(join(tmpdir(), "rsih-evolve-apply-"));
    const output = join(root, "bundle");
    try {
      const compiled = compileEvolutionBundle({
        baseDirectory: base.baseDirectory,
        outputDirectory: output,
        genome: evolved,
        changedComponents: applied.changed_components,
        assetWrites: applied.asset_writes,
        assetRemovals: applied.asset_removals,
        metadata: {
          created_at: new Date().toISOString(),
          intent: proposal.intent,
          base_name: base.name,
          base_content_hash: base.contentHash,
          evidence_hash: proposal.evidence_hash,
          patch_hash: patchHash,
          operation_count: proposal.patch.operations.length,
          baseline_at: proposal.evidence?.baseline_at,
          baseline_source: proposal.evidence?.baseline_source,
        },
        expectedBaseContentHash: proposal.base_content_hash,
      });
      const installed = installEvolutionBundle(targetName, compiled.directory, {
        homeDirectory: options.homeDirectory,
        agentDirectory: options.agentDirectory,
      });
      const previous = loadEvolutionState(statePaths.directory);
      const baseline: Baseline = proposal.evidence
        ? {
            at: Date.parse(proposal.evidence.baseline_at),
            iso: proposal.evidence.baseline_at,
            source: proposal.evidence.baseline_source as any,
          }
        : resolveBaseline({ genomeCreatedAt: base.createdAt });
      const state = createEvolutionState({
        baseName: base.name,
        baseGenomeId: base.genome.genome_id,
        baseContentHash: base.contentHash,
        intent: proposal.intent,
        sources: previous?.sources ?? ["rsih"],
        workspaces: previous?.workspaces ?? [],
        baseline,
        watermark: proposal.evidence?.watermark ?? previous?.watermark,
        indexCursor: proposal.evidence?.index_cursor ?? previous?.index_cursor ?? 0,
        lastVersion: version,
        history: [
          ...(previous?.history ?? []),
          historyEntry(
            {
              action: "evolve",
              from_version: Number(base.genome.version ?? 1),
              version,
              active_path: installed.activeDirectory,
              archive_path: installed.archived?.path,
              patch_hash: patchHash,
              evidence_hash: proposal.evidence_hash,
              decision: "change",
              changed_components: applied.changed_components,
            },
            () => new Date(),
          ),
        ],
      });
      saveEvolutionState(state, statePaths.directory);
      return {
        status: "installed",
        version,
        activeDirectory: installed.activeDirectory,
        archived: installed.archived,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    lock.release();
  }
}

/* --------------------------------------------------------------- diff */

export interface GenomeDiff {
  field: string;
  before: string;
  after: string;
}

function lineDiff(before: string, after: string, limit = 40): string {
  const left = before.split("\n");
  const right = after.split("\n");
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = left.slice(prefix, left.length - suffix);
  const added = right.slice(prefix, right.length - suffix);
  const lines = [
    ...removed.slice(0, limit).map((line) => `- ${line}`),
    ...added.slice(0, limit).map((line) => `+ ${line}`),
  ];
  if (removed.length + added.length > limit) lines.push("… (truncated)");
  return lines.join("\n");
}

export function diffGenomes(
  before: Record<string, any>,
  after: Record<string, any>,
): GenomeDiff[] {
  const ignored = new Set(["component_manifest"]);
  const changes: GenomeDiff[] = [];
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (ignored.has(field)) continue;
    if (canonicalJson(before[field]) === canonicalJson(after[field])) continue;
    const left = typeof before[field] === "string" ? before[field] : JSON.stringify(before[field], null, 2);
    const right = typeof after[field] === "string" ? after[field] : JSON.stringify(after[field], null, 2);
    changes.push({
      field,
      before: left ?? "",
      after: right ?? "",
    });
  }
  return changes;
}

export function renderDiff(changes: readonly GenomeDiff[]): string {
  if (changes.length === 0) return "No differences.";
  const lines: string[] = [];
  for (const change of changes) {
    lines.push(`${change.field}:`);
    lines.push(lineDiff(change.before, change.after));
  }
  return lines.join("\n");
}

function bundleAssetFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string, prefix: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (
        prefix === "" &&
        (entry.name === GENOME_MANIFEST_NAME ||
          entry.name === "components" ||
          entry.name === "contracts")
      ) {
        continue;
      }
      const absolute = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      try {
        if (entry.isDirectory()) {
          walk(absolute, relative);
        } else if (entry.isFile()) {
          files.set(relative, readFileSync(absolute, "utf8"));
        }
      } catch {
        // Unreadable files are reported by the compiler; diff just skips them.
      }
    }
  };
  walk(root, "");
  return files;
}

function bundleAssetChanges(fromDirectory: string, toDirectory: string): GenomeDiff[] {
  const before = bundleAssetFiles(fromDirectory);
  const after = bundleAssetFiles(toDirectory);
  const changes: GenomeDiff[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(path) ?? "";
    const right = after.get(path) ?? "";
    if (left !== right) changes.push({ field: `asset:${path}`, before: left, after: right });
  }
  return changes;
}

export function diffEvolution(
  reference: string,
  options: EvolutionRunOptions & { to?: number; proposal?: string } = {},
): { changes: GenomeDiff[]; text: string; from: string; to: string } {
  const base = resolveEvolutionBase(reference, options);
  if (options.proposal) {
    const proposal = JSON.parse(
      readFileSync(resolve(options.cwd ?? process.cwd(), options.proposal), "utf8"),
    ) as ProposalFile;
    if (!proposal.patch) throw new Error("The proposal has no patch.");
    const applied = applyEvolutionPatch(
      { genome: base.genome, baseDirectory: base.baseDirectory },
      proposal.patch,
    );
    const changes = [
      ...diffGenomes(base.genome, applied.genome),
      ...assetChanges(
        base.baseDirectory,
        new Map(applied.asset_writes.map((asset) => [asset.path, asset.content])),
        new Set(applied.asset_removals),
      ),
    ];
    return {
      changes,
      text: renderDiff(changes),
      from: `base v${String(base.genome.version ?? 1)}`,
      to: `proposal ${proposal.created_at}`,
    };
  }
  if (options.to === undefined) {
    throw new Error("genome diff requires --to <version> or --proposal <file>.");
  }
  const versions = evolutionVersionPaths(base.name, {
    homeDirectory: options.homeDirectory,
    agentDirectory: options.agentDirectory,
  });
  const archive = join(versions.versionsDirectory, String(options.to));
  if (!existsSync(join(archive, GENOME_MANIFEST_NAME))) {
    throw new Error(`No archived version ${options.to} for "${base.name}".`);
  }
  const target = loadBundleFile(join(archive, GENOME_MANIFEST_NAME)).genome;
  const changes = [
    ...diffGenomes(target, base.genome),
    ...bundleAssetChanges(archive, base.baseDirectory),
  ];
  return {
    changes,
    text: renderDiff(changes),
    from: `v${options.to}`,
    to: `active v${String(base.genome.version ?? 1)}`,
  };
}

/* ---------------------------------------------------- versions/rollback */

export function versionsEvolution(
  reference: string,
  options: EvolutionRunOptions = {},
): ReturnType<typeof listEvolutionVersions> {
  const base = resolveEvolutionBase(reference, options);
  return listEvolutionVersions(base.name, {
    homeDirectory: options.homeDirectory,
    agentDirectory: options.agentDirectory,
  });
}

export function rollbackEvolution(
  reference: string,
  version: number,
  options: EvolutionRunOptions = {},
): ReturnType<typeof rollbackEvolutionVersion> {
  const base = resolveEvolutionBase(reference, options);
  const agentDirectory = options.agentDirectory ?? defaultAgentDirectory();
  const statePaths = evolutionStatePaths(base.name, agentDirectory);
  const lock = acquireEvolutionLock(statePaths.directory);
  try {
    const result = rollbackEvolutionVersion(base.name, version, {
      homeDirectory: options.homeDirectory,
      agentDirectory: options.agentDirectory,
    });
    const state = loadEvolutionState(statePaths.directory);
    if (state) {
      state.history.push(
        historyEntry(
          {
            action: "rollback",
            from_version: result.fromVersion,
            version: result.toVersion,
            active_path: result.activeDirectory,
            archive_path: join(
              evolutionVersionPaths(base.name, {
                homeDirectory: options.homeDirectory,
                agentDirectory: options.agentDirectory,
              }).versionsDirectory,
              String(version),
            ),
          },
          () => new Date(),
        ),
      );
      state.last_version = result.toVersion;
      saveEvolutionState(state, statePaths.directory);
    }
    return result;
  } finally {
    lock.release();
  }
}
