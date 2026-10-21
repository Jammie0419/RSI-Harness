/**
 * Workflow-level evidence derived from ordered events.
 *
 * Counts alone say "pytest ran 40 times". The evolution proposal also needs to
 * see the shape of the work: what followed what, which failures were retried,
 * and which user corrections came right after a failure. Those are the facts
 * that justify a workflow skill rather than a list of commands.
 */

import type { EvidenceEvent, EvidenceOutcome } from "./events.ts";

export interface TransitionStat {
  from: string;
  to: string;
  count: number;
  sessions: number;
}

export interface FailureRetryStat {
  signature: string;
  retries: number;
  sessions: number;
  example?: { session: string; line: number };
}

export interface CorrectionAfterFailureStat {
  session: string;
  line: number;
  signature: string;
  marker: string;
  quote: string;
}

export interface RepeatedSequenceStat {
  signatures: string[];
  count: number;
  sessions: number;
}

export interface SessionShape {
  session: string;
  calls: number;
  distinct_tools: number;
  failures: number;
  user_turns: number;
}

export interface OutcomeTotals {
  ok: number;
  fail: number;
  unknown: number;
}

export interface EvidenceAggregates {
  outcomes: OutcomeTotals;
  transitions: TransitionStat[];
  failure_retry: FailureRetryStat[];
  correction_after_failure: CorrectionAfterFailureStat[];
  repeated_sequences: RepeatedSequenceStat[];
  session_shapes: SessionShape[];
  /** How many entries were dropped by the per-category caps. */
  dropped: {
    transitions: number;
    failure_retry: number;
    correction_after_failure: number;
    repeated_sequences: number;
    session_shapes: number;
  };
}

export interface AggregateOptions {
  maxTransitions?: number;
  maxFailureRetries?: number;
  maxCorrections?: number;
  maxRepeated?: number;
  maxShapes?: number;
  retryWindow?: number;
  correctionWindow?: number;
}

const STRONG_CORRECTION_MARKERS: { marker: string; re: RegExp }[] = [
  { marker: "不对", re: /不对|不正确|不是这样|说错了|错了/ },
  { marker: "别再", re: /别再|不要再|不该|别用|不要用/ },
  { marker: "stop", re: /\b(?:stop|quit)\b/i },
  { marker: "don't", re: /\b(?:don'?t|do not|never|instead of)\b/i },
  { marker: "wrong", re: /\b(?:wrong|incorrect|not what i|that'?s not)\b/i },
  { marker: "no,", re: /\bno[,.!)]/i },
];

/**
 * Weak markers only count near the start of a turn. `别` is deliberately not
 * included on its own: it is a substring of ordinary Chinese words such as
 * 分别 and 特别, and treating it as a correction produced false evidence.
 */
const WEAK_CORRECTION_MARKERS: { marker: string; re: RegExp }[] = [
  { marker: "actually", re: /\bactually\b/i },
  { marker: "没看懂", re: /没看懂|没理解|不明白|不太明白/ },
  { marker: "又出现", re: /又出现|又发生|又这样/ },
  { marker: "应该用", re: /应该用|应该改|改成/ },
];

const CORRECTION_WINDOW = 80;

export function isCorrectionText(text: string): string | undefined {
  const value = String(text ?? "");
  for (const { marker, re } of STRONG_CORRECTION_MARKERS) {
    if (re.test(value)) return marker;
  }
  const head = value.slice(0, CORRECTION_WINDOW);
  for (const { marker, re } of WEAK_CORRECTION_MARKERS) {
    if (re.test(head)) return marker;
  }
  return undefined;
}

function groupKey(event: EvidenceEvent): string {
  return `${event.session}\u0000${event.generation}`;
}

function eventOrder(left: EvidenceEvent, right: EvidenceEvent): number {
  return (
    left.line - right.line ||
    left.seq - right.seq ||
    left.kind.localeCompare(right.kind)
  );
}

function outcomeOf(
  call: EvidenceEvent,
  results: Map<string, EvidenceOutcome>,
): EvidenceOutcome {
  if (!call.call_id) return "unknown";
  return results.get(call.call_id) ?? "unknown";
}

function bounded(value: number | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/**
 * Turn an ordered event list into workflow aggregates.
 *
 * Order is per session and generation, not global: line numbers from different
 * transcripts are unrelated. A generation change is a new sequence.
 */
export function buildEvidenceAggregates(
  events: readonly EvidenceEvent[],
  options: AggregateOptions = {},
): EvidenceAggregates {
  const maxTransitions = bounded(options.maxTransitions, 30);
  const maxFailureRetries = bounded(options.maxFailureRetries, 20);
  const maxCorrections = bounded(options.maxCorrections, 20);
  const maxRepeated = bounded(options.maxRepeated, 20);
  const maxShapes = bounded(options.maxShapes, 50);
  const retryWindow = bounded(options.retryWindow, 3);
  const correctionWindow = bounded(options.correctionWindow, 5);

  const groups = new Map<string, EvidenceEvent[]>();
  for (const event of events) {
    const key = groupKey(event);
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }

  const outcomes: OutcomeTotals = { ok: 0, fail: 0, unknown: 0 };
  const transitionCounts = new Map<
    string,
    { from: string; to: string; count: number; sessions: Set<string> }
  >();
  const retryCounts = new Map<
    string,
    { retries: number; sessions: Set<string>; example?: { session: string; line: number } }
  >();
  const corrections: CorrectionAfterFailureStat[] = [];
  const seenCorrections = new Set<string>();
  const repeatedCounts = new Map<
    string,
    { signatures: string[]; count: number; sessions: Set<string> }
  >();
  const shapes: SessionShape[] = [];

  for (const group of groups.values()) {
    group.sort(eventOrder);
    const calls = group.filter(
      (event) => event.kind === "tool_call" && typeof event.signature === "string",
    );
    const resultByCall = new Map<string, EvidenceOutcome>();
    const resultIndex = new Map<string, number>();
    group.forEach((event, index) => {
      if (event.kind !== "tool_result" || !event.call_id) return;
      resultByCall.set(event.call_id, event.outcome ?? "unknown");
      resultIndex.set(event.call_id, index);
    });

    const callOutcomes = calls.map((call) => ({
      call,
      outcome: outcomeOf(call, resultByCall),
    }));
    for (const { outcome } of callOutcomes) {
      outcomes[outcome] += 1;
    }

    for (let index = 1; index < calls.length; index += 1) {
      const from = calls[index - 1].signature as string;
      const to = calls[index].signature as string;
      const key = `${from}\u0000${to}`;
      const stat = transitionCounts.get(key) ?? {
        from,
        to,
        count: 0,
        sessions: new Set<string>(),
      };
      stat.count += 1;
      stat.sessions.add(calls[index].session);
      transitionCounts.set(key, stat);
    }

    for (let index = 0; index < callOutcomes.length; index += 1) {
      const { call, outcome } = callOutcomes[index];
      if (outcome !== "fail") continue;
      const signature = call.signature as string;

      for (
        let next = index + 1;
        next < callOutcomes.length && next <= index + retryWindow;
        next += 1
      ) {
        if (callOutcomes[next].call.signature !== signature) continue;
        const stat = retryCounts.get(signature) ?? {
          retries: 0,
          sessions: new Set<string>(),
          example: { session: call.session, line: call.line },
        };
        stat.retries += 1;
        stat.sessions.add(call.session);
        retryCounts.set(signature, stat);
        // A retry is the next attempt at the same signature, not every later
        // attempt that happens to fall inside the window.
        break;
      }

      const correctionStart =
        (call.call_id ? resultIndex.get(call.call_id) : undefined) ??
        group.indexOf(call);
      for (
        let next = correctionStart + 1;
        next < group.length && next <= correctionStart + correctionWindow;
        next += 1
      ) {
        const candidate = group[next];
        if (candidate.kind !== "user_turn" || !candidate.quote) continue;
        const marker = isCorrectionText(candidate.quote);
        if (!marker) continue;
        const key = `${candidate.session}\u0000${candidate.line}`;
        if (seenCorrections.has(key)) break;
        seenCorrections.add(key);
        corrections.push({
          session: candidate.session,
          line: candidate.line,
          signature,
          marker,
          quote: candidate.quote,
        });
        break;
      }
    }

    const signatures = calls.map((call) => call.signature as string);
    for (let size = 2; size <= 4; size += 1) {
      for (let start = 0; start + size <= signatures.length; start += 1) {
        const sequence = signatures.slice(start, start + size);
        const key = sequence.join("\u0000");
        const stat = repeatedCounts.get(key) ?? {
          signatures: sequence,
          count: 0,
          sessions: new Set<string>(),
        };
        stat.count += 1;
        stat.sessions.add(calls[start].session);
        repeatedCounts.set(key, stat);
      }
    }

    const distinctTools = new Set(calls.map((call) => call.tool ?? ""));
    shapes.push({
      session: calls[0]?.session ?? group[0]?.session ?? "",
      calls: calls.length,
      distinct_tools: distinctTools.size,
      failures: callOutcomes.filter((item) => item.outcome === "fail").length,
      user_turns: group.filter((event) => event.kind === "user_turn").length,
    });
  }

  const allTransitions = [...transitionCounts.values()]
    .map((stat) => ({
      from: stat.from,
      to: stat.to,
      count: stat.count,
      sessions: stat.sessions.size,
    }))
    .sort((left, right) => right.count - left.count || left.from.localeCompare(right.from));
  const transitions = allTransitions.slice(0, maxTransitions);

  const allFailureRetries = [...retryCounts.entries()]
    .map(([signature, stat]) => ({
      signature,
      retries: stat.retries,
      sessions: stat.sessions.size,
      example: stat.example,
    }))
    .sort((left, right) => right.retries - left.retries);
  const failureRetry = allFailureRetries.slice(0, maxFailureRetries);

  const allCorrections = [...corrections].sort(
    (left, right) =>
      left.session.localeCompare(right.session) || left.line - right.line,
  );
  const correctionAfterFailure = allCorrections.slice(0, maxCorrections);

  const allRepeatedSequences = [...repeatedCounts.values()]
    .filter((stat) => stat.count >= 2)
    .map((stat) => ({
      signatures: stat.signatures,
      count: stat.count,
      sessions: stat.sessions.size,
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        right.signatures.length - left.signatures.length,
    );
  const repeatedSequences = allRepeatedSequences.slice(0, maxRepeated);

  const allShapes = [...shapes].sort((left, right) => right.calls - left.calls);
  const sessionShapes = allShapes.slice(0, maxShapes);

  return {
    outcomes,
    transitions,
    failure_retry: failureRetry,
    correction_after_failure: correctionAfterFailure,
    repeated_sequences: repeatedSequences,
    session_shapes: sessionShapes,
    dropped: {
      transitions: allTransitions.length - transitions.length,
      failure_retry: allFailureRetries.length - failureRetry.length,
      correction_after_failure:
        allCorrections.length - correctionAfterFailure.length,
      repeated_sequences:
        allRepeatedSequences.length - repeatedSequences.length,
      session_shapes: allShapes.length - sessionShapes.length,
    },
  };
}
