/**
 * The normalized evidence event the evolution subsystem indexes.
 *
 * This is deliberately not the shape of any one harness's transcript. The
 * reader translates Pi, Claude, Codex and Copilot records into this small
 * vocabulary, so the digest and the proposal prompt never have to know which
 * store a fact came from.
 *
 * `session`, `generation` and `line` are the identity of an event: the same
 * line of the same file generation is the same event, no matter how many times
 * a scan is resumed. `seq` distinguishes several events produced by one line
 * (two tool calls in one assistant message, for example).
 */

export const EVIDENCE_EVENT_SCHEMA_VERSION = "1";

export const EVIDENCE_SOURCE_IDS = [
  "rsih",
  "pi",
  "claude",
  "codex",
  "copilot",
] as const;

export type EvidenceSourceId = (typeof EVIDENCE_SOURCE_IDS)[number];

/** A user-named Pi-format root is recorded as `custom`. */
export type EvidenceSource = EvidenceSourceId | "custom";

export type EvidenceEventKind =
  | "session_start"
  | "genome_change"
  | "user_turn"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "model_change"
  | "cwd_change"
  | "compaction"
  | "permission"
  | "subagent"
  | "error"
  | "other";

export type EvidenceOutcome = "ok" | "fail" | "unknown";

export interface EvidenceEvent {
  schema_version: typeof EVIDENCE_EVENT_SCHEMA_VERSION;
  /** Absolute real path of the transcript. */
  session: string;
  /** Increments when a transcript is truncated or rewritten. */
  generation: number;
  /** Absolute one-based line number in the transcript. */
  line: number;
  /** Zero-based index of this event among events from the same line. */
  seq: number;
  source: EvidenceSource;
  timestamp?: string;
  cwd?: string;
  /** Genome that was active when this event was recorded, if the store says. */
  genome_reference?: string;
  genome_id?: string;
  genome_base_directory?: string;
  kind: EvidenceEventKind;
  tool?: string;
  verb?: string;
  path_class?: string;
  /** Skill name when this call loads a skill (inline or file-backed). */
  skill?: string;
  /** Slash command a user turn started with, when the transcript kept it. */
  command?: string;
  call_id?: string;
  outcome?: EvidenceOutcome;
  signature?: string;
  quote?: string;
  /** Original type when `kind` is `other`, or a qualifier such as `sidechain`. */
  raw_type?: string;
}

export const MAX_QUOTE_CHARS = 200;

/** Collapse whitespace and bound the quote. */
export function clip(text: unknown, limit = MAX_QUOTE_CHARS): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

export function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Parse an argument blob that may already be an object or a JSON string. */
export function asObject(value: unknown): Record<string, any> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function eventKey(event: EvidenceEvent): string {
  return [
    event.session,
    event.generation,
    event.line,
    event.seq,
  ].join("\u0000");
}

export function emptyEventCounts(): Record<EvidenceEventKind, number> {
  return {
    session_start: 0,
    genome_change: 0,
    user_turn: 0,
    assistant_message: 0,
    tool_call: 0,
    tool_result: 0,
    model_change: 0,
    cwd_change: 0,
    compaction: 0,
    permission: 0,
    subagent: 0,
    error: 0,
    other: 0,
  };
}
