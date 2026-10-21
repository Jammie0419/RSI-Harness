/**
 * Apply an EvolutionPatch to a resolved Genome working model.
 *
 * This is evolution's own engine. It never calls the core `applyHarnessPatch`
 * and never touches the active bundle: it produces a in-memory genome plus the
 * asset writes/removals that the compiler materializes into a staging copy.
 *
 * Granularity follows the patch target: one entry field, one text region, or
 * one asset file. A component is only marked changed when an operation actually
 * changed it, which is what lets the compiler leave every other component file
 * byte-for-byte untouched.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { canonicalJson, cloneJson } from "../../core/json.ts";
import {
  EVOLUTION_COMPONENT_META,
  type EvolutionComponentId,
} from "./components.ts";
import {
  isWideEvolutionOperation,
  validateEvolutionPatch,
  type EvolutionOperation,
  type EvolutionPatch,
  type EvolutionTarget,
} from "./patch.ts";

export interface EvolutionAssetWrite {
  /** Bundle-relative POSIX path. */
  path: string;
  content: string;
}

export interface EvolutionAppliedOperation {
  index: number;
  op: EvolutionOperation["op"];
  component: EvolutionComponentId;
  entry?: string;
  field?: string;
  asset?: string;
  wide: boolean;
  summary: string;
}

export interface EvolutionApplyInput {
  genome: Record<string, any>;
  baseDirectory: string;
  /** Assets already produced by earlier working-set items. */
  assetWrites?: readonly EvolutionAssetWrite[];
  assetRemovals?: readonly string[];
}

export interface EvolutionApplyResult {
  genome: Record<string, any>;
  changed_components: EvolutionComponentId[];
  changed_fields: Record<string, string[]>;
  asset_writes: EvolutionAssetWrite[];
  asset_removals: string[];
  operations: EvolutionAppliedOperation[];
  notes: string[];
}

interface ApplyState {
  genome: Record<string, any>;
  baseDirectory: string;
  assetWrites: Map<string, string>;
  assetRemovals: Set<string>;
  changedComponents: Set<EvolutionComponentId>;
  changedFields: Map<EvolutionComponentId, Set<string>>;
  notes: string[];
}

const MEMORY_KINDS = new Set(["knowledge", "positive_pattern", "anti_pattern"]);

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sourceName(source: string): string {
  const base = source.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? source;
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function resourceName(entry: unknown): string | undefined {
  if (typeof entry === "string") return sourceName(entry);
  if (isRecord(entry) && typeof entry.name === "string") return entry.name;
  if (isRecord(entry) && typeof entry.source === "string") {
    return sourceName(entry.source);
  }
  return undefined;
}

function findEntryIndex(entries: unknown[], name: string): number {
  return entries.findIndex((entry) => resourceName(entry) === name);
}

function requireEntryIndex(
  entries: unknown[],
  name: string,
  component: EvolutionComponentId,
): number {
  const index = findEntryIndex(entries, name);
  if (index < 0) {
    throw new Error(`Evolution ${component} entry "${name}" does not exist.`);
  }
  return index;
}

function normalizeAssetPath(path: string): string {
  const value = String(path).replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
    throw new Error(`Evolution asset path must be relative: ${path}`);
  }
  if (value === "" || value === ".") {
    throw new Error("Evolution asset path must name a file.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Evolution asset path may not escape the bundle: ${path}`);
  }
  if (
    value === "genome.json" ||
    value === ".rsih-seed.json" ||
    value.startsWith("components/") ||
    value.startsWith("contracts/")
  ) {
    throw new Error(`Evolution may not write bundle metadata through an asset: ${path}`);
  }
  return value;
}

function insideBundle(baseDirectory: string, path: string): string {
  const target = resolve(baseDirectory, path);
  const rel = relative(baseDirectory, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Evolution asset path escapes the bundle: ${path}`);
  }
  return target;
}

function hasAsset(state: ApplyState, path: string): boolean {
  return state.assetWrites.has(path) || existsSync(insideBundle(state.baseDirectory, path));
}

function isAssetDirectory(state: ApplyState, path: string): boolean {
  const prefix = `${path}/`;
  for (const written of state.assetWrites.keys()) {
    if (written.startsWith(prefix)) return true;
  }
  try {
    return statSync(insideBundle(state.baseDirectory, path)).isDirectory();
  } catch {
    return false;
  }
}

function readAsset(state: ApplyState, path: string): string {
  const pending = state.assetWrites.get(path);
  if (pending !== undefined) return pending;
  const target = insideBundle(state.baseDirectory, path);
  if (!existsSync(target)) {
    throw new Error(`Evolution asset does not exist: ${path}`);
  }
  try {
    return readFileSync(target, "utf8");
  } catch (error) {
    throw new Error(
      `Evolution asset could not be read: ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function writeAsset(state: ApplyState, path: string, content: string): void {
  state.assetRemovals.delete(path);
  state.assetWrites.set(path, content);
}

/**
 * The file behind a file-backed skill/template entry. A skill source names a
 * directory and Pi reads `SKILL.md` inside it; a template source normally names
 * the file itself.
 */
function assetPathForSource(
  state: ApplyState,
  component: EvolutionComponentId,
  source: string,
): string {
  const normalized = normalizeAssetPath(source);
  const extension = extname(normalized);
  if (component === "skills") {
    return extension ? normalized : `${normalized}/SKILL.md`;
  }
  if (extension) return normalized;
  if (isAssetDirectory(state, normalized)) {
    const candidates = [
      `${normalized}/${sourceName(normalized)}.md`,
      `${normalized}/index.md`,
      `${normalized}/SKILL.md`,
    ];
    const found = candidates.find((candidate) => hasAsset(state, candidate));
    if (found) return found;
  }
  // A template source without an extension is still a file unless it already
  // exists as a directory; Pi registers the source path as the command body.
  return normalized;
}

function updateFrontmatter(
  content: string,
  field: "name" | "description",
  value: string,
): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`File-backed ${field} must be a single line.`);
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) {
    throw new Error(
      `File-backed resource has no YAML frontmatter; cannot set ${field}.`,
    );
  }
  const lines = match[1].split(/\r?\n/);
  let found = false;
  for (const [index, line] of lines.entries()) {
    if (new RegExp(`^${field}\\s*:`).test(line)) {
      lines[index] = `${field}: ${value}`;
      found = true;
    }
  }
  if (!found) lines.push(`${field}: ${value}`);
  const replacement = `---\n${lines.join("\n")}\n---\n`;
  return replacement + content.slice(match[0].length);
}

function countOccurrences(text: string, find: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= text.length) {
    const index = text.indexOf(find, offset);
    if (index < 0) break;
    count += 1;
    offset = index + find.length;
  }
  return count;
}

function spliceText(
  text: string,
  operation: Extract<EvolutionOperation, { op: "text.patch" }>,
): string {
  const expected = operation.expected_occurrences ?? 1;
  const count = countOccurrences(text, operation.find);
  if (count !== expected) {
    throw new Error(
      `text.patch expected ${expected} occurrence(s) of the find text but found ${count}.`,
    );
  }
  const next = text.split(operation.find).join(operation.replace);
  if (next === text) throw new Error("text.patch made no change.");
  return next;
}

interface TextHandle {
  text: string;
  exists: boolean;
  set(next: string): void;
}

function inlineResourceText(
  entry: unknown,
  field: string,
  component: EvolutionComponentId,
): TextHandle {
  if (!isRecord(entry)) {
    throw new Error(
      `Inline ${component} entry does not have a "${field}" field.`,
    );
  }
  const value = entry[field];
  return {
    text: typeof value === "string" ? value : "",
    exists: typeof value === "string",
    set(next) {
      entry[field] = next;
    },
  };
}

function resolveTextHandle(
  state: ApplyState,
  target: EvolutionTarget,
): TextHandle {
  const meta = EVOLUTION_COMPONENT_META[target.component];
  if (!meta.text) {
    throw new Error(
      `Evolution component "${target.component}" does not have patchable text.`,
    );
  }
  if (target.asset) {
    if (!meta.assets) {
      throw new Error(
        `Evolution component "${target.component}" does not own assets.`,
      );
    }
    const path = normalizeAssetPath(target.asset);
    return {
      text: readAsset(state, path),
      exists: true,
      set(next) {
        writeAsset(state, path, next);
      },
    };
  }

  if (target.component === "instructions") {
    const field = target.field;
    if (field !== "system_prompt" && field !== "append_system_prompt") {
      throw new Error(
        `Evolution instructions text operations require target.field "system_prompt" or "append_system_prompt".`,
      );
    }
    const value = state.genome[field];
    return {
      text: typeof value === "string" ? value : "",
      exists: typeof value === "string",
      set(next) {
        state.genome[field] = next;
      },
    };
  }

  if (target.component === "skills" || target.component === "commands") {
    const collection =
      target.component === "skills" ? state.genome.skills : state.genome.prompt_templates;
    if (!Array.isArray(collection)) {
      throw new Error(`Evolution ${target.component} collection is not an array.`);
    }
    const index = requireEntryIndex(collection, target.entry as string, target.component);
    const entry = collection[index];
    const field = target.field ?? "content";
    if (field !== "content" && field !== "description") {
      throw new Error(
        `Evolution ${target.component} text operations only edit content or description.`,
      );
    }
    const fileBacked =
      typeof entry === "string" ||
      (isRecord(entry) && typeof entry.source === "string");
    if (fileBacked) {
      const source = typeof entry === "string" ? entry : entry.source;
      const path = assetPathForSource(state, target.component, source);
      return {
        text: readAsset(state, path),
        exists: true,
        set(next) {
          writeAsset(state, path, next);
        },
      };
    }
    return inlineResourceText(entry, field, target.component);
  }

  if (target.component === "memory") {
    const entries = memoryEntries(state.genome);
    const index = findMemoryEntryIndex(entries, target.entry as string);
    const entry = entries[index];
    const field = target.field ?? "content";
    if (field !== "content" && field !== "kind") {
      throw new Error("Evolution memory text operations only edit content or kind.");
    }
    return inlineResourceText(entry, field, "memory");
  }

  throw new Error(
    `Evolution component "${target.component}" has no text target for "${String(target.field ?? target.asset)}".`,
  );
}

function memoryEntries(genome: Record<string, any>): Record<string, any>[] {
  genome.memory ??= {};
  if (!isRecord(genome.memory)) {
    throw new Error("Genome memory is not an object; cannot edit entries.");
  }
  genome.memory.snapshot ??= { entries: [] };
  if (!isRecord(genome.memory.snapshot)) {
    throw new Error("Genome memory.snapshot is not an object; cannot edit entries.");
  }
  if (!Array.isArray(genome.memory.snapshot.entries)) {
    genome.memory.snapshot.entries = [];
  }
  return genome.memory.snapshot.entries;
}

function findMemoryEntryIndex(entries: Record<string, any>[], key: string): number {
  const matches: number[] = [];
  for (const [index, entry] of entries.entries()) {
    if (isRecord(entry) && entry.content === key) matches.push(index);
  }
  if (matches.length === 0) {
    throw new Error(`Evolution memory entry "${key}" does not exist.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Evolution memory entry "${key}" is ambiguous; content matches ${matches.length} entries.`,
    );
  }
  return matches[0];
}

function ensureArray(genome: Record<string, any>, field: string): unknown[] {
  if (genome[field] === undefined) genome[field] = [];
  if (!Array.isArray(genome[field])) {
    throw new Error(`Genome ${field} is not an array; cannot edit entries.`);
  }
  return genome[field];
}

function touch(
  state: ApplyState,
  component: EvolutionComponentId,
  field?: string,
): void {
  state.changedComponents.add(component);
  if (!field) return;
  const fields = state.changedFields.get(component) ?? new Set<string>();
  fields.add(field);
  state.changedFields.set(component, fields);
}

function requireFieldAllowed(component: EvolutionComponentId, field: string): void {
  const fields = EVOLUTION_COMPONENT_META[component].fields;
  if (fields !== "*" && !fields.includes(field)) {
    throw new Error(`Field "${field}" is not editable on "${component}".`);
  }
}

function applyInlineEntryUpdate(
  entry: unknown,
  value: Record<string, any>,
  options: { replace: boolean; name?: string },
): Record<string, any> {
  if (options.replace) {
    return {
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(value.description === undefined ? {} : { description: String(value.description) }),
      ...(value.content === undefined ? {} : { content: String(value.content) }),
      ...(value.enabled === undefined ? {} : { enabled: Boolean(value.enabled) }),
    };
  }
  const next = isRecord(entry) ? { ...entry } : {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (key === "enabled") next.enabled = Boolean(fieldValue);
    else if (key === "description" || key === "content") next[key] = String(fieldValue);
  }
  return next;
}

function applySkillsOrCommandsEntry(
  state: ApplyState,
  component: "skills" | "commands",
  operation: Extract<EvolutionOperation, { op: "entry.update" | "entry.upsert" | "entry.remove" }>,
): void {
  const collection = ensureArray(
    state.genome,
    component === "skills" ? "skills" : "prompt_templates",
  );
  const name = operation.target.entry as string;
  const index = findEntryIndex(collection, name);
  const value = "value" in operation ? operation.value : {};

  if (operation.op === "entry.remove") {
    if (index < 0) {
      throw new Error(`Evolution ${component} entry "${name}" does not exist.`);
    }
    const [removed] = collection.splice(index, 1);
    const source =
      typeof removed === "string" ? removed : isRecord(removed) ? removed.source : undefined;
    if (typeof source === "string") {
      state.notes.push(
        `Removed ${component} entry "${name}" but left its files in place; use asset.remove to delete them.`,
      );
    }
    touch(state, component, "entries");
    return;
  }

  if (operation.op === "entry.update") {
    if (index < 0) {
      throw new Error(`Evolution ${component} entry "${name}" does not exist.`);
    }
    const existing = collection[index];
    const fileBacked =
      typeof existing === "string" ||
      (isRecord(existing) && typeof existing.source === "string");
    if (fileBacked) {
      const originalSource = typeof existing === "string" ? existing : existing.source;
      let source = originalSource;
      const entry =
        typeof existing === "string" ? { source: existing } : { ...existing };
      if (value.source !== undefined) {
        if (typeof value.source !== "string" || value.source.trim() === "") {
          throw new Error(`Evolution ${component} entry "${name}" source must be a non-empty string.`);
        }
        source = value.source;
        entry.source = value.source;
      }
      for (const [field, fieldValue] of Object.entries(value)) {
        if (field === "source") continue;
        if (field === "content") {
          const path = assetPathForSource(state, component, source);
          writeAsset(state, path, String(fieldValue));
        } else if (field === "description") {
          const path = assetPathForSource(state, component, source);
          writeAsset(
            state,
            path,
            updateFrontmatter(readAsset(state, path), "description", String(fieldValue)),
          );
        } else if (field === "enabled") {
          entry.enabled = Boolean(fieldValue);
        }
      }
      collection[index] = entry;
    } else if (value.source !== undefined) {
      // An explicit source converts an inline entry to a file-backed one; the
      // body has to live in the file from then on.
      if (typeof value.source !== "string" || value.source.trim() === "") {
        throw new Error(`Evolution ${component} entry "${name}" source must be a non-empty string.`);
      }
      const entry: Record<string, any> = { source: value.source };
      if (value.enabled !== undefined) entry.enabled = Boolean(value.enabled);
      if (value.content !== undefined) {
        const path = assetPathForSource(state, component, value.source);
        writeAsset(state, path, String(value.content));
      }
      collection[index] = entry;
    } else {
      collection[index] = applyInlineEntryUpdate(existing, value, {
        replace: false,
      });
    }
    touch(state, component, "entries");
    return;
  }

  // entry.upsert
  const nextSource =
    typeof value.source === "string" ? value.source : undefined;
  if (index >= 0) {
    const existing = collection[index];
    const fileBacked =
      typeof existing === "string" ||
      (isRecord(existing) && typeof existing.source === "string");
    if (fileBacked || nextSource !== undefined) {
      const source =
        nextSource ??
        (typeof existing === "string" ? existing : (existing as Record<string, any>).source);
      const entry: Record<string, any> = { source };
      if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
        for (const [key, fieldValue] of Object.entries(existing)) {
          if (key !== "source" && key !== "name" && key !== "description" && key !== "content") {
            entry[key] = cloneJson(fieldValue);
          }
        }
      }
      if (value.enabled !== undefined) entry.enabled = Boolean(value.enabled);
      if (value.content !== undefined) {
        const path = assetPathForSource(state, component, source);
        writeAsset(state, path, String(value.content));
      }
      if (value.description !== undefined) {
        const path = assetPathForSource(state, component, source);
        writeAsset(
          state,
          path,
          updateFrontmatter(readAsset(state, path), "description", String(value.description)),
        );
      }
      collection[index] = entry;
    } else {
      collection[index] = applyInlineEntryUpdate(existing, value, {
        replace: true,
        name: isRecord(existing) && typeof existing.name === "string" ? existing.name : name,
      });
    }
    touch(state, component, "entries");
    return;
  }

  if (nextSource !== undefined) {
    const entry: Record<string, any> = { source: nextSource };
    if (value.enabled !== undefined) entry.enabled = Boolean(value.enabled);
    if (value.content !== undefined) {
      const path = assetPathForSource(state, component, nextSource);
      writeAsset(state, path, String(value.content));
    }
    collection.push(entry);
    if (value.description !== undefined) {
      state.notes.push(
        `New file-backed ${component} "${name}" description must live in its file; supply it in the file body.`,
      );
    }
    touch(state, component, "entries");
    return;
  }

  if (value.content === undefined || String(value.content).trim() === "") {
    throw new Error(
      `Creating inline ${component} "${name}" requires a non-empty content value.`,
    );
  }
  collection.push({
    name,
    description: String(value.description ?? ""),
    content: String(value.content),
    ...(value.enabled === undefined ? {} : { enabled: Boolean(value.enabled) }),
  });
  touch(state, component, "entries");
}

function applyMemoryEntry(
  state: ApplyState,
  operation: Extract<EvolutionOperation, { op: "entry.update" | "entry.upsert" | "entry.remove" }>,
): void {
  const entries = memoryEntries(state.genome);
  const key = operation.target.entry as string;

  if (operation.op === "entry.remove") {
    const index = findMemoryEntryIndex(entries, key);
    entries.splice(index, 1);
    touch(state, "memory", "entries");
    return;
  }

  if (operation.op === "entry.update") {
    const index = findMemoryEntryIndex(entries, key);
    const value = operation.value;
    if (value.kind !== undefined && !MEMORY_KINDS.has(String(value.kind))) {
      throw new Error(`Unknown memory kind "${String(value.kind)}".`);
    }
    if (value.content !== undefined && String(value.content).trim() === "") {
      throw new Error("Memory entry content must be non-empty.");
    }
    entries[index] = {
      ...entries[index],
      ...(value.kind === undefined ? {} : { kind: String(value.kind) }),
      ...(value.content === undefined ? {} : { content: String(value.content) }),
    };
    touch(state, "memory", "entries");
    return;
  }

  // entry.upsert: an existing entry is addressed by its old content, otherwise
  // by the new content. Memory entries have no separate stable id.
  const value = operation.value;
  const content = value.content === undefined ? key : String(value.content);
  if (content.trim() === "") {
    throw new Error("Memory entry content must be non-empty.");
  }
  if (value.kind !== undefined && !MEMORY_KINDS.has(String(value.kind))) {
    throw new Error(`Unknown memory kind "${String(value.kind)}".`);
  }
  let index = -1;
  try {
    index = findMemoryEntryIndex(entries, key);
  } catch {
    index = -1;
  }
  if (index < 0) {
    index = entries.findIndex(
      (entry) => isRecord(entry) && entry.content === content,
    );
  }
  if (index >= 0) {
    entries[index] = {
      ...entries[index],
      ...(value.kind === undefined ? {} : { kind: String(value.kind) }),
      content,
    };
  } else {
    entries.push({
      kind: value.kind === undefined ? "knowledge" : String(value.kind),
      content,
    });
  }
  touch(state, "memory", "entries");
}

function applyToolEntry(
  state: ApplyState,
  operation: Extract<EvolutionOperation, { op: "entry.update" | "entry.upsert" | "entry.remove" }>,
): void {
  const tools = ensureArray(state.genome, "tools");
  const name = operation.target.entry as string;
  const index = findEntryIndex(tools, name);

  if (operation.op === "entry.remove") {
    if (index < 0) {
      throw new Error(`Evolution tools entry "${name}" does not exist.`);
    }
    const generated = Array.isArray(state.genome.generated_tools)
      ? state.genome.generated_tools.some((tool: any) => tool?.name === name)
      : false;
    if (generated) {
      throw new Error(
        `Generated tool "${name}" cannot be removed by evolution.`,
      );
    }
    tools.splice(index, 1);
    touch(state, "tools", "entries");
    return;
  }

  if (operation.op === "entry.update") {
    if (index < 0) {
      throw new Error(`Evolution tools entry "${name}" does not exist.`);
    }
    const entry = { ...(isRecord(tools[index]) ? tools[index] : { name }) };
    for (const [field, value] of Object.entries(operation.value)) {
      requireFieldAllowed("tools", field);
      if (field === "enabled") entry.enabled = Boolean(value);
      else if (field === "description") entry.description = String(value);
      else if (field === "parameters") entry.parameters = cloneJson(value);
    }
    tools[index] = entry;
    touch(state, "tools", "entries");
    return;
  }

  if (
    Array.isArray(state.genome.generated_tools) &&
    state.genome.generated_tools.some((tool: any) => tool?.name === name)
  ) {
    throw new Error(`Generated tool "${name}" cannot be replaced by evolution.`);
  }
  const entry: Record<string, any> = {
    name,
    enabled: operation.value.enabled === undefined ? true : Boolean(operation.value.enabled),
  };
  if (operation.value.description !== undefined) {
    entry.description = String(operation.value.description);
  }
  if (operation.value.parameters !== undefined) {
    entry.parameters = cloneJson(operation.value.parameters);
  }
  if (index < 0) tools.push(entry);
  else tools[index] = entry;
  touch(state, "tools", "entries");
}

function applyIntegrationsEntry(
  state: ApplyState,
  operation: Extract<EvolutionOperation, { op: "entry.update" | "entry.upsert" | "entry.remove" }>,
): void {
  state.genome.mcp ??= { servers: [] };
  if (!isRecord(state.genome.mcp)) {
    throw new Error("Genome mcp is not an object; cannot edit servers.");
  }
  if (!Array.isArray(state.genome.mcp.servers)) state.genome.mcp.servers = [];
  const servers = state.genome.mcp.servers;
  const name = operation.target.entry as string;
  const index = servers.findIndex((server: any) => server?.name === name);

  if (operation.op === "entry.remove") {
    if (index < 0) {
      throw new Error(`Evolution MCP server "${name}" does not exist.`);
    }
    servers.splice(index, 1);
    touch(state, "integrations", "mcp");
    return;
  }

  if (operation.op === "entry.update") {
    if (index < 0) {
      throw new Error(`Evolution MCP server "${name}" does not exist.`);
    }
    servers[index] = { ...servers[index], ...cloneJson(operation.value), name };
    touch(state, "integrations", "mcp");
    return;
  }

  const next = {
    ...(index < 0 ? {} : servers[index]),
    ...cloneJson(operation.value),
    name,
  };
  if (index < 0) servers.push(next);
  else servers[index] = next;
  touch(state, "integrations", "mcp");
}

function applyFieldSet(
  state: ApplyState,
  operation: Extract<EvolutionOperation, { op: "field.set" }>,
): void {
  const { component } = operation.target;
  const field = operation.target.field as string;
  requireFieldAllowed(component, field);
  const genome = state.genome;

  if (component === "instructions") {
    genome[field] = operation.value;
  } else if (component === "skills" || component === "commands") {
    const collection = ensureArray(
      genome,
      component === "skills" ? "skills" : "prompt_templates",
    );
    const index = requireEntryIndex(collection, operation.target.entry as string, component);
    const existing = collection[index];
    const fileBacked =
      typeof existing === "string" ||
      (isRecord(existing) && typeof existing.source === "string");
    if (fileBacked) {
      const source = typeof existing === "string" ? existing : existing.source;
      const entry = typeof existing === "string" ? { source: existing } : { ...existing };
      if (field === "content") {
        const path = assetPathForSource(state, component, source);
        writeAsset(state, path, String(operation.value));
      } else if (field === "description") {
        const path = assetPathForSource(state, component, source);
        writeAsset(
          state,
          path,
          updateFrontmatter(readAsset(state, path), "description", String(operation.value)),
        );
      } else if (field === "enabled") {
        entry.enabled = Boolean(operation.value);
      }
      collection[index] = entry;
    } else {
      collection[index] = applyInlineEntryUpdate(
        existing,
        { [field]: operation.value },
        { replace: false },
      );
    }
  } else if (component === "tools") {
    applyToolEntry(state, {
      op: "entry.update",
      target: operation.target,
      value: { [field]: operation.value },
    });
  } else if (component === "memory") {
    applyMemoryEntry(state, {
      op: "entry.update",
      target: operation.target,
      value: { [field]: operation.value },
    });
  } else if (component === "policies") {
    genome.policies ??= {};
    genome.policies[field] = cloneJson(operation.value);
  } else if (component === "runtime") {
    genome.runtime ??= {};
    genome.runtime[field] = cloneJson(operation.value);
  } else if (component === "integrations") {
    if (field === "extensions") genome.extensions = cloneJson(operation.value);
    else if (field === "mcp") genome.mcp = cloneJson(operation.value);
    else throw new Error(`Field "${field}" is not editable on "integrations".`);
  } else if (component === "model") {
    if (field === "model_options") genome.model_options = cloneJson(operation.value);
    else if (field === "model") genome.model = cloneJson(operation.value);
    else {
      genome.model ??= {};
      genome.model[field] = cloneJson(operation.value);
    }
  } else {
    genome[component] ??= {};
    genome[component][field] = cloneJson(operation.value);
  }
  touch(state, component, field);
}

function applyComponentSet(
  state: ApplyState,
  operation: Extract<EvolutionOperation, { op: "component.set" }>,
): void {
  const { component } = operation.target;
  const value = cloneJson(operation.value);
  const genome = state.genome;

  switch (component) {
    case "instructions": {
      const allowed = new Set(["system_prompt", "append_system_prompt"]);
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          throw new Error(`Field "${key}" is not editable on "instructions".`);
        }
      }
      for (const [key, fieldValue] of Object.entries(value)) {
        if (typeof fieldValue !== "string") {
          throw new Error(`instructions.${key} must be a string.`);
        }
        genome[key] = fieldValue;
      }
      break;
    }
    case "skills":
      if (!Array.isArray(value.skills)) {
        throw new Error('component.set on "skills" requires a "skills" array.');
      }
      genome.skills = value.skills;
      break;
    case "commands":
      if (!Array.isArray(value.prompt_templates)) {
        throw new Error(
          'component.set on "commands" requires a "prompt_templates" array.',
        );
      }
      genome.prompt_templates = value.prompt_templates;
      break;
    case "tools": {
      if (!Array.isArray(value.tools)) {
        throw new Error('component.set on "tools" requires a "tools" array.');
      }
      if (value.generated_tools !== undefined) {
        const current = canonicalJson(genome.generated_tools ?? []);
        const next = canonicalJson(value.generated_tools);
        if (current !== next) {
          throw new Error("Generated tools cannot be changed by evolution.");
        }
      }
      genome.tools = value.tools;
      break;
    }
    case "memory":
      genome.memory = value;
      break;
    case "policies":
      genome.policies = value;
      break;
    case "runtime":
      genome.runtime = value;
      break;
    case "integrations": {
      const allowed = new Set(["extensions", "mcp"]);
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          throw new Error(`Field "${key}" is not editable on "integrations".`);
        }
      }
      if (value.extensions !== undefined) genome.extensions = value.extensions;
      if (value.mcp !== undefined) genome.mcp = value.mcp;
      break;
    }
    case "model":
      genome.model = value;
      break;
    case "appearance":
    case "settings":
    case "keybindings":
    case "resources":
      genome[component] = value;
      break;
    default:
      throw new Error(`component.set does not support "${component}".`);
  }
  touch(state, component, "component");
}

function summarize(operation: EvolutionOperation): string {
  const target = operation.target;
  const location = [target.component, target.entry, target.field, target.asset]
    .filter(Boolean)
    .join(".");
  return `${operation.op} ${location}`;
}

function applyOperation(
  state: ApplyState,
  operation: EvolutionOperation,
  index: number,
): void {
  const before =
    operation.op.startsWith("entry.") || operation.op === "field.set" || operation.op === "component.set"
      ? JSON.stringify(state.genome)
      : undefined;

  switch (operation.op) {
    case "text.patch": {
      const handle = resolveTextHandle(state, operation.target);
      if (!handle.exists) {
        throw new Error(
          `text.patch target does not exist on "${operation.target.component}".`,
        );
      }
      handle.set(spliceText(handle.text, operation));
      break;
    }
    case "text.append": {
      const handle = resolveTextHandle(state, operation.target);
      handle.set(`${handle.text}${operation.text}`);
      break;
    }
    case "text.set": {
      const handle = resolveTextHandle(state, operation.target);
      if (handle.exists && handle.text === operation.text) {
        throw new Error("text.set made no change.");
      }
      handle.set(operation.text);
      break;
    }
    case "entry.update":
    case "entry.upsert":
    case "entry.remove": {
      if (operation.target.component === "skills" || operation.target.component === "commands") {
        applySkillsOrCommandsEntry(state, operation.target.component, operation);
      } else if (operation.target.component === "memory") {
        applyMemoryEntry(state, operation);
      } else if (operation.target.component === "tools") {
        applyToolEntry(state, operation);
      } else if (operation.target.component === "integrations") {
        applyIntegrationsEntry(state, operation);
      } else {
        throw new Error(
          `entry operations are not supported for "${operation.target.component}".`,
        );
      }
      break;
    }
    case "asset.create": {
      if (!operation.target.asset) {
        throw new Error("asset.create requires target.asset.");
      }
      const path = normalizeAssetPath(operation.target.asset);
      if (hasAsset(state, path)) {
        throw new Error(
          `asset.create target already exists: ${path}; use text.patch or entry.upsert.`,
        );
      }
      writeAsset(state, path, operation.content);
      touch(state, operation.target.component, path);
      break;
    }
    case "asset.remove": {
      if (!operation.target.asset) {
        throw new Error("asset.remove requires target.asset.");
      }
      const path = normalizeAssetPath(operation.target.asset);
      if (state.assetWrites.has(path)) {
        state.assetWrites.delete(path);
      } else if (hasAsset(state, path)) {
        state.assetRemovals.add(path);
      } else {
        throw new Error(`asset.remove target does not exist: ${path}`);
      }
      touch(state, operation.target.component, path);
      break;
    }
    case "field.set":
      applyFieldSet(state, operation);
      break;
    case "component.set":
      applyComponentSet(state, operation);
      break;
    default:
      throw new Error(`Unsupported evolution operation "${(operation as any).op}".`);
  }

  if (operation.op.startsWith("text.")) {
    touch(
      state,
      operation.target.component,
      operation.target.field ?? operation.target.asset,
    );
  }

  if (before !== undefined && JSON.stringify(state.genome) === before) {
    throw new Error(`operation ${index + 1} (${operation.op}) made no change.`);
  }
}

export function applyEvolutionPatch(
  input: EvolutionApplyInput,
  rawPatch: unknown,
): EvolutionApplyResult {
  const patch: EvolutionPatch = validateEvolutionPatch(rawPatch);
  if (!isRecord(input.genome)) {
    throw new Error("applyEvolutionPatch requires a resolved genome object.");
  }
  if (patch.base_genome_id !== input.genome.genome_id) {
    throw new Error(
      `Evolution patch targets "${patch.base_genome_id}" but the base genome is "${String(input.genome.genome_id)}".`,
    );
  }
  if (
    patch.base_version !== undefined &&
    Number(input.genome.version ?? 1) !== patch.base_version
  ) {
    throw new Error(
      `Evolution patch targets version ${patch.base_version} but the base genome is version ${String(input.genome.version ?? 1)}.`,
    );
  }

  const state: ApplyState = {
    genome: cloneJson(input.genome),
    baseDirectory: resolve(input.baseDirectory),
    assetWrites: new Map(
      (input.assetWrites ?? []).map((asset) => [normalizeAssetPath(asset.path), asset.content]),
    ),
    assetRemovals: new Set(
      (input.assetRemovals ?? []).map((path) => normalizeAssetPath(path)),
    ),
    changedComponents: new Set(),
    changedFields: new Map(),
    notes: [],
  };

  const operations: EvolutionAppliedOperation[] = [];
  for (const [index, operation] of patch.operations.entries()) {
    applyOperation(state, operation, index);
    operations.push({
      index,
      op: operation.op,
      component: operation.target.component,
      entry: operation.target.entry,
      field: operation.target.field,
      asset: operation.target.asset,
      wide: isWideEvolutionOperation(operation),
      summary: summarize(operation),
    });
  }

  const changedFields: Record<string, string[]> = {};
  for (const [component, fields] of state.changedFields) {
    changedFields[component] = [...fields].sort();
  }

  return {
    genome: state.genome,
    changed_components: [...state.changedComponents].sort(),
    changed_fields: changedFields,
    asset_writes: [...state.assetWrites.entries()]
      .map(([path, content]) => ({ path, content }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    asset_removals: [...state.assetRemovals].sort(),
    operations,
    notes: state.notes,
  };
}
