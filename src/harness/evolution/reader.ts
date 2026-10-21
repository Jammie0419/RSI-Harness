/**
 * Full-stream transcript reader for the evolution subsystem.
 *
 * Unlike the interactive workspace scanner, this reader never samples: it
 * consumes every complete line from a byte offset and turns it into normalized
 * events. The offset is always a line boundary, so a transcript that is still
 * being appended to can be resumed without losing or duplicating a line.
 *
 * The four schemas are translated here and nowhere else. A record type this
 * reader does not understand is counted under `other` instead of disappearing;
 * a schema change is therefore visible in coverage rather than silent.
 */

import {
  closeSync,
  createReadStream,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, extname, isAbsolute, relative } from "node:path";
import * as zlib from "node:zlib";
import {
  EVIDENCE_EVENT_SCHEMA_VERSION,
  asObject,
  clip,
  emptyEventCounts,
  isRecord,
  type EvidenceEvent,
  type EvidenceEventKind,
  type EvidenceOutcome,
  type EvidenceSource,
} from "./events.ts";
import { zstdSupported } from "./sources.ts";

const MAX_OTHER_EVENTS = 20;
const MAX_OTHER_PER_TYPE = 3;
const MAX_MALFORMED_EVENTS = 10;

const SHELL_TOOLS = new Set([
  "bash",
  "sh",
  "zsh",
  "shell",
  "exec_command",
  "run_command",
  "terminal",
  "powershell",
  "pwsh",
]);
const FILE_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "multiedit",
  "multi_edit",
  "apply_patch",
  "applypatch",
  "open",
  "create",
]);
const MACHINE_SEGMENTS = new Set([
  "mnt",
  "media",
  "run",
  "home",
  "users",
  "user",
  "tmp",
  "var",
  "opt",
  "etc",
  "usr",
  "root",
  "workspace",
  "workspaces",
]);

export interface FileScanSummary {
  session: string;
  source: EvidenceSource;
  size: number;
  mtimeMs: number;
  cwd: string;
  sessionId?: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  linesRead: number;
  malformed: number;
  calls: number;
  userTurns: number;
  assistantMessages: number;
  failures: number;
  successes: number;
  unknownOutcomes: number;
  filtered?: string;
  unsupported?: string;
  error?: string;
  genomeReferences?: string[];
  genomeIds?: string[];
  /** Skill names loaded through `load_skill` or a skill-file `read`. */
  skills?: string[];
  eventCounts: Record<EvidenceEventKind, number>;
  unknownTypes: Record<string, number>;
}

export interface ReadEvidenceFileOptions {
  startOffset?: number;
  startLine?: number;
  generation?: number;
  cwd?: string;
}

export interface ReadEvidenceFileResult {
  events: EvidenceEvent[];
  summary: FileScanSummary;
}

interface ReaderState {
  session: string;
  source: EvidenceSource;
  generation: number;
  cwd: string;
  sessionId?: string;
  model?: string;
  genomeReference?: string;
  genomeId?: string;
  genomeBaseDirectory?: string;
  genomeReferences: Set<string>;
  genomeIds: Set<string>;
  skills: Set<string>;
  events: EvidenceEvent[];
  counts: Record<EvidenceEventKind, number>;
  unknownTypes: Record<string, number>;
  otherPerType: Map<string, number>;
  otherEmitted: number;
  malformedEvents: number;
  calls: number;
  results: number;
  failures: number;
  successes: number;
  unknownResults: number;
  userTurns: number;
  assistantMessages: number;
  linesRead: number;
  malformed: number;
  filtered?: string;
  error?: string;
}

/**
 * Pi expands prompt templates before recording the user message, so this is a
 * weak signal: it only fires when the transcript kept the literal `/name`.
 */
function commandFromUserText(text: string): string | undefined {
  const match = /^\s*\/([^\s/]+)/.exec(text);
  return match?.[1];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function outcomeOfFlag(value: unknown): EvidenceOutcome | undefined {
  if (value === true) return "fail";
  if (value === false) return "ok";
  return undefined;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (!isRecord(part)) continue;
      if (typeof part.text === "string") {
        parts.push(part.text);
        continue;
      }
      if (part.type === "tool_result" || part.type === "toolResult") {
        if (typeof part.content === "string") parts.push(part.content);
        else parts.push(textOfContent(part.content));
        continue;
      }
      if (typeof part.content === "string") parts.push(part.content);
    }
    return parts.join(" ").trim();
  }
  if (isRecord(content)) {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function commandOf(tool: string, args: Record<string, any>): string | undefined {
  if (!SHELL_TOOLS.has(tool)) return undefined;
  const raw = args.command ?? args.cmd ?? args.script ?? args.input;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const strings = raw.filter((part) => typeof part === "string");
    return strings.length > 0 ? strings[strings.length - 1] : undefined;
  }
  return undefined;
}

function unwrapShell(command: string): string {
  const words = command.trim().split(/\s+/);
  if (words.length < 3) return command;
  const shell = words[0].toLowerCase();
  if (!["bash", "sh", "zsh", "powershell", "pwsh"].includes(shell)) return command;
  const flagIndex = words.findIndex((word) =>
    ["-c", "-lc", "-Command", "-command", "/c", "/C"].includes(word),
  );
  if (flagIndex < 0 || flagIndex >= words.length - 1) return command;
  return words.slice(flagIndex + 1).join(" ");
}

function verbOf(command: string | undefined): string {
  if (!command) return "";
  const unwrapped = unwrapShell(command);
  const firstLine = unwrapped.split("\n").find((line) => line.trim().length > 0) ?? "";
  const segments = firstLine.split(/&&|\|\||;|\|/);
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const words = trimmed.split(/\s+/);
    if (words[0] === "cd" && words.length > 1) continue;
    if (["sudo", "env", "time", "command", "builtin"].includes(words[0]) && words.length > 1) {
      words.shift();
    }
    const word = (words[0] ?? "").replace(/^["']|["']$/g, "");
    if (!word || word.startsWith("-")) continue;
    if (word.includes("/") || word.includes("\\")) return basename(word).toLowerCase();
    return word.toLowerCase();
  }
  return "";
}

function pathOf(
  tool: string,
  args: Record<string, any>,
  command: string | undefined,
): string | undefined {
  if (FILE_TOOLS.has(tool)) {
    const raw = args.file_path ?? args.filePath ?? args.path ?? args.target_file ?? args.file;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    return undefined;
  }
  if (!command) return undefined;

  const withoutChdir = command.replace(
    /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;|\n)/,
    "$2",
  );
  const tokens = withoutChdir.split(/\s+/);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].replace(/^["']|["']$/g, "");
    if (!token) continue;
    if (token.startsWith("-")) continue;
    if (/[=(){}$`<>]/.test(token)) continue;
    if (token.includes("://")) continue;
    if (index === 0 && !token.includes("/") && !token.includes("\\")) continue;
    const absolute = token.startsWith("/") || /^[A-Za-z]:[\\/]/.test(token);
    const segments = token.split(/[\\/]+/).filter(Boolean);
    if (!absolute && segments.length < 2) continue;
    return token;
  }
  return undefined;
}

function stripMachinePrefix(segments: string[]): string[] {
  while (segments.length > 1) {
    const head = segments[0].toLowerCase();
    if (head === "mnt" && segments.length > 2 && /^[a-z]$/.test(segments[1].toLowerCase())) {
      segments.splice(0, 2);
      continue;
    }
    if (/^[a-z]:$/.test(head)) {
      segments.shift();
      continue;
    }
    if (!MACHINE_SEGMENTS.has(head)) break;
    segments.shift();
    if (
      (head === "home" || head === "users" || head === "user") &&
      segments.length >= 2
    ) {
      segments.shift();
    }
  }
  return segments;
}

function classifyPath(path: string | undefined, cwd: string): string {
  if (!path) return "";
  let candidate = path;
  let outside = false;
  if (isAbsolute(path) && cwd) {
    const rel = relative(cwd, path);
    if (rel === "") return "";
    if (!rel.startsWith("..")) candidate = rel;
    else outside = true;
  } else if (isAbsolute(path)) {
    outside = true;
  }

  let segments = candidate.split(/[\\/]+/).filter(Boolean);
  if (outside) segments = stripMachinePrefix(segments);
  const name = segments.pop() ?? "";
  const rawExt = extname(name);
  const ext = /^\.[A-Za-z][A-Za-z0-9]*$/.test(rawExt) ? rawExt : "";
  const firstDir = segments[0];
  if (firstDir) return `${firstDir}/*${ext}`;
  if (ext) return `*${ext}`;
  return "";
}

function isLineBoundary(path: string, offset: number): boolean {
  if (offset <= 0) return true;
  let fd;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(1);
    const read = readSync(fd, buffer, 0, 1, offset - 1);
    return read === 1 && buffer[0] === 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function* readCompleteLines(
  path: string,
  startOffset: number,
  startLine: number,
  discardPartialFirstLine: boolean,
): AsyncGenerator<{ text: string; line: number; offset: number }> {
  const input = createReadStream(path, {
    start: startOffset,
    highWaterMark: 64 * 1024,
  });
  let buffer = Buffer.alloc(0);
  let offset = startOffset;
  let line = startLine;
  let discard = discardPartialFirstLine;

  for await (const chunk of input) {
    buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk as Buffer]) : (chunk as Buffer);
    let newline = buffer.indexOf(0x0a);
    while (newline >= 0) {
      const raw = buffer.subarray(0, newline);
      const consumed = newline + 1;
      buffer = buffer.subarray(consumed);
      offset += consumed;
      if (discard) {
        discard = false;
      } else {
        let text = raw.toString("utf8");
        if (text.endsWith("\r")) text = text.slice(0, -1);
        yield { text, line, offset };
        line += 1;
      }
      newline = buffer.indexOf(0x0a);
    }
  }
  // Anything left in `buffer` is a torn final line. It is deliberately not
  // yielded; the next scan resumes at `offset`, which is still a line boundary.
}

function emit(
  state: ReaderState,
  line: number,
  seq: number,
  kind: EvidenceEventKind,
  fields: Partial<EvidenceEvent> = {},
): number {
  const event: EvidenceEvent = {
    schema_version: EVIDENCE_EVENT_SCHEMA_VERSION,
    session: state.session,
    generation: state.generation,
    line,
    seq,
    source: state.source,
    cwd: state.cwd || undefined,
    genome_reference: state.genomeReference,
    genome_id: state.genomeId,
    genome_base_directory: state.genomeBaseDirectory,
    kind,
    ...fields,
  };
  state.events.push(event);
  state.counts[kind] += 1;
  return seq + 1;
}

function emitOther(
  state: ReaderState,
  line: number,
  seq: number,
  rawType: string,
  quote: string,
  timestamp?: string,
): number {
  state.unknownTypes[rawType] = (state.unknownTypes[rawType] ?? 0) + 1;
  const perType = state.otherPerType.get(rawType) ?? 0;
  if (state.otherEmitted >= MAX_OTHER_EVENTS || perType >= MAX_OTHER_PER_TYPE) {
    return seq;
  }
  state.otherPerType.set(rawType, perType + 1);
  state.otherEmitted += 1;
  return emit(state, line, seq, "other", {
    raw_type: rawType,
    quote: clip(quote),
    timestamp,
  });
}

function emitMalformed(state: ReaderState, line: number, seq: number, text: string): number {
  state.malformed += 1;
  if (state.malformedEvents >= MAX_MALFORMED_EVENTS) return seq;
  state.malformedEvents += 1;
  return emit(state, line, seq, "error", {
    raw_type: "malformed_json",
    quote: clip(text),
  });
}

/**
 * The skill a call refers to.
 *
 * Inline skills are loaded with `load_skill`; file-backed skills are announced
 * by Pi and the agent is told to `read` the skill file. Both are usage
 * evidence, so both map to the same `skill` field.
 */
function skillForCall(
  tool: string,
  args: Record<string, any>,
  path: string | undefined,
): string | undefined {
  if (tool === "load_skill") {
    return firstString(args.name, args.skill, args.skill_name);
  }
  if (!path) return undefined;
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const index = segments.findIndex(
    (segment) => segment.toLowerCase() === "skills",
  );
  if (index < 0 || index + 1 >= segments.length) return undefined;
  const name = segments[index + 1];
  if (!name || name.toLowerCase() === "skill.md") return undefined;
  return name.replace(/\.md$/i, "");
}

function emitToolCall(
  state: ReaderState,
  line: number,
  seq: number,
  name: unknown,
  args: unknown,
  callId: unknown,
  extra: Partial<EvidenceEvent> = {},
): number {
  const tool = String(name ?? "").trim().toLowerCase() || "unknown";
  const values = asObject(args);
  const command = commandOf(tool, values);
  const verb = verbOf(command);
  const path = pathOf(tool, values, command);
  const pathClass = classifyPath(path, state.cwd);
  const skill = skillForCall(tool, values, path);
  if (skill) state.skills.add(skill);
  const signature = [tool, verb, pathClass].filter(Boolean).join("|");
  state.calls += 1;
  return emit(state, line, seq, "tool_call", {
    ...extra,
    tool,
    verb: verb || undefined,
    path_class: pathClass || undefined,
    skill,
    call_id: typeof callId === "string" ? callId : undefined,
    signature,
    quote: clip(command ?? path ?? tool),
  });
}

function emitToolResult(
  state: ReaderState,
  line: number,
  seq: number,
  callId: unknown,
  outcome: EvidenceOutcome | undefined,
  toolName: unknown,
  text: unknown,
  extra: Partial<EvidenceEvent> = {},
): number {
  const resolved = outcome ?? "unknown";
  state.results += 1;
  if (resolved === "fail") state.failures += 1;
  else if (resolved === "ok") state.successes += 1;
  else state.unknownResults += 1;
  return emit(state, line, seq, "tool_result", {
    ...extra,
    call_id: typeof callId === "string" ? callId : undefined,
    outcome: resolved,
    tool: typeof toolName === "string" ? toolName.toLowerCase() : undefined,
    quote: clip(text),
  });
}

function codexOutcome(payload: Record<string, any>): EvidenceOutcome | undefined {
  const flag = outcomeOfFlag(payload.success);
  if (flag) return flag;
  const output = payload.output;
  if (typeof output === "string") {
    const match = /Process exited with code (-?\d+)/.exec(output);
    if (match) return Number(match[1]) === 0 ? "ok" : "fail";
  }
  return undefined;
}

function processPi(entry: Record<string, any>, state: ReaderState, line: number, timestamp?: string): boolean {
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type === "session") {
    state.sessionId ??= firstString(entry.id, entry.sessionId);
    let seq = emit(state, line, 0, "session_start", {
      timestamp,
      quote: clip(state.cwd),
      raw_type: "session",
    });
    if (entry.parentSessionId || entry.subagent === true) {
      seq = emit(state, line, seq, "subagent", {
        timestamp,
        raw_type: "session",
      });
    }
    return true;
  }

  if (type === "message") {
    const message = isRecord(entry.message) ? entry.message : {};
    const role = message.role;
    if (role === "user") {
      const text = textOfContent(message.content);
      if (text) {
        state.userTurns += 1;
        emit(state, line, 0, "user_turn", {
          timestamp,
          quote: clip(text),
          command: commandFromUserText(text),
        });
      }
      return true;
    }
    if (role === "assistant") {
      let seq = 0;
      let assistantText = "";
      const parts = asArray(message.content);
      for (const rawPart of parts) {
        if (!isRecord(rawPart)) continue;
        if (rawPart.type === "toolCall" && typeof rawPart.name === "string") {
          seq = emitToolCall(
            state,
            line,
            seq,
            rawPart.name,
            rawPart.arguments,
            rawPart.id,
            { timestamp },
          );
        } else if (rawPart.type === "text" && typeof rawPart.text === "string") {
          assistantText += ` ${rawPart.text}`;
        } else if (typeof rawPart.type === "string") {
          seq = emitOther(state, line, seq, rawPart.type, textOfContent(rawPart), timestamp);
        }
      }
      if (typeof message.content === "string") assistantText = message.content;
      if (assistantText.trim()) {
        state.assistantMessages += 1;
        emit(state, line, seq, "assistant_message", {
          timestamp,
          quote: clip(assistantText),
        });
      }
      return true;
    }
    if (role === "toolResult" || role === "tool_result") {
      emitToolResult(
        state,
        line,
        0,
        message.toolCallId ?? message.tool_call_id,
        outcomeOfFlag(message.isError ?? message.is_error),
        message.toolName ?? message.tool_name,
        textOfContent(message.content),
        { timestamp },
      );
      return true;
    }
    if (typeof role === "string") {
      emitOther(state, line, 0, `message.${role}`, textOfContent(message.content), timestamp);
      return true;
    }
  }

  if (type.includes("compaction") || type.includes("compact")) {
    emit(state, line, 0, "compaction", { timestamp, raw_type: type });
    return true;
  }
  if (type.includes("permission")) {
    emit(state, line, 0, "permission", { timestamp, raw_type: type });
    return true;
  }
  if (type === "model_change") {
    emit(state, line, 0, "model_change", { timestamp, raw_type: type });
    return true;
  }
  if (type === "subagent") {
    emit(state, line, 0, "subagent", { timestamp, raw_type: type });
    return true;
  }
  return false;
}

function processClaude(entry: Record<string, any>, state: ReaderState, line: number, timestamp?: string): boolean {
  const type = typeof entry.type === "string" ? entry.type : "";
  const sidechain = entry.isSidechain === true;
  const extra: Partial<EvidenceEvent> = sidechain ? { raw_type: "sidechain" } : {};

  if (type === "user") {
    if (entry.isMeta === true) {
      emitOther(state, line, 0, "meta", textOfContent(entry.message?.content), timestamp);
      return true;
    }
    const content = entry.message?.content;
    // Claude Desktop records real typed input with promptSource "sdk"; older
    // transcripts omit the field. Only system/tool/command sources are machine
    // text. Treating anything other than "typed" as machine-generated drops
    // real user turns, which is worse than letting one command echo through.
    const promptSource =
      typeof entry.promptSource === "string"
        ? entry.promptSource.toLowerCase()
        : "";
    const machinePrompt = [
      "system",
      "tool",
      "command",
      "local-command",
      "hook",
      "agent",
    ].includes(promptSource);
    if (typeof content === "string") {
      const filtered =
        machinePrompt || content.trimStart().startsWith("<");
      if (filtered) {
        emitOther(state, line, 0, "prompt_source", content, timestamp);
      } else {
        state.userTurns += 1;
        emit(state, line, 0, "user_turn", {
          ...extra,
          timestamp,
          quote: clip(content),
          command: commandFromUserText(content),
        });
      }
      return true;
    }
    let seq = 0;
    let userText = "";
    for (const rawPart of asArray(content)) {
      if (!isRecord(rawPart)) continue;
      if (rawPart.type === "tool_result" || rawPart.type === "toolResult") {
        seq = emitToolResult(
          state,
          line,
          seq,
          rawPart.tool_use_id ?? rawPart.toolUseId ?? rawPart.id,
          outcomeOfFlag(rawPart.is_error ?? rawPart.isError),
          rawPart.tool_name ?? rawPart.toolName,
          textOfContent(rawPart.content),
          { ...extra, timestamp },
        );
      } else if (rawPart.type === "text" && typeof rawPart.text === "string") {
        if (machinePrompt) {
          seq = emitOther(state, line, seq, "prompt_source", rawPart.text, timestamp);
        } else {
          userText += ` ${rawPart.text}`;
        }
      } else if (typeof rawPart.type === "string") {
        seq = emitOther(state, line, seq, rawPart.type, textOfContent(rawPart), timestamp);
      }
    }
    if (userText.trim()) {
      state.userTurns += 1;
      emit(state, line, seq, "user_turn", {
        ...extra,
        timestamp,
        quote: clip(userText),
        command: commandFromUserText(userText),
      });
    }
    return true;
  }

  if (type === "assistant") {
    let seq = 0;
    let assistantText = "";
    for (const rawPart of asArray(entry.message?.content)) {
      if (!isRecord(rawPart)) continue;
      if (rawPart.type === "tool_use" && typeof rawPart.name === "string") {
        seq = emitToolCall(
          state,
          line,
          seq,
          rawPart.name,
          rawPart.input,
          rawPart.id,
          { ...extra, timestamp },
        );
      } else if (rawPart.type === "text" && typeof rawPart.text === "string") {
        assistantText += ` ${rawPart.text}`;
      } else if (typeof rawPart.type === "string") {
        seq = emitOther(state, line, seq, rawPart.type, textOfContent(rawPart), timestamp);
      }
    }
    if (typeof entry.message?.content === "string") assistantText = entry.message.content;
    if (assistantText.trim()) {
      state.assistantMessages += 1;
      emit(state, line, seq, "assistant_message", {
        ...extra,
        timestamp,
        quote: clip(assistantText),
      });
    }
    return true;
  }

  if (type === "summary" || entry.isCompactSummary === true) {
    emit(state, line, 0, "compaction", { timestamp, raw_type: type || "summary" });
    return true;
  }
  if (type.includes("permission")) {
    emit(state, line, 0, "permission", { timestamp, raw_type: type });
    return true;
  }
  return false;
}

function processCodex(entry: Record<string, any>, state: ReaderState, line: number, timestamp?: string): boolean {
  const type = typeof entry.type === "string" ? entry.type : "";
  const payload = isRecord(entry.payload) ? entry.payload : {};

  if (type === "session_meta") {
    const source = payload.source;
    const subagent =
      source === "subagent" ||
      source === "internal" ||
      (isRecord(source) && ("subagent" in source || "internal" in source)) ||
      (typeof payload.thread_source === "string" && payload.thread_source !== "user");
    if (subagent) {
      state.filtered = "subagent";
      return true;
    }
    state.sessionId ??= firstString(payload.id, payload.session_id);
    emit(state, line, 0, "session_start", {
      timestamp,
      quote: clip(state.cwd),
      raw_type: "session_meta",
    });
    return true;
  }

  if (type === "response_item") {
    const payloadType = typeof payload.type === "string" ? payload.type : "";
    if (payloadType === "function_call" && typeof payload.name === "string") {
      emitToolCall(state, line, 0, payload.name, payload.arguments, payload.call_id ?? payload.id, {
        timestamp,
      });
      return true;
    }
    if (payloadType === "local_shell_call") {
      const command = payload.action?.command ?? payload.command;
      emitToolCall(
        state,
        line,
        0,
        "local_shell",
        { command },
        payload.call_id ?? payload.id,
        { timestamp },
      );
      return true;
    }
    if (payloadType === "custom_tool_call" && typeof payload.name === "string") {
      emitToolCall(state, line, 0, payload.name, { input: payload.input }, payload.call_id ?? payload.id, {
        timestamp,
      });
      return true;
    }
    if (payloadType === "function_call_output") {
      emitToolResult(
        state,
        line,
        0,
        payload.call_id,
        codexOutcome(payload),
        undefined,
        payload.output,
        { timestamp },
      );
      return true;
    }
    if (payloadType === "message") {
      if (payload.role === "assistant") {
        state.assistantMessages += 1;
        emit(state, line, 0, "assistant_message", {
          timestamp,
          quote: clip(textOfContent(payload.content)),
        });
      } else {
        emitOther(state, line, 0, `response_item.${payload.role ?? "message"}`, textOfContent(payload.content), timestamp);
      }
      return true;
    }
    if (payloadType === "reasoning") {
      emitOther(state, line, 0, "reasoning", textOfContent(payload.summary ?? payload.content), timestamp);
      return true;
    }
    if (payloadType === "web_search_call") {
      emitToolCall(state, line, 0, "web_search", {}, payload.call_id ?? payload.id, { timestamp });
      return true;
    }
    if (payloadType === "mcp_tool_call_begin") {
      emitToolCall(
        state,
        line,
        0,
        payload.tool_name ?? payload.name,
        payload.arguments,
        payload.call_id ?? payload.id,
        { timestamp },
      );
      return true;
    }
    if (payloadType === "mcp_tool_call_end") {
      emitToolResult(
        state,
        line,
        0,
        payload.call_id,
        payload.error ? "fail" : outcomeOfFlag(payload.success),
        payload.tool_name ?? payload.name,
        payload.error ?? payload.output,
        { timestamp },
      );
      return true;
    }
    return false;
  }

  if (type === "event_msg") {
    const payloadType = typeof payload.type === "string" ? payload.type : "";
    if (payloadType === "user_message") {
      const message = firstString(payload.message);
      if (message) {
        state.userTurns += 1;
        emit(state, line, 0, "user_turn", {
          timestamp,
          quote: clip(message),
          command: commandFromUserText(message),
        });
      }
      return true;
    }
    if (payloadType === "agent_message") {
      state.assistantMessages += 1;
      emit(state, line, 0, "assistant_message", {
        timestamp,
        quote: clip(payload.message ?? payload.text),
      });
      return true;
    }
    if (payloadType === "agent_reasoning") {
      emitOther(state, line, 0, "agent_reasoning", payload.text ?? payload.message, timestamp);
      return true;
    }
    if (payloadType === "mcp_tool_call_begin") {
      emitToolCall(
        state,
        line,
        0,
        payload.tool_name ?? payload.name,
        payload.arguments,
        payload.call_id ?? payload.id,
        { timestamp },
      );
      return true;
    }
    if (payloadType === "mcp_tool_call_end") {
      emitToolResult(
        state,
        line,
        0,
        payload.call_id,
        payload.error ? "fail" : outcomeOfFlag(payload.success),
        payload.tool_name ?? payload.name,
        payload.error ?? payload.output,
        { timestamp },
      );
      return true;
    }
    if (payloadType === "task_started" || payloadType === "task_complete") {
      emitOther(state, line, 0, payloadType, payload.message ?? "", timestamp);
      return true;
    }
    return false;
  }

  if (type === "turn_context") {
    // The generic pass already records a model change if this entry carries one.
    return true;
  }
  if (type === "compacted" || type.includes("compact")) {
    emit(state, line, 0, "compaction", { timestamp, raw_type: type });
    return true;
  }
  if (type.includes("permission")) {
    emit(state, line, 0, "permission", { timestamp, raw_type: type });
    return true;
  }
  return false;
}

function processCopilot(entry: Record<string, any>, state: ReaderState, line: number, timestamp?: string): boolean {
  const type = typeof entry.type === "string" ? entry.type : "";
  const data = isRecord(entry.data) ? entry.data : {};

  if (type === "session.start") {
    state.sessionId ??= firstString(data.sessionId, data.session_id);
    emit(state, line, 0, "session_start", {
      timestamp,
      quote: clip(state.cwd),
      raw_type: type,
    });
    return true;
  }
  if (type === "session.resume" || type === "session.context_changed") {
    // The generic pass records a cwd_change when the cwd actually differs.
    return true;
  }
  if (type === "user.message") {
    if (entry.agentId !== undefined || data.isAutopilotContinuation === true) {
      emitOther(state, line, 0, "agent.user.message", data.content, timestamp);
      return true;
    }
    if (data.source !== undefined && data.source !== "user") {
      emitOther(state, line, 0, `user.source.${String(data.source)}`, data.content, timestamp);
      return true;
    }
    state.userTurns += 1;
    emit(state, line, 0, "user_turn", {
      timestamp,
      quote: clip(data.content),
      command: commandFromUserText(data.content),
    });
    return true;
  }
  if (type === "assistant.message") {
    state.assistantMessages += 1;
    emit(state, line, 0, "assistant_message", {
      timestamp,
      quote: clip(data.content ?? data.message),
    });
    return true;
  }
  if (type === "tool.execution_start") {
    emitToolCall(
      state,
      line,
      0,
      data.toolName ?? data.tool_name ?? data.name,
      data.arguments ?? data.input ?? data.args,
      data.toolCallId ?? data.tool_call_id,
      { timestamp },
    );
    return true;
  }
  if (type === "tool.execution_end" || type === "tool.execution_complete") {
    const outcome =
      data.error || data.status === "error"
        ? "fail"
        : data.status === "success"
          ? "ok"
          : outcomeOfFlag(data.success);
    emitToolResult(
      state,
      line,
      0,
      data.toolCallId ?? data.tool_call_id,
      outcome,
      data.toolName ?? data.tool_name,
      data.error ?? data.output ?? data.message,
      { timestamp },
    );
    return true;
  }
  if (type.startsWith("subagent.") || data.agentId !== undefined) {
    emit(state, line, 0, "subagent", { timestamp, raw_type: type });
    return true;
  }
  if (type.includes("permission")) {
    emit(state, line, 0, "permission", { timestamp, raw_type: type });
    return true;
  }
  if (type.includes("compact")) {
    emit(state, line, 0, "compaction", { timestamp, raw_type: type });
    return true;
  }
  return false;
}

/**
 * A `rsih.genome` custom entry marks the active Genome from this point on.
 * It can appear more than once in a session (`/switch-genome`, resume), so the
 * reader treats it as a segment boundary rather than session metadata.
 */
function processGenomeMarker(
  entry: Record<string, any>,
  state: ReaderState,
  line: number,
): boolean {
  if (entry.type !== "custom" || entry.customType !== "rsih.genome") {
    return false;
  }
  const data = isRecord(entry.data) ? entry.data : {};
  const snapshot = isRecord(data.genome) ? data.genome : {};
  const reference = firstString(data.reference, snapshot.genome_id);
  const genomeId = firstString(data.genome_id, snapshot.genome_id);
  const baseDirectory = firstString(data.baseDirectory);

  // Reset even when a field is absent: a new marker means the previous Genome
  // no longer applies to the following events.
  state.genomeReference = reference;
  state.genomeId = genomeId;
  state.genomeBaseDirectory = baseDirectory;
  if (reference) state.genomeReferences.add(reference);
  if (genomeId) state.genomeIds.add(genomeId);

  emit(state, line, 0, "genome_change", {
    timestamp: firstString(entry.timestamp),
    raw_type: "rsih.genome",
    quote: clip(reference ?? genomeId ?? "rsih.genome"),
  });
  return true;
}

function processEntry(entry: Record<string, any>, state: ReaderState, line: number) {
  if (processGenomeMarker(entry, state, line)) return;

  const timestamp = firstString(
    entry.timestamp,
    entry.message?.timestamp,
    entry.payload?.timestamp,
    entry.data?.timestamp,
  );

  const cwd = firstString(
    entry.cwd,
    entry.payload?.cwd,
    entry.data?.context?.cwd,
    entry.data?.cwd,
  );
  if (cwd && cwd !== state.cwd) {
    if (state.cwd) {
      emit(state, line, 0, "cwd_change", {
        timestamp,
        quote: clip(cwd),
        raw_type: "cwd",
      });
    }
    state.cwd = cwd;
  }

  const model = firstString(
    entry.model,
    entry.message?.model,
    entry.payload?.model,
    entry.data?.model,
  );
  if (model) {
    if (state.model && model !== state.model) {
      emit(state, line, 0, "model_change", {
        timestamp,
        quote: clip(model),
        raw_type: "model",
      });
    }
    state.model = model;
  }

  if (state.source === "claude") {
    if (typeof entry.sessionId === "string") state.sessionId ??= entry.sessionId;
  } else if (state.source === "copilot") {
    if (typeof entry.data?.sessionId === "string") state.sessionId ??= entry.data.sessionId;
  }

  const handled =
    state.source === "claude"
      ? processClaude(entry, state, line, timestamp)
      : state.source === "codex"
        ? processCodex(entry, state, line, timestamp)
        : state.source === "copilot"
          ? processCopilot(entry, state, line, timestamp)
          : processPi(entry, state, line, timestamp);

  if (handled) return;

  const outer = typeof entry.type === "string" ? entry.type : "";
  const inner =
    typeof entry.payload?.type === "string" ? entry.payload.type : "";
  const rawType =
    outer && inner && outer !== inner
      ? `${outer}.${inner}`
      : inner || outer || "unknown";
  const lower = rawType.toLowerCase();
  if (lower.includes("compact")) {
    emit(state, line, 0, "compaction", { timestamp, raw_type: rawType });
  } else if (lower.includes("permission")) {
    emit(state, line, 0, "permission", { timestamp, raw_type: rawType });
  } else if (lower.includes("subagent")) {
    emit(state, line, 0, "subagent", { timestamp, raw_type: rawType });
  } else if (lower.includes("model")) {
    emit(state, line, 0, "model_change", { timestamp, raw_type: rawType });
  } else {
    emitOther(state, line, 0, rawType, textOfContent(entry), timestamp);
  }
}

function processTextLines(
  state: ReaderState,
  lines: Iterable<{ text: string; line: number }>,
): { endLine: number } {
  let endLine = 0;
  for (const item of lines) {
    state.linesRead += 1;
    endLine = item.line;
    const text = item.text.trim();
    if (!text) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      emitMalformed(state, item.line, 0, text);
      continue;
    }
    if (!isRecord(parsed)) {
      emitMalformed(state, item.line, 0, text);
      continue;
    }
    processEntry(parsed, state, item.line);
    if (state.filtered) break;
  }
  return { endLine };
}

function baseSummary(
  path: string,
  source: EvidenceSource,
  size: number,
  mtimeMs: number,
  startOffset: number,
  startLine: number,
  generation: number,
): FileScanSummary {
  return {
    session: path,
    source,
    size,
    mtimeMs,
    cwd: "",
    startOffset,
    endOffset: startOffset,
    startLine,
    endLine: startLine - 1,
    linesRead: 0,
    malformed: 0,
    calls: 0,
    userTurns: 0,
    assistantMessages: 0,
    failures: 0,
    successes: 0,
    unknownOutcomes: 0,
    eventCounts: emptyEventCounts(),
    unknownTypes: {},
  };
}

function makeState(
  path: string,
  source: EvidenceSource,
  generation: number,
  cwd: string,
): ReaderState {
  return {
    session: path,
    source,
    generation,
    cwd,
    events: [],
    genomeReferences: new Set(),
    genomeIds: new Set(),
    skills: new Set(),
    counts: emptyEventCounts(),
    unknownTypes: {},
    otherPerType: new Map(),
    otherEmitted: 0,
    malformedEvents: 0,
    calls: 0,
    results: 0,
    failures: 0,
    successes: 0,
    unknownResults: 0,
    userTurns: 0,
    assistantMessages: 0,
    linesRead: 0,
    malformed: 0,
  };
}

function summarize(
  state: ReaderState,
  base: FileScanSummary,
  endOffset: number,
  endLine: number,
): FileScanSummary {
  return {
    ...base,
    cwd: state.cwd,
    sessionId: state.sessionId,
    endOffset,
    endLine,
    linesRead: state.linesRead,
    malformed: state.malformed,
    calls: state.calls,
    userTurns: state.userTurns,
    assistantMessages: state.assistantMessages,
    failures: state.failures,
    successes: state.successes,
    unknownOutcomes:
      state.unknownResults + Math.max(0, state.calls - state.results),
    filtered: state.filtered,
    error: state.error,
    genomeReferences: [...state.genomeReferences].sort(),
    genomeIds: [...state.genomeIds].sort(),
    skills: [...state.skills].sort(),
    eventCounts: state.counts,
    unknownTypes: state.unknownTypes,
  };
}

function readZstdFile(path: string): string | undefined {
  if (!zstdSupported()) return undefined;
  const compressed = readFileSync(path);
  const decompressed = (zlib as any).zstdDecompressSync(compressed);
  return Buffer.isBuffer(decompressed)
    ? decompressed.toString("utf8")
    : String(decompressed);
}

export async function readEvidenceFile(
  path: string,
  source: EvidenceSource,
  options: ReadEvidenceFileOptions = {},
): Promise<ReadEvidenceFileResult> {
  const generation = Math.max(1, Math.floor(Number(options.generation) || 1));
  const startOffset = Math.max(0, Math.floor(Number(options.startOffset) || 0));
  const startLine = Math.max(1, Math.floor(Number(options.startLine) || 1));
  const base = baseSummary(path, source, 0, 0, startOffset, startLine, generation);

  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    return {
      events: [],
      summary: {
        ...base,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const size = stats.size;
  const mtimeMs = stats.mtimeMs;

  if (path.endsWith(".jsonl.zst")) {
    if (!zstdSupported()) {
      return {
        events: [],
        summary: {
          ...base,
          size,
          mtimeMs,
          unsupported: "zstd",
          endOffset: size,
          endLine: 0,
        },
      };
    }
    try {
      const text = readZstdFile(path) ?? "";
      const state = makeState(path, source, generation, options.cwd ?? "");
      const lines = text.split("\n").map((line, index) => ({
        text: line.endsWith("\r") ? line.slice(0, -1) : line,
        line: index + 1,
      }));
      const { endLine } = processTextLines(state, lines);
      return {
        events: state.events,
        summary: summarize(
          state,
          { ...base, size, mtimeMs },
          size,
          endLine,
        ),
      };
    } catch (error) {
      return {
        events: [],
        summary: {
          ...base,
          size,
          mtimeMs,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  if (startOffset >= size && startOffset > 0) {
    return {
      events: [],
      summary: {
        ...base,
        size,
        mtimeMs,
        cwd: options.cwd ?? "",
        endOffset: size,
        endLine: startLine - 1,
      },
    };
  }

  const state = makeState(path, source, generation, options.cwd ?? "");
  let endOffset = startOffset;
  let endLine = startLine - 1;

  try {
    const discardPartial = startOffset > 0 && !isLineBoundary(path, startOffset);
    for await (const item of readCompleteLines(
      path,
      startOffset,
      startLine,
      discardPartial,
    )) {
      state.linesRead += 1;
      endOffset = item.offset;
      endLine = item.line;
      const text = item.text.trim();
      if (!text) continue;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        emitMalformed(state, item.line, 0, text);
        continue;
      }
      if (!isRecord(parsed)) {
        emitMalformed(state, item.line, 0, text);
        continue;
      }
      processEntry(parsed, state, item.line);
      if (state.filtered) break;
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }

  return {
    events: state.events,
    summary: summarize(state, { ...base, size, mtimeMs }, endOffset, endLine),
  };
}
