/**
 * Version storage for evolved Genomes.
 *
 * The active Genome keeps its name at `~/.rsih/genomes/<name>/`; every replaced
 * revision is archived under `~/.rsih/evolution/<name>/versions/<revision>/`.
 * Archiving happens outside the genome search path, so `genome list` never
 * shows one name many times and the user never has to switch to `name-v2`.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadHarnessGenomeFile } from "../genome-bundle.ts";
import {
  genomeContentHash,
  GENOME_MANIFEST_NAME,
  userGenomeDirectory,
} from "../genome-loader.ts";
import {
  defaultAgentDirectory,
  sanitizeBaseName,
} from "./state.ts";

export interface EvolutionVersionOptions {
  homeDirectory?: string;
  agentDirectory?: string;
  genomesDirectory?: string;
}

export interface EvolutionVersionPaths {
  genomesDirectory: string;
  activeDirectory: string;
  evolutionDirectory: string;
  versionsDirectory: string;
}

export interface EvolutionVersionInfo {
  version: number;
  genome_id: string;
  parent_id?: string | null;
  created_at?: string;
  changed_components: string[];
  path: string;
  active: boolean;
}

export interface EvolutionVersionList {
  active?: EvolutionVersionInfo;
  versions: EvolutionVersionInfo[];
}

export interface InstallEvolutionBundleResult {
  activeDirectory: string;
  manifestPath: string;
  archived?: EvolutionVersionInfo;
  previousVersion?: number;
}

export interface RollbackEvolutionResult {
  activeDirectory: string;
  manifestPath: string;
  fromVersion?: number;
  toVersion: number;
  archivedCurrent?: EvolutionVersionInfo;
}

function safeVersion(version: unknown): number {
  const value = Number(version);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Evolution version must be a positive integer, got ${String(version)}.`);
  }
  return value;
}

export function evolutionVersionPaths(
  baseName: string,
  options: EvolutionVersionOptions = {},
): EvolutionVersionPaths {
  const home = resolve(options.homeDirectory ?? homedir());
  const genomesDirectory = resolve(
    options.genomesDirectory ?? userGenomeDirectory(home),
  );
  const agentDirectory = resolve(
    options.agentDirectory ?? defaultAgentDirectory(process.env, home),
  );
  const evolutionDirectory = join(
    agentDirectory,
    "evolution",
    sanitizeBaseName(baseName),
  );
  return {
    genomesDirectory,
    activeDirectory: join(genomesDirectory, sanitizeBaseName(baseName)),
    evolutionDirectory,
    versionsDirectory: join(evolutionDirectory, "versions"),
  };
}

function readManifest(bundleDirectory: string): Record<string, any> {
  const path = join(bundleDirectory, GENOME_MANIFEST_NAME);
  if (!existsSync(path)) {
    throw new Error(`Genome bundle has no ${GENOME_MANIFEST_NAME}: ${bundleDirectory}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Genome manifest could not be read: ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Metadata for one bundle, without validating its whole component graph. */
export function readEvolutionVersion(
  bundleDirectory: string,
  active = false,
): EvolutionVersionInfo {
  const manifest = readManifest(bundleDirectory);
  const evolution = manifest.evolution ?? {};
  return {
    version: safeVersion(manifest.version ?? 1),
    genome_id: String(manifest.genome_id ?? ""),
    parent_id: manifest.parent_id ?? null,
    created_at:
      typeof evolution.created_at === "string" ? evolution.created_at : undefined,
    changed_components: Array.isArray(evolution.changed_components)
      ? evolution.changed_components.filter((item: unknown) => typeof item === "string")
      : [],
    path: bundleDirectory,
    active,
  };
}

function archiveNameTaken(path: string): boolean {
  return existsSync(path);
}

function nextSuffixPath(path: string): string {
  let candidate = path;
  let suffix = 1;
  while (existsSync(candidate)) candidate = `${path}.${suffix++}`;
  return candidate;
}

/**
 * Copy the current active bundle into the archive, keyed by its revision.
 * Archiving the same bytes twice is a no-op; archiving different bytes under a
 * revision that already exists is refused rather than overwritten.
 */
export function archiveActiveBundle(
  baseName: string,
  options: EvolutionVersionOptions = {},
): EvolutionVersionInfo | undefined {
  const paths = evolutionVersionPaths(baseName, options);
  if (!existsSync(join(paths.activeDirectory, GENOME_MANIFEST_NAME))) {
    return undefined;
  }
  const info = readEvolutionVersion(paths.activeDirectory, true);
  const destination = join(paths.versionsDirectory, String(info.version));
  mkdirSync(paths.versionsDirectory, { recursive: true });

  if (archiveNameTaken(destination)) {
    const activeHash = genomeContentHash(paths.activeDirectory);
    const archivedHash = genomeContentHash(destination);
    if (activeHash !== undefined && activeHash === archivedHash) {
      return { ...readEvolutionVersion(destination), active: false };
    }
    throw new Error(
      `Version ${info.version} is already archived with different content. ` +
        `Refusing to overwrite ${destination}; bump the base version or remove the stale archive.`,
    );
  }

  cpSync(paths.activeDirectory, destination, { recursive: true, force: true });
  return { ...readEvolutionVersion(destination), active: false };
}

function swapBundle(stagingDirectory: string, targetDirectory: string): void {
  const parent = resolve(targetDirectory, "..");
  mkdirSync(parent, { recursive: true });
  const previous = existsSync(targetDirectory)
    ? nextSuffixPath(`${targetDirectory}.old-${process.pid}-${Date.now()}`)
    : undefined;
  if (previous) renameSync(targetDirectory, previous);

  let installed = false;
  try {
    try {
      renameSync(stagingDirectory, targetDirectory);
    } catch (error: any) {
      // A staging directory on another volume cannot be renamed into place.
      if (error?.code !== "EXDEV") throw error;
      cpSync(stagingDirectory, targetDirectory, { recursive: true, force: true });
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
    installed = true;
    if (previous) rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    try {
      if (installed) rmSync(targetDirectory, { recursive: true, force: true });
      if (previous && existsSync(previous) && !existsSync(targetDirectory)) {
        renameSync(previous, targetDirectory);
      }
      rmSync(stagingDirectory, { recursive: true, force: true });
    } catch {
      // Keep the original failure; the paths left behind are reported by it.
    }
    throw error;
  }
}

/**
 * Archive the current active bundle and atomically replace it with `staging`.
 * The staging bundle must already have been validated by the compiler.
 */
export function installEvolutionBundle(
  baseName: string,
  stagingDirectory: string,
  options: EvolutionVersionOptions = {},
): InstallEvolutionBundleResult {
  const paths = evolutionVersionPaths(baseName, options);
  if (!existsSync(join(stagingDirectory, GENOME_MANIFEST_NAME))) {
    throw new Error(
      `Refusing to install a directory with no ${GENOME_MANIFEST_NAME}: ${stagingDirectory}`,
    );
  }
  // Validate before touching the active path. The compiler already did this,
  // but `apply <proposal>` and rollback also reach this function.
  loadHarnessGenomeFile(join(stagingDirectory, GENOME_MANIFEST_NAME));
  const staged = readEvolutionVersion(stagingDirectory);
  const archived = archiveActiveBundle(baseName, options);
  const previousVersion = archived?.version;

  swapBundle(resolve(stagingDirectory), paths.activeDirectory);
  return {
    activeDirectory: paths.activeDirectory,
    manifestPath: join(paths.activeDirectory, GENOME_MANIFEST_NAME),
    archived,
    previousVersion,
  };
}

function archivedDirectories(versionsDirectory: string): { version: number; path: string }[] {
  if (!existsSync(versionsDirectory)) return [];
  const found: { version: number; path: string }[] = [];
  for (const entry of readdirSync(versionsDirectory)) {
    if (!/^\d+$/.test(entry)) continue;
    const path = join(versionsDirectory, entry);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    found.push({ version: Number(entry), path });
  }
  return found.sort((left, right) => left.version - right.version);
}

export function listEvolutionVersions(
  baseName: string,
  options: EvolutionVersionOptions = {},
): EvolutionVersionList {
  const paths = evolutionVersionPaths(baseName, options);
  const active = existsSync(join(paths.activeDirectory, GENOME_MANIFEST_NAME))
    ? readEvolutionVersion(paths.activeDirectory, true)
    : undefined;
  const versions = archivedDirectories(paths.versionsDirectory).map(({ path }) =>
    readEvolutionVersion(path, false),
  );
  return { active, versions };
}

/** The next revision after both the active bundle and everything archived. */
export function nextEvolutionVersion(
  baseName: string,
  options: EvolutionVersionOptions = {},
): number {
  const { active, versions } = listEvolutionVersions(baseName, options);
  return Math.max(active?.version ?? 0, ...versions.map((item) => item.version), 0) + 1;
}

/**
 * Restore an archived revision under the same active name. The current active
 * bundle is archived first, so a rollback is itself reversible.
 */
export function rollbackEvolutionVersion(
  baseName: string,
  version: number,
  options: EvolutionVersionOptions = {},
): RollbackEvolutionResult {
  const paths = evolutionVersionPaths(baseName, options);
  const target = safeVersion(version);
  const archive = join(paths.versionsDirectory, String(target));
  if (!existsSync(join(archive, GENOME_MANIFEST_NAME))) {
    throw new Error(`No archived version ${target} for "${baseName}".`);
  }
  loadHarnessGenomeFile(join(archive, GENOME_MANIFEST_NAME));

  const current = existsSync(join(paths.activeDirectory, GENOME_MANIFEST_NAME))
    ? readEvolutionVersion(paths.activeDirectory, true)
    : undefined;
  if (current?.version === target) {
    const sameContent =
      genomeContentHash(paths.activeDirectory) === genomeContentHash(archive);
    if (sameContent) {
      return {
        activeDirectory: paths.activeDirectory,
        manifestPath: join(paths.activeDirectory, GENOME_MANIFEST_NAME),
        fromVersion: current.version,
        toVersion: target,
      };
    }
  }

  const archivedCurrent = archiveActiveBundle(baseName, options);

  mkdirSync(paths.genomesDirectory, { recursive: true });
  const staging = join(
    paths.genomesDirectory,
    `.${sanitizeBaseName(baseName)}.rollback-${process.pid}-${Date.now()}`,
  );
  try {
    cpSync(archive, staging, { recursive: true, force: true });
    swapBundle(staging, paths.activeDirectory);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    activeDirectory: paths.activeDirectory,
    manifestPath: join(paths.activeDirectory, GENOME_MANIFEST_NAME),
    fromVersion: current?.version,
    toVersion: target,
    archivedCurrent,
  };
}
