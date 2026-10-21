/**
 * The base-Genome summary the proposal model sees.
 *
 * Names and descriptions are not enough for a fine-grained edit: a
 * `text.patch` needs the exact text that currently exists. This module reads
 * the current bodies of skills and prompt templates from the base bundle,
 * prefers the entries the evidence actually used, and stops adding bodies once
 * the content budget is spent. When a body is omitted, the summary says so;
 * the model must then use an asset/full replacement instead of guessing a
 * `find` string.
 */

import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export interface BaseSummaryOptions {
  genome: Record<string, any>;
  baseDirectory: string;
  /** Skills the evidence showed being loaded; their bodies are included first. */
  focusSkills?: readonly string[];
  /** Total characters of bodies; default 60000. */
  maxContentChars?: number;
}

export interface BaseSummarySkill {
  name: string;
  description?: string;
  source?: string;
  enabled?: boolean;
  content?: string;
  content_omitted?: boolean;
}

export interface BaseSummaryCommand {
  name: string;
  description?: string;
  source?: string;
  enabled?: boolean;
  content?: string;
  content_omitted?: boolean;
}

export interface BaseSummary {
  genome_id?: string;
  version?: number;
  parent_id?: string;
  components: string[];
  instructions: {
    system_prompt?: string;
    append_system_prompt?: string;
  };
  skills: BaseSummarySkill[];
  tools: unknown[];
  generated_tools: { name: string; description?: string; enabled?: boolean }[];
  commands: BaseSummaryCommand[];
  memory: unknown[];
  policies?: unknown;
  model?: unknown;
  model_options?: unknown;
  resources?: unknown;
  extensions?: unknown;
  mcp?: unknown;
  content_chars: number;
  notes: string[];
}

const DEFAULT_MAX_CONTENT_CHARS = 60_000;

function sourceName(source: string, suffix = ""): string {
  const base = basename(source);
  const withoutExt = extname(base) ? base.slice(0, -extname(base).length) : base;
  return suffix && withoutExt.endsWith(suffix)
    ? withoutExt.slice(0, -suffix.length)
    : withoutExt;
}

function insideBundle(baseDirectory: string, source: string): string | undefined {
  if (isAbsolute(source)) return undefined;
  const target = resolve(baseDirectory, source);
  const rel = relative(baseDirectory, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return target;
}

function readBody(
  baseDirectory: string,
  source: string,
  preferredFile: string,
): { content?: string; note?: string } {
  const target = insideBundle(baseDirectory, source);
  if (!target) {
    return { note: `source "${source}" is outside the base bundle` };
  }
  let path = target;
  try {
    if (statSync(path).isDirectory()) path = join(path, preferredFile);
  } catch {
    return { note: `source "${source}" does not exist` };
  }
  if (!existsSync(path)) {
    return { note: `source "${source}" has no ${preferredFile}` };
  }
  try {
    return { content: readFileSync(path, "utf8") };
  } catch (error) {
    return {
      note: `source "${source}" could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function takeContent(
  content: string | undefined,
  budget: { remaining: number },
): { content?: string; omitted: boolean } {
  if (content === undefined) return { omitted: false };
  if (content.length > budget.remaining) return { omitted: true };
  budget.remaining -= content.length;
  return { content, omitted: false };
}

export function buildBaseSummary(options: BaseSummaryOptions): BaseSummary {
  const genome = options.genome ?? {};
  const baseDirectory = resolve(options.baseDirectory);
  const budget = {
    remaining: Math.max(
      0,
      Math.floor(options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS),
    ),
  };
  const focus = new Set(options.focusSkills ?? []);
  const notes: string[] = [];

  const instructions = {
    system_prompt: genome.system_prompt,
    append_system_prompt: genome.append_system_prompt,
  };
  budget.remaining -= [
    instructions.system_prompt,
    instructions.append_system_prompt,
  ]
    .filter((value) => typeof value === "string")
    .reduce((total, value) => total + value.length, 0);

  const rawSkills = Array.isArray(genome.skills) ? [...genome.skills] : [];
  rawSkills.sort((left, right) => {
    const leftName =
      typeof left === "string"
        ? sourceName(left)
        : typeof left?.name === "string"
          ? left.name
          : typeof left?.source === "string"
            ? sourceName(left.source)
            : "";
    const rightName =
      typeof right === "string"
        ? sourceName(right)
        : typeof right?.name === "string"
          ? right.name
          : typeof right?.source === "string"
            ? sourceName(right.source)
            : "";
    const leftFocus = focus.has(leftName) ? 0 : 1;
    const rightFocus = focus.has(rightName) ? 0 : 1;
    return leftFocus - rightFocus;
  });

  const skills: BaseSummarySkill[] = [];
  for (const entry of rawSkills) {
    if (typeof entry === "string") {
      const source = entry;
      const read = readBody(baseDirectory, source, "SKILL.md");
      if (read.note) notes.push(read.note);
      const taken = takeContent(read.content, budget);
      skills.push({
        name: sourceName(source),
        source,
        enabled: true,
        content: taken.content,
        content_omitted: taken.omitted || undefined,
      });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const source = typeof entry.source === "string" ? entry.source : undefined;
    const inline = typeof entry.content === "string" ? entry.content : undefined;
    const read = source ? readBody(baseDirectory, source, "SKILL.md") : {};
    if (read.note) notes.push(read.note);
    const taken = takeContent(inline ?? read.content, budget);
    skills.push({
      name:
        typeof entry.name === "string"
          ? entry.name
          : source
            ? sourceName(source)
            : "",
      description:
        typeof entry.description === "string" ? entry.description : undefined,
      source,
      enabled: entry.enabled !== false,
      content: taken.content,
      content_omitted: taken.omitted || undefined,
    });
  }

  const rawCommands = Array.isArray(genome.prompt_templates)
    ? [...genome.prompt_templates]
    : [];
  const commands: BaseSummaryCommand[] = [];
  for (const entry of rawCommands) {
    if (typeof entry === "string") {
      const source = entry;
      const read = readBody(baseDirectory, source, basename(source));
      if (read.note) notes.push(read.note);
      const taken = takeContent(read.content, budget);
      commands.push({
        name: sourceName(source),
        source,
        enabled: true,
        content: taken.content,
        content_omitted: taken.omitted || undefined,
      });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const source = typeof entry.source === "string" ? entry.source : undefined;
    const inline = typeof entry.content === "string" ? entry.content : undefined;
    const read = source ? readBody(baseDirectory, source, basename(source)) : {};
    if (read.note) notes.push(read.note);
    const taken = takeContent(inline ?? read.content, budget);
    commands.push({
      name:
        typeof entry.name === "string"
          ? entry.name
          : source
            ? sourceName(source)
            : "",
      description:
        typeof entry.description === "string" ? entry.description : undefined,
      source,
      enabled: entry.enabled !== false,
      content: taken.content,
      content_omitted: taken.omitted || undefined,
    });
  }

  if (skills.some((skill) => skill.content_omitted) ||
      commands.some((command) => command.content_omitted)) {
    notes.push(
      "Some skill/template bodies were omitted because the content budget was exhausted; use asset/full replacement rather than guessing a find string.",
    );
  }

  return {
    genome_id: genome.genome_id,
    version: genome.version,
    parent_id: genome.parent_id,
    components: (genome.component_manifest?.components ?? []).map(
      (component: any) => component.id,
    ),
    instructions,
    skills,
    tools: Array.isArray(genome.tools) ? genome.tools : [],
    generated_tools: (Array.isArray(genome.generated_tools)
      ? genome.generated_tools
      : []
    ).map((tool: any) => ({
      name: tool?.name,
      description: tool?.description,
      enabled: tool?.enabled !== false,
    })),
    commands,
    memory: Array.isArray(genome.memory?.snapshot?.entries)
      ? genome.memory.snapshot.entries
      : [],
    policies: genome.policies,
    model: genome.model,
    model_options: genome.model_options,
    resources: genome.resources,
    extensions: genome.extensions,
    mcp: genome.mcp,
    content_chars:
      Math.max(0, (options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS)) -
      Math.max(0, budget.remaining),
    notes,
  };
}
