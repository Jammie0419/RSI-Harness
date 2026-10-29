/**
 * Session readers for the harnesses a user actually arrives with.
 *
 * Almost nobody has RSIH history on the day they first run this Genome, so the
 * evidence has to come from wherever they have been working. Six stores are
 * supported today:
 *
 *   rsih    <agentDir>/sessions/--<encoded cwd>--/<ts>_<uuid>.jsonl
 *   pi      ~/.pi/agent/sessions/--<encoded cwd>--/<ts>_<uuid>.jsonl
 *   claude  ~/.claude/projects/<encoded cwd>/<uuid>.jsonl
 *   codex   $CODEX_HOME/sessions/YYYY/MM/DD/*.jsonl (+ archived_sessions)
 *   copilot $COPILOT_HOME/session-state/<session id>/events.jsonl
 *   zcode   $ZCODE_HOME/cli/db/db.sqlite -- one SQLite store, every session
 *
 * RSIH and Pi share a schema. Claude Code's differs enough to need its own
 * reader but is shaped the same way: a JSONL file per session under a directory
 * named after the working directory. ZCode instead keeps one live SQLite
 * database, so its reader runs bounded read-only queries rather than sampling
 * file heads.
 *
 * Adding another harness means adding one entry to `SESSION_SOURCES` with its
 * own reader; nothing else in the scan path is format-aware.
 *
 * Every read is bounded. These stores get large -- the Pi store on the machine
 * this was written against held 117 MB across 152 sessions -- so transcripts are
 * sampled from their heads. Pi and Claude use 64 KiB; Codex and Copilot use
 * 2 MiB because injected context can precede the first real user turn. Limits
 * and malformed records are reported rather than presented as complete evidence.
 *
 * No model calls happen here, and no transcript body is returned to the caller.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
// Shipped unflagged since Node 22.13, safely inside this package's engines
// floor; a runtime without it fails the schema probe into `unreadable`.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Head window for a transcript we have to parse ourselves. */
const TRANSCRIPT_HEAD_BYTES = 64 * 1024;
const CODEX_HEAD_BYTES = 2 * 1024 * 1024;
const COPILOT_HEAD_BYTES = 2 * 1024 * 1024;
/** Prompts retained per session. Enough to characterise it, bounded for memory. */
const MAX_PROMPTS = 40;
/** Characters retained per prompt. */
const MAX_PROMPT_CHARS = 600;

const CWD_FIELD = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export type SamplingIssue =
  | "byte_limit"
  | "prompt_limit"
  | "prompt_truncated"
  | "malformed_json"
  | "no_user_events"
  | "workspace_changed"
  | "unattributed_prompts"
  | "unknown_user_source"
  | "invalid_cwd";

export interface SessionRecord {
  /** Source id: one of SESSION_SOURCES, or `custom` for a user-named root. */
  source: string;
  path: string;
  /** Working directory the session ran in. */
  cwd: string;
  bytes: number;
  created: Date;
  modified: Date;
  /** The user's own turns, truncated and capped. */
  prompts: string[];
  /** True when sampling covered attributable prompts without a coverage limit.
   * A file we could not read has no record at all; it is counted as an unreadable
   * skip. Text fidelity and malformed records stay in samplingIssues. */
  promptsComplete: boolean;
  samplingIssues: SamplingIssue[];
}

export type SkipReason = "filtered" | "unreadable" | "missing_metadata" | "unsupported_format";
export type SkippedFiles = Record<SkipReason, number>;
type TranscriptResult = SessionRecord | SkipReason;

function skippedFiles(): SkippedFiles {
  return { filtered: 0, unreadable: 0, missing_metadata: 0, unsupported_format: 0 };
}

export interface SourceScan {
  id: string;
  label: string;
  roots: string[];
  available: boolean;
  sessions: number;
  skippedFiles: SkippedFiles;
}

export interface ScanResult {
  sources: SourceScan[];
  records: SessionRecord[];
  unknownSources: string[];
  skippedFiles: SkippedFiles;
}

interface ReadContext {
  seen: Set<string>;
  skippedFiles: SkippedFiles;
}

function readContext(): ReadContext {
  return { seen: new Set(), skippedFiles: skippedFiles() };
}

/* ------------------------------------------------------------------ plumbing */

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Roots are directories for every store except ZCode's single db file. */
function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Read at most `bytes` from a regular file, closing it even on errors. */
function readHead(path: string, bytes: number) {
  let fd;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const buffer = Buffer.allocUnsafe(Math.min(bytes, stat.size));
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    return {
      text: buffer.subarray(0, read).toString("utf8"),
      complete: read === stat.size,
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Transcript files under a root, depth-bounded. */
function transcriptFiles(root: string, depth: number, unsupportedSuffixes: readonly string[] = []): string[] {
  if (depth < 0 || !existsSync(root) || !isDirectory(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const path = join(root, name);
    if (name.endsWith(".jsonl") || unsupportedSuffixes.some((suffix) => name.endsWith(suffix))) {
      files.push(path);
    } else if (isDirectory(path)) {
      files.push(...transcriptFiles(path, depth - 1, unsupportedSuffixes));
    }
  }
  return files;
}

/** Parse one record at a time; callers can stop without retaining the whole window. */
function* transcriptEntries(text: string, issues: Set<SamplingIssue>) {
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      issues.add("malformed_json");
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) yield entry;
    else issues.add("malformed_json");
  }
}

function readTranscriptHead(path: string, bytes = TRANSCRIPT_HEAD_BYTES) {
  const head = readHead(path, bytes);
  if (!head) return undefined;
  const issues = new Set<SamplingIssue>();
  let text = head.text;
  if (!head.complete) {
    issues.add("byte_limit");
    // Both record parsing and cwd fallback must ignore a cut line, including mid-UTF-8.
    text = text.slice(0, text.lastIndexOf("\n") + 1);
  }
  return { entries: transcriptEntries(text, issues), issues, text };
}

function promptsComplete(issues: Set<SamplingIssue>) {
  return !issues.has("byte_limit") && !issues.has("prompt_limit");
}

function push(prompts: string[], text: unknown, issues: Set<SamplingIssue>) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return;
  if (prompts.length >= MAX_PROMPTS) {
    issues.add("prompt_limit");
    return;
  }
  if (value.length > MAX_PROMPT_CHARS) issues.add("prompt_truncated");
  prompts.push(value.length > MAX_PROMPT_CHARS ? `${value.slice(0, MAX_PROMPT_CHARS)}...` : value);
}

function fileStat(path: string) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    return { bytes: stat.size, modified: stat.mtime, created: stat.birthtime ?? stat.mtime };
  } catch {
    return undefined;
  }
}

function timestamp(value: unknown, fallback: Date) {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

function extractCwd(head: string) {
  const match = CWD_FIELD.exec(head);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

/* ------------------------------------------------------- Pi / RSIH transcripts */

/** Text the user actually typed, ignoring tool results and other content parts. */
function piUserText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

function readPiTranscript(path: string, source: string): TranscriptResult {
  const stat = fileStat(path);
  if (!stat) return "unreadable";
  const head = readTranscriptHead(path);
  if (!head) return "unreadable";
  const { entries, issues, text } = head;
  let meta;
  const prompts: string[] = [];
  for (const entry of entries) {
    if (entry.type === "session") meta ??= entry;
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    push(prompts, piUserText(entry.message.content), issues);
    if (meta && issues.has("prompt_limit")) break;
  }
  const cwd = meta?.cwd ?? extractCwd(text);
  if (typeof cwd !== "string" || !cwd.trim()) return "missing_metadata";
  return {
    source,
    path,
    cwd,
    bytes: stat.bytes,
    created: timestamp(meta?.timestamp, stat.created),
    modified: stat.modified,
    prompts,
    promptsComplete: promptsComplete(issues),
    samplingIssues: [...issues],
  };
}

function readStore(
  roots: string[],
  source: string,
  reader: (path: string, source: string) => TranscriptResult,
  depth: number,
  context = readContext(),
  unsupportedSuffixes: readonly string[] = [],
  fileName?: string,
) {
  const records: SessionRecord[] = [];
  for (const root of roots) {
    for (const file of transcriptFiles(root, depth, unsupportedSuffixes)) {
      if (fileName && basename(file) !== fileName) continue;
      let identity: string;
      try {
        identity = realpathSync(file);
      } catch {
        context.skippedFiles.unreadable += 1;
        continue;
      }
      if (context.seen.has(identity)) continue;
      context.seen.add(identity);
      const result = unsupportedSuffixes.some((suffix) => file.endsWith(suffix))
        ? "unsupported_format" : reader(file, source);
      if (typeof result === "string") context.skippedFiles[result] += 1;
      else records.push(result);
    }
  }
  return records;
}

function readPiStore(roots: string[], source: string, context = readContext()) {
  return readStore(roots, source, readPiTranscript, 2, context);
}

/* ------------------------------------------------- Claude Code transcripts */

/**
 * True for a turn the user actually typed.
 *
 * Claude Code puts tool results, slash-command echoes and local command output
 * in `user` entries too. `promptSource` separates them outright, but it is not
 * present in transcripts written by older versions, so fall back to the shape:
 * genuine input is a plain string, and every machine-generated variant opens
 * with a wrapper tag (`<command-name>`, `<local-command-stdout>`, ...).
 */
function isClaudeTypedTurn(entry: any) {
  if (entry.type !== "user" || entry.isMeta === true) return false;
  const content = entry.message?.content;
  if (typeof content !== "string") return false;
  if (typeof entry.promptSource === "string") return entry.promptSource === "typed";
  return !content.trimStart().startsWith("<");
}

function readClaudeTranscript(path: string, source: string): TranscriptResult {
  const stat = fileStat(path);
  if (!stat) return "unreadable";
  const head = readTranscriptHead(path);
  if (!head) return "unreadable";
  const { entries, issues, text } = head;
  // The encoded directory name is lossy for paths that already contain dashes,
  // so take the cwd the entries carry.
  let located;
  const prompts: string[] = [];
  let first;
  for (const entry of entries) {
    if (typeof entry.cwd === "string" && entry.cwd) located ??= entry;
    if (!isClaudeTypedTurn(entry)) continue;
    first ??= entry.timestamp;
    push(prompts, entry.message.content, issues);
    if (located && issues.has("prompt_limit")) break;
  }
  const cwd = located?.cwd ?? extractCwd(text);
  if (typeof cwd !== "string" || !cwd.trim()) return "missing_metadata";
  return {
    source,
    path,
    cwd,
    bytes: stat.bytes,
    created: timestamp(first ?? located?.timestamp, stat.created),
    modified: stat.modified,
    prompts,
    promptsComplete: promptsComplete(issues),
    samplingIssues: [...issues],
  };
}

function readClaudeStore(roots: string[], source: string, context = readContext()) {
  return readStore(roots, source, readClaudeTranscript, 2, context);
}

/* ---------------------------------------------------------- Codex rollouts */

function readCodexTranscript(path: string, source: string): TranscriptResult {
  const stat = fileStat(path);
  if (!stat) return "unreadable";
  const head = readTranscriptHead(path, CODEX_HEAD_BYTES);
  if (!head) return "unreadable";
  const { entries, issues } = head;
  let meta;
  const prompts: string[] = [];
  let userEvents = false;
  let responseUser = false;
  for (const entry of entries) {
    if (entry.type === "session_meta" && meta === undefined) {
      meta = entry.payload;
      // Machine-generated tasks are deliberately excluded, not unreadable history.
      if (
        meta?.source === "subagent" || meta?.source === "internal" ||
        (meta?.source && typeof meta.source === "object" &&
          ("subagent" in meta.source || "internal" in meta.source)) ||
        (typeof meta?.thread_source === "string" && meta.thread_source !== "user")
      ) return "filtered";
    }
    // Look ahead to the 41st nonempty prompt: exactly 40 can still be complete.
    // Metadata can arrive late, so do not stop before it has been checked.
    if (meta && issues.has("prompt_limit")) break;
    const payload = entry.payload;
    if (entry.type === "response_item" && payload?.role === "user") responseUser = true;
    if (entry.type !== "event_msg" || payload?.type !== "user_message") continue;
    userEvents = true;
    if (typeof payload.message !== "string") {
      issues.add("malformed_json");
      continue;
    }
    // response_item mirrors can contain injected AGENTS.md/environment text.
    // Only the explicit user event is evidence; repeated real requests stay.
    push(prompts, payload.message, issues);
    if (meta && issues.has("prompt_limit")) break;
  }
  if (typeof meta?.cwd !== "string" || !meta.cwd.trim()) return "missing_metadata";
  if (responseUser && !userEvents) issues.add("no_user_events");
  return {
    source,
    path,
    cwd: meta.cwd,
    bytes: stat.bytes,
    created: timestamp(meta.timestamp, stat.created),
    modified: stat.modified,
    prompts,
    promptsComplete: promptsComplete(issues),
    samplingIssues: [...issues],
  };
}

/* ------------------------------------------------------ Copilot CLI events */

function readCopilotTranscript(path: string, source: string): TranscriptResult {
  const stat = fileStat(path);
  if (!stat) return "unreadable";
  const head = readTranscriptHead(path, COPILOT_HEAD_BYTES);
  if (!head) return "unreadable";
  const { entries, issues } = head;
  let cwd: string | undefined;
  let created: Date | undefined;
  let started = false;
  const prompts: string[] = [];
  for (const entry of entries) {
    const data = entry.data;
    if (entry.type === "session.start" && entry.agentId === undefined) {
      started = true;
      if (data?.detachedFromSpawningParentSessionId) return "filtered";
      created ??= timestamp(data?.startTime, timestamp(entry.timestamp, stat.created));
    }
    if (entry.agentId === undefined && (entry.type === "session.start" || entry.type === "session.resume" ||
        entry.type === "session.context_changed")) {
      const next = entry.type === "session.context_changed" ? data?.cwd : data?.context?.cwd;
      if (next !== undefined || entry.type === "session.context_changed") {
        if (typeof next !== "string" || !isAbsolute(next) || !next.trim()) {
          issues.add("invalid_cwd");
          if (prompts.length > 0) break;
          cwd = undefined;
          continue;
        }
        if (cwd && cwd !== next && prompts.length > 0) {
          issues.add("workspace_changed");
          break;
        }
        cwd = next;
      }
    }
    if (cwd && started && issues.has("prompt_limit")) break;
    if (entry.type !== "user.message" || entry.agentId !== undefined ||
        data?.isAutopilotContinuation === true) continue;
    if (data?.source !== undefined && data.source !== "user") {
      if (data.source !== "system" &&
          !(typeof data.source === "string" && data.source.startsWith("agent-"))) {
        issues.add("unknown_user_source");
      }
      continue;
    }
    if (typeof data?.content !== "string") {
      issues.add("malformed_json");
      continue;
    }
    if (!cwd) {
      issues.add("unattributed_prompts");
      continue;
    }
    push(prompts, data.content, issues);
  }
  if (!cwd) return "missing_metadata";
  return {
    source,
    path,
    cwd,
    bytes: stat.bytes,
    created: created ?? stat.created,
    modified: stat.modified,
    prompts,
    promptsComplete: promptsComplete(issues) &&
      !issues.has("workspace_changed") && !issues.has("unattributed_prompts") &&
      !issues.has("unknown_user_source") && !issues.has("invalid_cwd"),
    samplingIssues: [...issues],
  };
}

/* --------------------------------------------------- ZCode session store */

// ZCode keeps every session -- interactive and subagent alike -- in one live
// SQLite store instead of per-session files. The reader is therefore
// query-shaped: bounded statements replace the head-byte windows above, and a
// schema probe gates the whole source so an unrecognised layout (the schema is
// ZCode's private, migration-driven surface) is reported, never guessed at.
// The record-level contract lives in test/fixtures/zcode/README.md.
const ZCODE_DB_NAME = "db.sqlite";

const ZCODE_SESSIONS_SQL = `
  SELECT id, directory, time_created, time_updated, task_type, parent_id, time_deleted
  FROM session
  ORDER BY time_updated DESC`;

// ZCode's own semantics enum, read from its bundled app code, has five
// origins: real_user, agent_runtime, system, migration, import. Only real_user
// is typed input; the rest are known non-user content, so they are excluded
// without being reported as unknown. Its realUserInput projection also drops
// wrapper messages that carry synthetic/hidden markers or a compact summary
// even when the origin says real_user -- the subquery mirrors that rule.
// json_valid comes first because the json_* functions throw on malformed JSON.
// The 41st distinct real-user message proves the 40-prompt cap truncated
// coverage; the outer join then collects every text part of exactly those
// messages. Both sorts share the message key, so a change of mid starts the
// next prompt.
const ZCODE_PROMPTS_SQL = `
  SELECT m.id AS mid, p.data AS pdata
  FROM message m JOIN part p ON p.message_id = m.id
  WHERE m.id IN (
    SELECT id FROM message
    WHERE session_id = ?
      AND json_valid(data)
      AND json_extract(data, '$.role') = 'user'
      AND json_extract(data, '$.semantics.origin') = 'real_user'
      AND coalesce(json_extract(data, '$.synthetic'), 0) = 0
      AND coalesce(json_extract(data, '$.semantics.kind'), '') != 'compact_summary'
      AND json_extract(data, '$.summary') IS NULL
      AND coalesce(json_extract(data, '$.semantics.uiVisibility'), 'visible') != 'hidden'
      AND coalesce(json_extract(data, '$.semantics.transcriptVisibility'), 'visible') != 'hidden'
      AND coalesce(json_extract(data, '$.visibility'), 'visible') != 'hidden'
    ORDER BY coalesce(sequence, time_created), id
    LIMIT 41
  )
  AND json_valid(p.data)
  AND json_extract(p.data, '$.type') = 'text'
  ORDER BY coalesce(m.sequence, m.time_created), m.id, coalesce(p.sequence, p.time_created)`;

// A census, not a filter: an origin outside the known pair is reported as
// unknown_user_source instead of being silently dropped or trusted.
const ZCODE_ORIGINS_SQL = `
  SELECT DISTINCT json_extract(data, '$.semantics.origin') AS origin
  FROM message
  WHERE session_id = ? AND json_valid(data)
    AND json_extract(data, '$.role') = 'user'`;

// Rows the json_* guards above skip are coverage damage, so count them.
const ZCODE_MALFORMED_SQL = `
  SELECT (SELECT COUNT(*) FROM message WHERE session_id = ? AND NOT json_valid(data)) +
         (SELECT COUNT(*) FROM part    WHERE session_id = ? AND NOT json_valid(data)) AS n`;

// A stand-in for transcript size, used only for a workspace's sense of scale.
const ZCODE_BYTES_SQL = `
  SELECT (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM message WHERE session_id = ?) +
         (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM part    WHERE session_id = ?) AS bytes`;

// Every origin ZCode itself defines is known; only a new one gets reported.
const ZCODE_KNOWN_ORIGINS = new Set([
  "real_user",
  "agent_runtime",
  "system",
  "migration",
  "import",
]);

// ZCode has no home override of its own; ZCODE_HOME is an rsih-side knob so
// tests and unusual installs can point at another store.
function zcodeHome() {
  return process.env.ZCODE_HOME?.trim() || join(homedir(), ".zcode");
}

interface ZcodeDatabase {
  db: DatabaseSync;
  dispose: () => void;
}

// The store is written while ZCode runs, so it is only ever opened read-only
// (query_only is a second belt for runtimes that ignore the open option). WAL
// lets this reader work beside the writer; if the platform still refuses --
// missing -shm permission, an exotic lock state -- retry against a temp copy
// of db.sqlite with its -wal/-shm siblings. Nothing here ever writes.
function openZcodeDatabase(path: string): ZcodeDatabase | undefined {
  try {
    const db = openReadOnlyZcode(path);
    return { db, dispose: () => db.close() };
  } catch {
    // Fall through to the copy below.
  }
  const dir = mkdtempSync(join(tmpdir(), "rsih-zcode-"));
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${path}${suffix}`;
      if (existsSync(source)) copyFileSync(source, join(dir, `${ZCODE_DB_NAME}${suffix}`));
    }
    const db = openReadOnlyZcode(join(dir, ZCODE_DB_NAME));
    return {
      db,
      dispose: () => {
        db.close();
        discardTempZcode(dir);
      },
    };
  } catch {
    discardTempZcode(dir);
    return undefined;
  }
}

// Windows can briefly hold a freshly copied temp file (antivirus, indexer);
// retries usually clear it, and a leftover temp dir is harmless next to a
// broken store -- cleanup must never mask the real failure.
function discardTempZcode(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  } catch {
    // A leftover temp directory is acceptable.
  }
}

function openReadOnlyZcode(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.exec("PRAGMA query_only = 1");
    // SQLite defers reading the file until the first statement, so force the
    // page-1 header read here: a non-SQLite file is rejected as unreadable now
    // instead of resurfacing later as an unknown schema.
    db.prepare("PRAGMA schema_version").get();
    return db;
  } catch (error) {
    // A constructed-but-rejected connection still holds the file open.
    db.close();
    throw error;
  }
}

// PRAGMA table_info on an absent table returns no rows, which the column
// check reads the same as a missing table.
const ZCODE_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  session: ["id", "directory", "time_created", "time_updated", "task_type", "parent_id", "time_deleted"],
  message: ["id", "session_id", "data", "sequence"],
  part: ["id", "message_id", "session_id", "data", "sequence"],
};

function zcodeSchemaReady(db: DatabaseSync): boolean {
  for (const [table, columns] of Object.entries(ZCODE_REQUIRED_COLUMNS)) {
    let rows: Record<string, any>[];
    try {
      rows = db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, any>[];
    } catch {
      return false;
    }
    const present = new Set(rows.map((row) => row.name));
    for (const column of columns) {
      if (!present.has(column)) return false;
    }
  }
  return true;
}

function zcodeDate(value: unknown): Date | undefined {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value) : undefined;
}

interface ZcodeStatements {
  prompts: StatementSync;
  origins: StatementSync;
  malformed: StatementSync;
  bytes: StatementSync;
}

function zcodeSessionRecord(
  statements: ZcodeStatements,
  dbPath: string,
  source: string,
  session: Record<string, any>,
  storeFallback: { created: Date; modified: Date },
): SessionRecord | SkipReason {
  // Subagent and deleted sessions are deliberately excluded, not unreadable
  // history -- the call codex makes on its own machine-generated threads.
  if (
    session.task_type !== "interactive" ||
    session.parent_id !== null ||
    session.time_deleted !== null
  ) {
    return "filtered";
  }
  const cwd = typeof session.directory === "string" ? session.directory.trim() : "";
  if (!cwd) return "missing_metadata";

  const issues = new Set<SamplingIssue>();
  const prompts: string[] = [];
  let current: { id: unknown; text: string[] } | undefined;
  for (const row of statements.prompts.all(session.id) as Record<string, any>[]) {
    if (current && current.id !== row.mid) {
      push(prompts, current.text.join(" "), issues);
      current = undefined;
    }
    current ??= { id: row.mid, text: [] };
    // json_valid guarded the row in SQL; text can still be absent on an
    // exotic part, and push() drops an empty join anyway.
    current.text.push(String(JSON.parse(row.pdata)?.text ?? ""));
  }
  if (current) push(prompts, current.text.join(" "), issues);

  for (const row of statements.origins.all(session.id) as Record<string, any>[]) {
    if (!ZCODE_KNOWN_ORIGINS.has(row.origin)) issues.add("unknown_user_source");
  }
  const [malformed] = statements.malformed.all(session.id, session.id) as Record<string, any>[];
  if (Number(malformed?.n) > 0) issues.add("malformed_json");
  const [size] = statements.bytes.all(session.id, session.id) as Record<string, any>[];

  return {
    source,
    path: `${dbPath}#${session.id}`,
    cwd,
    bytes: Number(size?.bytes) || 0,
    created: zcodeDate(session.time_created) ?? storeFallback.created,
    modified: zcodeDate(session.time_updated) ?? storeFallback.modified,
    prompts,
    promptsComplete: promptsComplete(issues) && !issues.has("unknown_user_source"),
    samplingIssues: [...issues],
  };
}

function readZcodeStore(dbPath: string, source: string, context: ReadContext): SessionRecord[] {
  let realPath: string;
  try {
    realPath = realpathSync(dbPath);
  } catch {
    return [];
  }
  if (context.seen.has(realPath)) return [];
  context.seen.add(realPath);

  const stat = fileStat(dbPath);
  const storeFallback = {
    created: stat?.created ?? new Date(0),
    modified: stat?.modified ?? new Date(0),
  };
  const store = openZcodeDatabase(dbPath);
  if (!store) {
    context.skippedFiles.unreadable += 1;
    return [];
  }
  try {
    if (!zcodeSchemaReady(store.db)) {
      context.skippedFiles.unsupported_format += 1;
      return [];
    }
    const records: SessionRecord[] = [];
    const sessions = store.db.prepare(ZCODE_SESSIONS_SQL).all() as Record<string, any>[];
    const statements: ZcodeStatements = {
      prompts: store.db.prepare(ZCODE_PROMPTS_SQL),
      origins: store.db.prepare(ZCODE_ORIGINS_SQL),
      malformed: store.db.prepare(ZCODE_MALFORMED_SQL),
      bytes: store.db.prepare(ZCODE_BYTES_SQL),
    };
    for (const session of sessions) {
      const result = zcodeSessionRecord(statements, dbPath, source, session, storeFallback);
      if (typeof result === "string") context.skippedFiles[result] += 1;
      else records.push(result);
    }
    return records;
  } finally {
    store.dispose();
  }
}

/* --------------------------------------------------------------------- sources */

interface SourceDefinition {
  id: string;
  label: string;
  roots: () => string[];
  /** How to prove the store exists; roots may be a file, not just a directory. */
  exists?: (path: string) => boolean;
  /** Discover these suffixes to report unsupported files without opening them. */
  unsupportedSuffixes?: readonly string[];
  read: (roots: string[], context?: ReadContext) => SessionRecord[];
}

/**
 * `rsih` is first because it is the only store this tool owns. The others are
 * here because they are why someone can use this Genome on day one, before they
 * have any RSIH history at all.
 */
export const SESSION_SOURCES: readonly SourceDefinition[] = Object.freeze([
  {
    id: "rsih",
    label: "RSIH",
    roots: () => [join(getAgentDir(), "sessions")],
    read: (roots, context) => readPiStore(roots, "rsih", context),
  },
  {
    id: "pi",
    label: "Pi",
    roots: () => [join(homedir(), ".pi", "agent", "sessions")],
    read: (roots, context) => readPiStore(roots, "pi", context),
  },
  {
    id: "claude",
    label: "Claude Code",
    roots: () => [join(homedir(), ".claude", "projects")],
    read: (roots, context) => readClaudeStore(roots, "claude", context),
  },
  {
    id: "codex",
    label: "Codex",
    roots: () => {
      const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
      return [join(home, "sessions"), join(home, "archived_sessions")];
    },
    unsupportedSuffixes: [".jsonl.zst"],
    read(roots, context) {
      return readStore(roots, "codex", readCodexTranscript, 3, context, this.unsupportedSuffixes);
    },
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    roots: () => [join(process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot"), "session-state")],
    read: (roots, context) => readStore(roots, "copilot", readCopilotTranscript, 1, context, [], "events.jsonl"),
  },
  {
    id: "zcode",
    label: "ZCode",
    // One SQLite file holds every ZCode session on the machine; the reader
    // queries it in place, read-only. The synthetic record path appends
    // `#<session id>` so a focused scan can hand back per-session keys.
    roots: () => [join(zcodeHome(), "cli", "db", ZCODE_DB_NAME)],
    exists: isFile,
    read: (roots, context) => roots.flatMap((root) => readZcodeStore(root, "zcode", context ?? readContext())),
  },
]);

export const DEFAULT_SOURCE_IDS = Object.freeze(["rsih"]);

export function sourceIds() {
  return SESSION_SOURCES.map((source) => source.id);
}

/**
 * Read the requested sources. Unknown ids are reported rather than ignored, so a
 * typo does not look like an empty history.
 */
export function readSessions(
  requested: readonly string[] = DEFAULT_SOURCE_IDS,
  extraRoots: readonly string[] = [],
): ScanResult {
  const wanted = new Set(requested.map((id) => String(id).toLowerCase().trim()));
  const known = new Set(sourceIds());
  const unknownSources = [...wanted].filter((id) => !known.has(id));

  const sources: SourceScan[] = [];
  const records: SessionRecord[] = [];
  const context = readContext();
  for (const source of SESSION_SOURCES) {
    if (!wanted.has(source.id)) continue;
    const roots = source.roots();
    const available = roots.some(source.exists ?? isDirectory);
    const previousSkipped = { ...context.skippedFiles };
    const found = available ? source.read(roots, context) : [];
    records.push(...found);
    sources.push({
      id: source.id,
      label: source.label,
      roots,
      available,
      sessions: found.length,
      skippedFiles: Object.fromEntries(
        Object.entries(context.skippedFiles).map(([reason, count]) => [reason, count - previousSkipped[reason]]),
      ) as SkippedFiles,
    });
  }

  // Known stores claim a file before custom roots, so aliases do not relabel it
  // as custom or inflate either the workspace's session count or its evidence.
  records.push(...readPiStore([...extraRoots], "custom", context));
  return { sources, records, unknownSources, skippedFiles: context.skippedFiles };
}
