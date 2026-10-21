/**
 * Durable evolution state: what was already consumed, what the baseline is,
 * and what happened on each run.
 *
 * The state is the only thing that makes the loop incremental. It lives under
 * `~/.rsih/evolution/<base>/`, outside `~/.rsih/genomes/`, so it is never
 * mistaken for a Genome. Writes are atomic and a lock prevents two triggers
 * from consuming the same evidence interval at once.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createWatermark,
  type WatermarkState,
} from "./watermark.ts";

export type BaselineSource =
  | "explicit"
  | "state"
  | "genome_created"
  | "all_history";

export interface EvolutionHistoryEntry {
  action: "evolve" | "rollback" | "no_change";
  from_version?: number;
  version?: number;
  active_path?: string;
  archive_path?: string;
  patch_hash?: string;
  evidence_hash?: string;
  decision?: string;
  changed_components?: string[];
  created_at: string;
}

export interface EvolutionState {
  schema_version: "1";
  base_name: string;
  base_genome_id: string;
  base_content_hash: string;
  intent: string;
  sources: string[];
  workspaces: string[];
  baseline_at: string;
  baseline_source: BaselineSource;
  index_cursor: number;
  watermark: WatermarkState;
  last_version: number;
  history: EvolutionHistoryEntry[];
}

export interface EvolutionStatePaths {
  directory: string;
  statePath: string;
  lockPath: string;
  proposalsDirectory: string;
  versionsDirectory: string;
  indexPath: string;
}

export interface Baseline {
  at: number;
  iso: string;
  source: BaselineSource;
}

export interface BaselineInput {
  explicitSince?: number | string | Date;
  state?: EvolutionState;
  genomeCreatedAt?: number | string | Date;
}

export interface EvolutionLock {
  path: string;
  release(): void;
}

const LOCK_STALE_MS = 60 * 60 * 1000;

export function defaultAgentDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const configured = environment.RSIH_CODING_AGENT_DIR?.trim();
  return resolve(configured || join(home, ".rsih"));
}

/** Keep a Genome name from escaping the evolution directory. */
export function sanitizeBaseName(name: string): string {
  const cleaned = String(name ?? "")
    .replace(/\.{2,}/g, "_")
    .replace(/[\\/]+/g, "_")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+$/, "");
  return cleaned || "genome";
}

export function evolutionStatePaths(
  baseName: string,
  agentDirectory = defaultAgentDirectory(),
): EvolutionStatePaths {
  const directory = join(agentDirectory, "evolution", sanitizeBaseName(baseName));
  return {
    directory,
    statePath: join(directory, "state.json"),
    lockPath: join(directory, "state.lock"),
    proposalsDirectory: join(directory, "proposals"),
    versionsDirectory: join(directory, "versions"),
    indexPath: join(directory, "events.jsonl"),
  };
}

function toEpochMs(value: number | string | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : time;
  }
  return undefined;
}

/**
 * Decide where this run's evidence window starts.
 *
 * `--since` wins; then the state from a previous run; then the Genome's own
 * `evolution.created_at`. If none is available, the window is all history and
 * the source says so explicitly.
 *
 * The bundle's filesystem birthtime is deliberately not used: copying or
 * reinstalling a directory changes it, so it is not a reliable creation time.
 * A Genome produced by `rsih genome evolve` records `evolution.created_at` in
 * its manifest, which survives copying; a Genome authored by `gee` that
 * predates that field is narrowed with `--since` once, or scanned in full.
 */
export function resolveBaseline(input: BaselineInput = {}): Baseline {
  const explicit = toEpochMs(input.explicitSince);
  if (explicit !== undefined) {
    return { at: explicit, iso: new Date(explicit).toISOString(), source: "explicit" };
  }

  const stateBaseline = toEpochMs(input.state?.baseline_at);
  if (stateBaseline !== undefined) {
    return {
      at: stateBaseline,
      iso: new Date(stateBaseline).toISOString(),
      source: input.state?.baseline_source ?? "state",
    };
  }

  const created = toEpochMs(input.genomeCreatedAt);
  if (created !== undefined) {
    return { at: created, iso: new Date(created).toISOString(), source: "genome_created" };
  }

  return {
    at: 0,
    iso: new Date(0).toISOString(),
    source: "all_history",
  };
}

export interface CreateStateInput {
  baseName: string;
  baseGenomeId: string;
  baseContentHash: string;
  intent: string;
  sources?: string[];
  workspaces?: string[];
  baseline: Baseline;
  watermark?: WatermarkState;
  indexCursor?: number;
  lastVersion?: number;
  history?: EvolutionHistoryEntry[];
}

export function createEvolutionState(input: CreateStateInput): EvolutionState {
  return {
    schema_version: "1",
    base_name: input.baseName,
    base_genome_id: input.baseGenomeId,
    base_content_hash: input.baseContentHash,
    intent: input.intent,
    sources: [...(input.sources ?? [])],
    workspaces: [...(input.workspaces ?? [])],
    baseline_at: input.baseline.iso,
    baseline_source: input.baseline.source,
    index_cursor: Math.max(0, Math.floor(input.indexCursor ?? 0)),
    watermark: input.watermark ?? createWatermark(),
    last_version: Math.max(1, Math.floor(input.lastVersion ?? 1)),
    history: [...(input.history ?? [])],
  };
}

function stateError(path: string, message: string): Error {
  return new Error(`Invalid evolution state ${path}: ${message}`);
}

function normalizeState(value: any, path: string): EvolutionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw stateError(path, "expected an object");
  }
  if (value.schema_version !== "1") {
    throw stateError(path, `unsupported schema_version ${JSON.stringify(value.schema_version)}`);
  }
  if (typeof value.base_name !== "string" || value.base_name.trim() === "") {
    throw stateError(path, "base_name is required");
  }
  if (typeof value.base_genome_id !== "string") {
    throw stateError(path, "base_genome_id is required");
  }
  if (typeof value.base_content_hash !== "string") {
    throw stateError(path, "base_content_hash is required");
  }
  if (typeof value.intent !== "string") {
    throw stateError(path, "intent is required");
  }
  if (typeof value.baseline_at !== "string" || Number.isNaN(Date.parse(value.baseline_at))) {
    throw stateError(path, "baseline_at must be an ISO timestamp");
  }
  if (!value.watermark || typeof value.watermark !== "object") {
    throw stateError(path, "watermark is required");
  }
  return {
    schema_version: "1",
    base_name: value.base_name,
    base_genome_id: value.base_genome_id,
    base_content_hash: value.base_content_hash,
    intent: value.intent,
    sources: Array.isArray(value.sources) ? value.sources.filter((item) => typeof item === "string") : [],
    workspaces: Array.isArray(value.workspaces)
      ? value.workspaces.filter((item) => typeof item === "string")
      : [],
    baseline_at: value.baseline_at,
    baseline_source:
      typeof value.baseline_source === "string"
        ? value.baseline_source
        : "state",
    index_cursor: Math.max(0, Math.floor(Number(value.index_cursor) || 0)),
    watermark: value.watermark,
    last_version: Math.max(1, Math.floor(Number(value.last_version) || 1)),
    history: Array.isArray(value.history)
      ? value.history.filter((item) => item && typeof item === "object")
      : [],
  };
}

export function loadEvolutionState(directory: string): EvolutionState | undefined {
  const path = join(directory, "state.json");
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw stateError(path, error instanceof Error ? error.message : String(error));
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw stateError(path, error instanceof Error ? error.message : String(error));
  }
  return normalizeState(parsed, path);
}

export function saveEvolutionState(state: EvolutionState, directory: string): void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "state.json");
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const text = `${JSON.stringify(state, null, 2)}\n`;
  writeFileSync(temporary, text, "utf8");
  try {
    renameSync(temporary, path);
  } catch {
    writeFileSync(path, text, "utf8");
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best effort; the valid state is already in place.
    }
  }
}

function readLockCreatedAt(lockPath: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8"));
    const createdAt = Number(value?.created_at);
    return Number.isFinite(createdAt) ? createdAt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Single-writer lock for a Genome's evolution state.
 *
 * A stale lock is removed once; if it reappears, the caller gets an error
 * rather than two processes appending to the same index.
 */
export function acquireEvolutionLock(
  directory: string,
  options: { now?: number; staleMs?: number } = {},
): EvolutionLock {
  mkdirSync(directory, { recursive: true });
  const lockPath = join(directory, "state.lock");
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? LOCK_STALE_MS;

  const tryAcquire = (): number | undefined => {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, created_at: now })}\n`, "utf8");
      return fd;
    } catch (error: any) {
      if (error?.code === "EEXIST") return undefined;
      throw error;
    }
  };

  let fd = tryAcquire();
  if (fd === undefined) {
    const createdAt = readLockCreatedAt(lockPath);
    if (createdAt !== undefined && now - createdAt > staleMs) {
      rmSync(lockPath, { force: true });
      fd = tryAcquire();
    }
  }
  if (fd === undefined) {
    throw new Error(
      `Another evolution run holds ${lockPath}. Remove it if the process is gone.`,
    );
  }

  closeSync(fd);
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      rmSync(lockPath, { force: true });
    },
  };
}
