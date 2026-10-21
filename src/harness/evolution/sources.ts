/**
 * Session-store discovery for the evolution subsystem.
 *
 * This is intentionally a separate implementation from the harness-rsi
 * extension's reader. The extension serves an interactive authoring session and
 * must keep behaving exactly as it does today; evolution needs different things
 * from the same files (full-file event indexing, byte offsets, generations) and
 * must not change the extension's behavior to get them.
 *
 * Discovery is cheap and format-agnostic: it finds files, stats them, and
 * remembers their real path. Parsing and event extraction live in `reader.ts`.
 */

import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as zlib from "node:zlib";
import {
  EVIDENCE_SOURCE_IDS,
  type EvidenceSourceId,
} from "./events.ts";

/** Evolution defaults to the only store that can carry a `rsih.genome` marker. */
export const DEFAULT_EVOLUTION_SOURCES = Object.freeze(["rsih"]);

export type EvidenceFileKind = "jsonl" | "zstd";

export interface DiscoveredEvidenceFile {
  source: EvidenceSourceId;
  /** Path as discovered (used only for reporting). */
  path: string;
  /** Canonical path; dedupe and watermark keys use this. */
  realPath: string;
  size: number;
  mtimeMs: number;
  kind: EvidenceFileKind;
}

export interface SourceDiscovery {
  id: EvidenceSourceId;
  label: string;
  roots: string[];
  available: boolean;
  files: number;
}

export interface DiscoverySkipCounts {
  unreadable: number;
  unsupported: number;
}

export interface EvidenceDiscovery {
  files: DiscoveredEvidenceFile[];
  sources: SourceDiscovery[];
  unknownSources: string[];
  skipped: DiscoverySkipCounts;
  skippedForLimit: number;
  notes: string[];
}

export interface EvidenceDiscoveryOptions {
  sources?: readonly string[];
  /** Test hook: replace the default roots for a source. */
  roots?: Partial<Record<EvidenceSourceId, readonly string[]>>;
  limit?: number;
}

interface SourceDefinition {
  id: EvidenceSourceId;
  label: string;
  roots: () => string[];
  depth: number;
  accept: (name: string) => EvidenceFileKind | undefined;
  onlyBasename?: string;
}

/** `node:zlib` exposes zstd from Node 22.15 onward; older runtimes do not. */
export function zstdSupported(): boolean {
  return typeof (zlib as any).zstdDecompressSync === "function";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function acceptJsonl(name: string): EvidenceFileKind | undefined {
  return name.endsWith(".jsonl") ? "jsonl" : undefined;
}

function acceptCodex(name: string): EvidenceFileKind | undefined {
  if (name.endsWith(".jsonl.zst")) return "zstd";
  return acceptJsonl(name);
}

function acceptCopilot(name: string): EvidenceFileKind | undefined {
  return name === "events.jsonl" ? "jsonl" : undefined;
}

/** The five stores, in the same order the interactive scanner uses. */
export function evidenceSourceDefinitions(
  environment: NodeJS.ProcessEnv = process.env,
): SourceDefinition[] {
  const home = homedir();
  return [
    {
      id: "rsih",
      label: "RSIH",
      roots: () => {
        const roots = new Set<string>();
        const configured = environment.RSIH_CODING_AGENT_DIR?.trim();
        if (configured) roots.add(join(configured, "sessions"));
        roots.add(join(home, ".rsih", "sessions"));
        return [...roots];
      },
      depth: 2,
      accept: acceptJsonl,
    },
    {
      id: "pi",
      label: "Pi",
      roots: () => [join(home, ".pi", "agent", "sessions")],
      depth: 2,
      accept: acceptJsonl,
    },
    {
      id: "claude",
      label: "Claude Code",
      roots: () => [join(home, ".claude", "projects")],
      depth: 2,
      accept: acceptJsonl,
    },
    {
      id: "codex",
      label: "Codex",
      roots: () => {
        const codexHome =
          environment.CODEX_HOME?.trim() || join(home, ".codex");
        return [
          join(codexHome, "sessions"),
          join(codexHome, "archived_sessions"),
        ];
      },
      depth: 3,
      accept: acceptCodex,
    },
    {
      id: "copilot",
      label: "GitHub Copilot CLI",
      roots: () => [
        join(
          environment.COPILOT_HOME?.trim() || join(home, ".copilot"),
          "session-state",
        ),
      ],
      depth: 1,
      accept: acceptCopilot,
      onlyBasename: "events.jsonl",
    },
  ];
}

function walk(
  root: string,
  depth: number,
  definition: SourceDefinition,
  files: DiscoveredEvidenceFile[],
  skipped: DiscoverySkipCounts,
  seen: Set<string>,
) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    skipped.unreadable += 1;
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);

    let isDirectoryEntry = entry.isDirectory();
    let isFileEntry = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stats = statSync(path);
        isDirectoryEntry = stats.isDirectory();
        isFileEntry = stats.isFile();
      } catch {
        skipped.unreadable += 1;
        continue;
      }
    }

    if (isFileEntry) {
      const kind = definition.accept(entry.name);
      if (!kind) continue;
      if (definition.onlyBasename && entry.name !== definition.onlyBasename) continue;
      let realPath: string;
      let stats;
      try {
        realPath = realpathSync(path);
        stats = statSync(realPath);
      } catch {
        skipped.unreadable += 1;
        continue;
      }
      if (!stats.isFile()) continue;
      if (seen.has(realPath)) continue;
      seen.add(realPath);
      files.push({
        source: definition.id,
        path,
        realPath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        kind,
      });
      continue;
    }

    if (isDirectoryEntry && depth > 0) {
      walk(path, depth - 1, definition, files, skipped, seen);
    }
  }
}

/**
 * Find every transcript in the requested stores.
 *
 * Files are sorted newest first *before* the limit is applied, so a limit
 * drops old history rather than whatever `readdir` happened to return first.
 * Duplicates across roots are removed by real path.
 */
export function discoverEvidenceFiles(
  options: EvidenceDiscoveryOptions = {},
): EvidenceDiscovery {
  const requested = (options.sources ?? EVIDENCE_SOURCE_IDS).map((id) =>
    String(id).toLowerCase().trim(),
  );
  const wanted = new Set(requested);
  const known = new Set<string>(EVIDENCE_SOURCE_IDS);
  const unknownSources = [...wanted].filter((id) => !known.has(id));

  const files: DiscoveredEvidenceFile[] = [];
  const sources: SourceDiscovery[] = [];
  const skipped: DiscoverySkipCounts = { unreadable: 0, unsupported: 0 };
  const seen = new Set<string>();
  const notes: string[] = [];

  for (const definition of evidenceSourceDefinitions()) {
    if (!wanted.has(definition.id)) continue;
    const injected = options.roots?.[definition.id];
    const roots = (injected ?? definition.roots()).map((root) => resolve(root));
    const available = roots.some(isDirectory);
    const before = files.length;
    for (const root of roots) {
      if (!isDirectory(root)) continue;
      walk(root, definition.depth, definition, files, skipped, seen);
    }
    sources.push({
      id: definition.id,
      label: definition.label,
      roots,
      available,
      files: files.length - before,
    });
  }

  files.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs ||
      left.realPath.localeCompare(right.realPath),
  );

  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.floor(Number(options.limit)))
    : 5000;
  const kept = files.slice(0, limit);
  const skippedForLimit = files.length - kept.length;
  if (skippedForLimit > 0) {
    notes.push(
      `${skippedForLimit} transcript(s) were not scanned because the file limit (${limit}) was reached; newest files were kept.`,
    );
  }

  const zstdFiles = kept.filter((file) => file.kind === "zstd").length;
  if (zstdFiles > 0 && !zstdSupported()) {
    notes.push(
      `${zstdFiles} Codex archive file(s) use .jsonl.zst, but this Node runtime has no zstd support; they will be reported as unsupported rather than read.`,
    );
    skipped.unsupported += zstdFiles;
  }

  return {
    files: kept,
    sources,
    unknownSources,
    skipped,
    skippedForLimit,
    notes,
  };
}
