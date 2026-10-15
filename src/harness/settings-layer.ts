import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cloneJson } from "../core/json.ts";

/** Marker key recording which Genome owns which settings in a generated file. */
export const RSIH_MANAGED_MARKER = "$rsih";

function readJsonFile(path) {
  if (!existsSync(path)) return {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  // Pi reads these files through `stripBom` and treats an empty one as `{}`.
  // Without the same two steps here, a BOM an editor on Windows left behind --
  // or a file that was truncated to zero -- looks malformed, the compiled patch
  // is dropped, and every key the Genome declares stays silently unapplied.
  const content = text.replace(/^\uFEFF/, "");
  if (content.trim() === "") return {};
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    // A malformed file is Pi's to report; never clobber what we cannot read.
    return undefined;
  }
}

/**
 * Reassert the keys a Genome declares while leaving everything else alone.
 *
 * - Keys the Genome declares are replaced, so `--genome paperlab` always yields
 *   the same environment no matter what a previous run wrote.
 * - Keys the Genome does not declare are preserved, so Pi's own runtime writes
 *   (`theme`, `defaultModel`, `lastChangelogVersion`) survive.
 * - Keys a *previous* Genome managed but this one no longer declares are
 *   dropped, so switching Genomes does not leave residue behind.
 */
export function mergeManagedSettings(existing, patch, stamp) {
  const previous = existing?.[RSIH_MANAGED_MARKER]?.managedKeys ?? [];
  const managed = Object.keys(patch ?? {}).sort();
  const released = new Set(previous.filter((key) => !managed.includes(key)));

  const result = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    if (key === RSIH_MANAGED_MARKER || released.has(key)) continue;
    result[key] = value;
  }
  for (const key of managed) {
    result[key] = cloneJson(patch[key]);
  }
  if (managed.length > 0) {
    result[RSIH_MANAGED_MARKER] = { ...stamp, managedKeys: managed };
  }
  return result;
}

/**
 * Compile one Genome-managed JSON file under Pi's agent directory. Returns the
 * resolved contents so `rsih genome show` can render them without writing.
 *
 * A write that fails is collected in `warnings` rather than thrown: a read-only
 * or locked file is not a reason to refuse to start, and the same module already
 * treats an unreadable file as "leave it alone".
 */
export function compileManagedFile(
  path,
  patch,
  stamp,
  { write = true, warnings } = {},
) {
  const existing = readJsonFile(path);
  if (existing === undefined) return undefined;

  const next = mergeManagedSettings(existing, patch, stamp);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (write && serialized !== `${JSON.stringify(existing, null, 2)}\n`) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, serialized, "utf8");
    } catch (error) {
      warnings?.push(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return next;
}

/**
 * Apply a Genome's `settings` and `keybindings` projection to Pi's agent
 * directory. Pi has no API for injecting settings, so the compiled files are
 * the only place this can land.
 */
export function applyManagedConfiguration({
  agentDirectory,
  settings,
  keybindings,
  stamp,
  write = true,
}) {
  const warnings = [];
  return {
    settings: compileManagedFile(
      join(agentDirectory, "settings.json"),
      settings ?? {},
      stamp,
      { write, warnings },
    ),
    keybindings: compileManagedFile(
      join(agentDirectory, "keybindings.json"),
      keybindings ?? {},
      stamp,
      { write, warnings },
    ),
    warnings,
  };
}
