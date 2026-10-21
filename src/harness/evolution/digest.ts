/**
 * The evidence digest is the only part of the evidence layer the proposal
 * model sees. It is therefore where "use narrowly" is enforced: assistant
 * prose, thinking and token bookkeeping never leave this module, while blind
 * spots (unknown types, malformed files, filtered sessions) stay visible in
 * coverage.
 *
 * The tiers:
 *   strong   - can justify a Genome change on its own
 *   weak     - imported/0-user-turn activity and carrier-pressure signals;
 *              can corroborate, never justify alone
 *   context  - attribution and disambiguation only
 *   coverage - what was read, skipped, or not understood
 *   excluded - counted, never sent
 */

import { isAbsolute, relative, resolve } from "node:path";
import { contentHash } from "../../core/json.ts";
import type { EvidenceEvent, EvidenceEventKind, EvidenceOutcome } from "./events.ts";
import type { FileScanSummary } from "./reader.ts";
import type { EvidenceScanCoverage } from "./scan.ts";
import {
  buildEvidenceAggregates,
  isCorrectionText,
  type CorrectionAfterFailureStat,
  type FailureRetryStat,
  type OutcomeTotals,
  type RepeatedSequenceStat,
  type TransitionStat,
} from "./sequences.ts";
import type { Baseline } from "./state.ts";

export const DIGEST_POLICY_VERSION = "1";

export interface DigestCaps {
  signatures: number;
  corrections: number;
  retries: number;
  repeated: number;
  transitions: number;
  weakSignatures: number;
}

export interface DigestExample {
  session: string;
  line: number;
  quote: string;
}

export interface DigestSignature {
  signature: string;
  count: number;
  failures: number;
  successes: number;
  unknown: number;
  sessions: number;
  examples: DigestExample[];
}

export interface DigestCorrection {
  session: string;
  line: number;
  marker: string;
  quote: string;
  count: number;
}

export interface DigestSkillUsage {
  skill: string;
  loads: number;
  sessions: number;
  failures: number;
  corrections: number;
  examples: { session: string; line: number }[];
}

export interface DigestCommandUsage {
  command: string;
  uses: number;
  sessions: number;
  examples: { session: string; line: number }[];
}

export interface DigestWeakSession {
  session: string;
  cwd: string;
  source?: string;
  calls: number;
  failures: number;
  user_turns: number;
}

export type DigestProvenance =
  | "genome"
  | "other_genome"
  | "external"
  | "unattributed"
  | "mixed";

export interface DigestSessionContext {
  session: string;
  cwd: string;
  source: string;
  origin: "user" | "imported" | "empty";
  provenance: DigestProvenance;
  genome_references: string[];
  in_scope: boolean;
  calls: number;
  user_turns: number;
  failures: number;
  assistant_messages: number;
}

export interface TargetGenome {
  /** Stable genome name, e.g. `paperlab`. */
  reference?: string;
  /** Bundle directory; disambiguates same-name genomes. */
  baseDirectory?: string;
  /** Exact content id, only when a specific version is wanted. */
  genomeId?: string;
}

export interface DigestWorkspaceContext {
  cwd: string;
  sessions: number;
  calls: number;
  user_turns: number;
  failures: number;
}

export interface DigestCoverage {
  files: number;
  read: number;
  skipped: { unchanged: number; filtered: number; unsupported: number; before_since: number };
  event_kinds: Partial<Record<EvidenceEventKind, number>>;
  unknown_event_types: { type: string; count: number }[];
  provenance: {
    matched_events: number;
    other_genome_events: number;
    external_events: number;
    unattributed_events: number;
    genome_changes: number;
  };
  filtered: string[];
  unsupported: string[];
  errors: { session: string; error: string }[];
  excluded: { assistant_messages: number; other_events: number };
  truncated: { kind: string; dropped: number }[];
  notes: string[];
}

export interface EvidenceDigest {
  policy_version: string;
  generated_at: string;
  evidence_hash: string;
  baseline: { at: string; source: string };
  signals: {
    strong: {
      outcomes: OutcomeTotals;
      top_signatures: DigestSignature[];
      skill_usage: DigestSkillUsage[];
      corrections: DigestCorrection[];
      transitions: TransitionStat[];
      failure_retry: FailureRetryStat[];
      correction_after_failure: CorrectionAfterFailureStat[];
      repeated_sequences: RepeatedSequenceStat[];
    };
    weak: {
      imported_sessions: DigestWeakSession[];
      imported_signatures: DigestSignature[];
      skill_usage: DigestSkillUsage[];
      command_usage: DigestCommandUsage[];
      command_usage_signal: "observed" | "unknown";
      external_sessions: DigestWeakSession[];
      external_signatures: DigestSignature[];
      compactions: number;
      permissions: number;
      subagents: number;
    };
  };
  context: {
    sources: { source: string; files: number; calls: number; user_turns: number; failures: number }[];
    sessions: DigestSessionContext[];
    workspaces: DigestWorkspaceContext[];
    model_changes: number;
    cwd_changes: number;
  };
  coverage: DigestCoverage;
}

export interface BuildDigestOptions {
  events: readonly EvidenceEvent[];
  summaries: readonly FileScanSummary[];
  coverage: EvidenceScanCoverage;
  baseline: Baseline;
  workspaces?: readonly string[];
  /** Restrict signals to sessions/segments that belong to this Genome. */
  targetGenome?: TargetGenome;
  /** Include unmarked sessions as weak evidence (explicit `--sources`). */
  includeExternal?: boolean;
  caps?: Partial<DigestCaps>;
  notes?: readonly string[];
  generatedAt?: Date | string;
}

const DEFAULT_CAPS: DigestCaps = {
  signatures: 40,
  corrections: 20,
  retries: 20,
  repeated: 20,
  transitions: 30,
  weakSignatures: 20,
};

function bounded(value: number | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeCaps(caps: Partial<DigestCaps> | undefined): DigestCaps {
  return {
    signatures: bounded(caps?.signatures, DEFAULT_CAPS.signatures),
    corrections: bounded(caps?.corrections, DEFAULT_CAPS.corrections),
    retries: bounded(caps?.retries, DEFAULT_CAPS.retries),
    repeated: bounded(caps?.repeated, DEFAULT_CAPS.repeated),
    transitions: bounded(caps?.transitions, DEFAULT_CAPS.transitions),
    weakSignatures: bounded(caps?.weakSignatures, DEFAULT_CAPS.weakSignatures),
  };
}

function originOf(summary: FileScanSummary): "user" | "imported" | "empty" {
  if (summary.userTurns > 0) return "user";
  if (summary.calls > 0 || summary.assistantMessages > 0) return "imported";
  return "empty";
}

function sessionCwds(events: readonly EvidenceEvent[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.cwd) continue;
    const set = result.get(event.session);
    if (set) set.add(event.cwd);
    else result.set(event.session, new Set([event.cwd]));
  }
  return result;
}

function normalizedWorkspacePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * A workspace entry is a root, not a single cwd: `/work/proj` includes
 * `/work/proj/sub`, but not `/work/project2`. Windows paths compare
 * case-insensitively; non-absolute session cwds only match an exact entry.
 */
function inWorkspace(cwd: string | undefined, workspaces: readonly string[]): boolean {
  if (workspaces.length === 0) return true;
  if (!cwd) return false;
  if (!isAbsolute(cwd)) return workspaces.includes(cwd);
  const target = normalizedWorkspacePath(cwd);
  for (const workspace of workspaces) {
    const root = normalizedWorkspacePath(workspace);
    const rel = relative(root, target);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

function inScope(
  summary: FileScanSummary,
  workspaces: readonly string[],
  cwds: Set<string> | undefined,
): boolean {
  if (workspaces.length === 0) return true;
  if (inWorkspace(summary.cwd, workspaces)) return true;
  if (!cwds) return false;
  for (const cwd of cwds) {
    if (inWorkspace(cwd, workspaces)) return true;
  }
  return false;
}

function eventInScope(
  event: EvidenceEvent,
  workspaces: readonly string[],
): boolean {
  return inWorkspace(event.cwd, workspaces);
}

function hasGenomeMarker(event: EvidenceEvent): boolean {
  return Boolean(
    event.genome_reference ||
      event.genome_id ||
      event.genome_base_directory,
  );
}

/**
 * `undefined` means the event carries no Genome marker (external or old
 * session). `true` means it belongs to the target; `false` means it belongs to
 * a different Genome.
 */
function eventMatchesGenome(
  event: EvidenceEvent,
  target: TargetGenome | undefined,
): boolean | undefined {
  if (!hasGenomeMarker(event)) return undefined;
  if (!target) return true;
  if (target.genomeId) return event.genome_id === target.genomeId;

  if (target.baseDirectory) {
    if (event.genome_base_directory) {
      return (
        normalizedWorkspacePath(event.genome_base_directory) ===
        normalizedWorkspacePath(target.baseDirectory)
      );
    }
    // Older markers may have a reference but no baseDirectory.
    if (target.reference) return event.genome_reference === target.reference;
    return false;
  }

  if (target.reference) return event.genome_reference === target.reference;
  return true;
}

function provenanceForSession(
  events: readonly EvidenceEvent[],
  target: TargetGenome | undefined,
  source: string,
): DigestProvenance {
  let matched = 0;
  let other = 0;
  let unmarked = 0;
  for (const event of events) {
    const match = eventMatchesGenome(event, target);
    if (match === undefined) unmarked += 1;
    else if (match) matched += 1;
    else other += 1;
  }
  if (matched > 0 && (other > 0 || unmarked > 0)) return "mixed";
  if (matched > 0) return "genome";
  if (other > 0) return "other_genome";
  if (unmarked > 0) return source === "rsih" ? "unattributed" : "external";
  return "unattributed";
}

interface SignatureAccumulator {
  signature: string;
  count: number;
  failures: number;
  successes: number;
  unknown: number;
  sessions: Set<string>;
  examples: DigestExample[];
}

function buildSignatures(
  events: readonly EvidenceEvent[],
  cap: number,
): { items: DigestSignature[]; dropped: number } {
  const results = new Map<string, EvidenceOutcome>();
  for (const event of events) {
    if (event.kind !== "tool_result" || !event.call_id) continue;
    // Call ids are unique inside a transcript, not necessarily across files.
    results.set(`${event.session}\u0000${event.call_id}`, event.outcome ?? "unknown");
  }

  const bySignature = new Map<string, SignatureAccumulator>();
  for (const event of events) {
    if (event.kind !== "tool_call" || !event.signature) continue;
    let stat = bySignature.get(event.signature);
    if (!stat) {
      stat = {
        signature: event.signature,
        count: 0,
        failures: 0,
        successes: 0,
        unknown: 0,
        sessions: new Set(),
        examples: [],
      };
      bySignature.set(event.signature, stat);
    }
    stat.count += 1;
    stat.sessions.add(event.session);
    const outcome = event.call_id
      ? results.get(`${event.session}\u0000${event.call_id}`) ?? "unknown"
      : "unknown";
    if (outcome === "fail") stat.failures += 1;
    else if (outcome === "ok") stat.successes += 1;
    else stat.unknown += 1;
    if (stat.examples.length < 3 && event.quote) {
      stat.examples.push({
        session: event.session,
        line: event.line,
        quote: event.quote,
      });
    }
  }

  const all = [...bySignature.values()].sort(
    (left, right) =>
      right.count * right.sessions.size - left.count * left.sessions.size ||
      right.failures - left.failures ||
      right.count - left.count ||
      left.signature.localeCompare(right.signature),
  );
  const items = all.slice(0, cap).map((stat) => ({
    signature: stat.signature,
    count: stat.count,
    failures: stat.failures,
    successes: stat.successes,
    unknown: stat.unknown,
    sessions: stat.sessions.size,
    examples: stat.examples,
  }));
  return { items, dropped: Math.max(0, all.length - items.length) };
}

function collectCorrections(
  events: readonly EvidenceEvent[],
  cap: number,
): { items: DigestCorrection[]; dropped: number } {
  const grouped = new Map<string, DigestCorrection>();
  for (const event of events) {
    if (event.kind !== "user_turn" || !event.quote) continue;
    const marker = isCorrectionText(event.quote);
    if (!marker) continue;
    const key = `${marker}\u0000${event.quote}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, {
        session: event.session,
        line: event.line,
        marker,
        quote: event.quote,
        count: 1,
      });
    }
  }
  const all = [...grouped.values()].sort(
    (left, right) =>
      right.count - left.count ||
      right.line - left.line ||
      left.quote.localeCompare(right.quote),
  );
  return { items: all.slice(0, cap), dropped: Math.max(0, all.length - cap) };
}

function buildSkillUsage(
  events: readonly EvidenceEvent[],
  cap: number,
): { items: DigestSkillUsage[]; dropped: number } {
  const groups = new Map<string, EvidenceEvent[]>();
  for (const event of events) {
    const key = `${event.session}\u0000${event.generation}`;
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }

  const bySkill = new Map<
    string,
    {
      loads: number;
      sessions: Set<string>;
      failures: number;
      corrections: number;
      examples: { session: string; line: number }[];
    }
  >();

  for (const group of groups.values()) {
    group.sort(
      (left, right) =>
        left.line - right.line ||
        left.seq - right.seq ||
        left.kind.localeCompare(right.kind),
    );
    const results = new Map<
      string,
      { outcome: EvidenceOutcome; index: number }
    >();
    group.forEach((event, index) => {
      if (event.kind === "tool_result" && event.call_id) {
        results.set(event.call_id, {
          outcome: event.outcome ?? "unknown",
          index,
        });
      }
    });

    for (let index = 0; index < group.length; index += 1) {
      const call = group[index];
      if (call.kind !== "tool_call" || !call.skill) continue;
      const stat = bySkill.get(call.skill) ?? {
        loads: 0,
        sessions: new Set<string>(),
        failures: 0,
        corrections: 0,
        examples: [],
      };
      stat.loads += 1;
      stat.sessions.add(call.session);
      if (stat.examples.length < 2) {
        stat.examples.push({ session: call.session, line: call.line });
      }
      const result = call.call_id ? results.get(call.call_id) : undefined;
      if (result?.outcome === "fail") stat.failures += 1;
      const start = result?.index ?? index;
      for (
        let next = start + 1;
        next < group.length && next <= start + 5;
        next += 1
      ) {
        const candidate = group[next];
        if (
          candidate.kind === "user_turn" &&
          candidate.quote &&
          isCorrectionText(candidate.quote)
        ) {
          stat.corrections += 1;
          break;
        }
      }
      bySkill.set(call.skill, stat);
    }
  }

  const all = [...bySkill.entries()]
    .map(([skill, stat]) => ({
      skill,
      loads: stat.loads,
      sessions: stat.sessions.size,
      failures: stat.failures,
      corrections: stat.corrections,
      examples: stat.examples,
    }))
    .sort(
      (left, right) =>
        right.loads - left.loads ||
        right.sessions - left.sessions ||
        left.skill.localeCompare(right.skill),
    );
  return { items: all.slice(0, cap), dropped: Math.max(0, all.length - cap) };
}

function buildCommandUsage(
  events: readonly EvidenceEvent[],
  cap: number,
): {
  items: DigestCommandUsage[];
  dropped: number;
  signal: "observed" | "unknown";
} {
  const byCommand = new Map<
    string,
    {
      uses: number;
      sessions: Set<string>;
      examples: { session: string; line: number }[];
    }
  >();
  for (const event of events) {
    if (event.kind !== "user_turn" || !event.command) continue;
    const stat = byCommand.get(event.command) ?? {
      uses: 0,
      sessions: new Set<string>(),
      examples: [],
    };
    stat.uses += 1;
    stat.sessions.add(event.session);
    if (stat.examples.length < 2) {
      stat.examples.push({ session: event.session, line: event.line });
    }
    byCommand.set(event.command, stat);
  }
  const all = [...byCommand.entries()]
    .map(([command, stat]) => ({
      command,
      uses: stat.uses,
      sessions: stat.sessions.size,
      examples: stat.examples,
    }))
    .sort(
      (left, right) =>
        right.uses - left.uses ||
        right.sessions - left.sessions ||
        left.command.localeCompare(right.command),
    );
  return {
    items: all.slice(0, cap),
    dropped: Math.max(0, all.length - cap),
    signal: all.length > 0 ? "observed" : "unknown",
  };
}

function countKinds(events: readonly EvidenceEvent[]): Partial<Record<EvidenceEventKind, number>> {
  const counts: Partial<Record<EvidenceEventKind, number>> = {};
  for (const event of events) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  }
  return counts;
}

function summarizeSources(summaries: readonly FileScanSummary[]) {
  const map = new Map<
    string,
    { source: string; files: number; calls: number; user_turns: number; failures: number }
  >();
  for (const summary of summaries) {
    let item = map.get(summary.source);
    if (!item) {
      item = { source: summary.source, files: 0, calls: 0, user_turns: 0, failures: 0 };
      map.set(summary.source, item);
    }
    item.files += 1;
    item.calls += summary.calls;
    item.user_turns += summary.userTurns;
    item.failures += summary.failures;
  }
  return [...map.values()].sort((left, right) => left.source.localeCompare(right.source));
}

function summarizeWorkspaces(summaries: readonly FileScanSummary[]) {
  const map = new Map<string, DigestWorkspaceContext>();
  for (const summary of summaries) {
    const cwd = summary.cwd || "(unknown)";
    let item = map.get(cwd);
    if (!item) {
      item = { cwd, sessions: 0, calls: 0, user_turns: 0, failures: 0 };
      map.set(cwd, item);
    }
    item.sessions += 1;
    item.calls += summary.calls;
    item.user_turns += summary.userTurns;
    item.failures += summary.failures;
  }
  return [...map.values()].sort(
    (left, right) => right.calls - left.calls || left.cwd.localeCompare(right.cwd),
  );
}

function topUnknownTypes(
  unknownTypes: Record<string, number>,
  limit = 10,
): { type: string; count: number }[] {
  return Object.entries(unknownTypes)
    .map(([type, count]) => ({ type, count }))
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type))
    .slice(0, limit);
}

/**
 * Build the digest.
 *
 * `workspaces` is a scope filter, not a display filter: a session outside the
 * selected workspaces stays in context/coverage but contributes no strong or
 * weak signals. The scope check uses event-level cwd as well as the summary's
 * initial cwd, so a session that changed workspace is not misattributed.
 */
export function buildDigest(options: BuildDigestOptions): EvidenceDigest {
  const caps = normalizeCaps(options.caps);
  const workspaces = [...(options.workspaces ?? [])];
  const summaries = [...options.summaries];
  const events = [...options.events];
  const target = options.targetGenome;
  const cwdsBySession = sessionCwds(events);
  const summaryBySession = new Map(summaries.map((summary) => [summary.session, summary]));
  const eventsBySession = new Map<string, EvidenceEvent[]>();
  for (const event of events) {
    const list = eventsBySession.get(event.session);
    if (list) list.push(event);
    else eventsBySession.set(event.session, [event]);
  }

  const provenance = {
    matched_events: 0,
    other_genome_events: 0,
    external_events: 0,
    unattributed_events: 0,
    genome_changes: 0,
  };
  for (const event of events) {
    if (event.kind === "genome_change") provenance.genome_changes += 1;
    const match = eventMatchesGenome(event, target);
    if (match === undefined) {
      const source = summaryBySession.get(event.session)?.source ?? event.source;
      if (source === "rsih") provenance.unattributed_events += 1;
      else provenance.external_events += 1;
    } else if (match) {
      provenance.matched_events += 1;
    } else {
      provenance.other_genome_events += 1;
    }
  }

  // A marker-less event belongs to no Genome; only an explicit external opt-in
  // lets it corroborate. A different Genome's events are never included.
  const genomeScopedEvents = target
    ? events.filter((event) => eventMatchesGenome(event, target) === true)
    : events;
  const externalEvents =
    target && options.includeExternal
      ? events.filter((event) => eventMatchesGenome(event, target) === undefined)
      : [];

  const sessionContext: DigestSessionContext[] = summaries.map((summary) => {
    const origin = originOf(summary);
    return {
      session: summary.session,
      cwd: summary.cwd,
      source: summary.source,
      origin,
      provenance: provenanceForSession(
        eventsBySession.get(summary.session) ?? [],
        target,
        summary.source,
      ),
      genome_references: [...(summary.genomeReferences ?? [])],
      in_scope: inScope(summary, workspaces, cwdsBySession.get(summary.session)),
      calls: summary.calls,
      user_turns: summary.userTurns,
      failures: summary.failures,
      assistant_messages: summary.assistantMessages,
    };
  });

  const strongEvents: EvidenceEvent[] = [];
  const weakEvents: EvidenceEvent[] = [];
  for (const event of genomeScopedEvents) {
    const summary = summaryBySession.get(event.session);
    const scope = summary
      ? inScope(summary, workspaces, cwdsBySession.get(event.session))
      : eventInScope(event, workspaces);
    if (!scope) continue;

    if (summary && originOf(summary) === "user") {
      strongEvents.push(event);
    } else if (summary && originOf(summary) === "imported") {
      weakEvents.push(event);
    } else if (!summary) {
      // Events without a summary only happen if a caller hand-builds input;
      // treat them as weak rather than silently promoting them.
      weakEvents.push(event);
    }
  }

  const externalScoped = externalEvents.filter((event) => {
    const summary = summaryBySession.get(event.session);
    return summary
      ? inScope(summary, workspaces, cwdsBySession.get(event.session))
      : eventInScope(event, workspaces);
  });

  const signalKinds = countKinds([...strongEvents, ...weakEvents, ...externalScoped]);

  const strongAggregates = buildEvidenceAggregates(strongEvents, {
    maxTransitions: caps.transitions,
    maxFailureRetries: caps.retries,
    maxCorrections: caps.corrections,
    maxRepeated: caps.repeated,
    maxShapes: 0,
  });
  const strongSignatures = buildSignatures(strongEvents, caps.signatures);
  const corrections = collectCorrections(strongEvents, caps.corrections);
  const strongSkillUsage = buildSkillUsage(strongEvents, 20);
  const weakSignatures = buildSignatures(weakEvents, caps.weakSignatures);
  const weakSkillUsage = buildSkillUsage(weakEvents, 20);
  const commandUsage = buildCommandUsage(
    [...strongEvents, ...weakEvents, ...externalScoped],
    20,
  );
  const externalSignatures = buildSignatures(externalScoped, caps.weakSignatures);

  const weakSessionIds = new Set(weakEvents.map((event) => event.session));
  const weakSessions: DigestWeakSession[] = summaries
    .filter((summary) => originOf(summary) === "imported")
    .filter((summary) => weakSessionIds.has(summary.session))
    .filter((summary) => inScope(summary, workspaces, cwdsBySession.get(summary.session)))
    .map((summary) => ({
      session: summary.session,
      cwd: summary.cwd,
      source: summary.source,
      calls: summary.calls,
      failures: summary.failures,
      user_turns: summary.userTurns,
    }));

  const externalSessionIds = new Set(externalScoped.map((event) => event.session));
  const externalSessions: DigestWeakSession[] = summaries
    .filter((summary) => externalSessionIds.has(summary.session))
    .map((summary) => ({
      session: summary.session,
      cwd: summary.cwd,
      source: summary.source,
      calls: summary.calls,
      failures: summary.failures,
      user_turns: summary.userTurns,
    }));

  const eventKinds = countKinds(events);
  const excludedAssistant = eventKinds.assistant_message ?? 0;
  const excludedOther = Object.values(options.coverage.unknownTypes).reduce(
    (total, count) => total + count,
    0,
  ) || (eventKinds.other ?? 0);

  const truncated: { kind: string; dropped: number }[] = [];
  if (strongSignatures.dropped > 0) {
    truncated.push({ kind: "signatures", dropped: strongSignatures.dropped });
  }
  if (weakSignatures.dropped > 0) {
    truncated.push({ kind: "weak_signatures", dropped: weakSignatures.dropped });
  }
  if (externalSignatures.dropped > 0) {
    truncated.push({
      kind: "external_signatures",
      dropped: externalSignatures.dropped,
    });
  }
  if (strongSkillUsage.dropped > 0) {
    truncated.push({
      kind: "skill_usage",
      dropped: strongSkillUsage.dropped,
    });
  }
  if (weakSkillUsage.dropped > 0) {
    truncated.push({
      kind: "weak_skill_usage",
      dropped: weakSkillUsage.dropped,
    });
  }
  if (commandUsage.dropped > 0) {
    truncated.push({
      kind: "command_usage",
      dropped: commandUsage.dropped,
    });
  }
  if (corrections.dropped > 0) {
    truncated.push({ kind: "corrections", dropped: corrections.dropped });
  }
  for (const [kind, dropped] of Object.entries(strongAggregates.dropped)) {
    if (dropped > 0 && kind !== "session_shapes") {
      truncated.push({ kind, dropped });
    }
  }

  const signals = {
    strong: {
      outcomes: strongAggregates.outcomes,
      top_signatures: strongSignatures.items,
      skill_usage: strongSkillUsage.items,
      corrections: corrections.items,
      transitions: strongAggregates.transitions,
      failure_retry: strongAggregates.failure_retry,
      correction_after_failure: strongAggregates.correction_after_failure,
      repeated_sequences: strongAggregates.repeated_sequences,
    },
    weak: {
      imported_sessions: weakSessions,
      imported_signatures: weakSignatures.items,
      skill_usage: weakSkillUsage.items,
      command_usage: commandUsage.items,
      command_usage_signal: commandUsage.signal,
      external_sessions: externalSessions,
      external_signatures: externalSignatures.items,
      compactions: signalKinds.compaction ?? 0,
      permissions: signalKinds.permission ?? 0,
      subagents: signalKinds.subagent ?? 0,
    },
  };

  const context = {
    sources: summarizeSources(summaries),
    sessions: sessionContext,
    workspaces: summarizeWorkspaces(summaries),
    model_changes: eventKinds.model_change ?? 0,
    cwd_changes: eventKinds.cwd_change ?? 0,
  };

  const coverage: DigestCoverage = {
    files: options.coverage.files,
    read: options.coverage.read,
    skipped: {
      unchanged: options.coverage.skipped.unchanged,
      filtered: options.coverage.skipped.filtered,
      unsupported: options.coverage.skipped.unsupported,
      before_since: options.coverage.skipped.beforeSince,
    },
    event_kinds: eventKinds,
    unknown_event_types: topUnknownTypes(options.coverage.unknownTypes),
    provenance,
    filtered: [...options.coverage.filtered],
    unsupported: [...options.coverage.unsupported],
    errors: [...options.coverage.errors],
    excluded: {
      assistant_messages: excludedAssistant,
      other_events: excludedOther,
    },
    truncated,
    notes: [
      ...(options.notes ?? []),
      ...(commandUsage.signal === "unknown"
        ? [
            "Command usage is unknown: Pi expands prompt templates before recording the user message, so the transcript usually has no `/command`.",
          ]
        : []),
    ],
  };

  const generatedAt =
    options.generatedAt instanceof Date
      ? options.generatedAt.toISOString()
      : options.generatedAt ?? new Date().toISOString();

  const payload = {
    policy_version: DIGEST_POLICY_VERSION,
    baseline: { at: options.baseline.iso, source: options.baseline.source },
    signals,
    context,
    coverage,
  };

  return {
    policy_version: DIGEST_POLICY_VERSION,
    generated_at: generatedAt,
    evidence_hash: contentHash(payload),
    baseline: payload.baseline,
    signals,
    context,
    coverage,
  };
}

/**
 * Every reference a proposal is allowed to cite as strong evidence.
 *
 * The proposal may cite a signature, a concrete example line, a transition, or
 * a correction. A citation that only matches weak/context/coverage data is not
 * in this set; `proposal.ts` uses that to apply the weak-only gate.
 */
export function strongReferences(digest: EvidenceDigest): Set<string> {
  const refs = new Set<string>();
  for (const signature of digest.signals.strong.top_signatures) {
    refs.add(`signature:${signature.signature}`);
    for (const example of signature.examples) {
      refs.add(`session:${example.session}:${example.line}`);
    }
  }
  for (const transition of digest.signals.strong.transitions) {
    refs.add(`transition:${transition.from}->${transition.to}`);
  }
  for (const correction of digest.signals.strong.corrections) {
    refs.add(`correction:${correction.session}:${correction.line}`);
  }
  for (const correction of digest.signals.strong.correction_after_failure) {
    refs.add(`correction:${correction.session}:${correction.line}`);
  }
  for (const usage of digest.signals.strong.skill_usage) {
    refs.add(`skill:${usage.skill}`);
    for (const example of usage.examples) {
      refs.add(`skill_use:${example.session}:${example.line}`);
    }
  }
  return refs;
}
