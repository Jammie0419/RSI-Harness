/**
 * Deterministic materialization of an evolved Genome.
 *
 * "Compile" here means only one thing: project the in-memory working model back
 * onto ordinary bundle files. The result is the same self-contained v3 layout
 * `gee` writes, so the runtime keeps loading it with the existing core loader.
 *
 * Only components whose values changed are rewritten; every other file is a
 * byte-for-byte copy of the base. The core loader/validator is the final
 * authority, but it is only ever called read-only.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, cloneJson, contentHash } from "../../core/json.ts";
import {
  componentOperations,
  loadHarnessGenomeFile,
} from "../genome-bundle.ts";
import {
  genomeContentHash,
  GENOME_MANIFEST_NAME,
  SEED_MARKER_NAME,
} from "../genome-loader.ts";
import { assertHarnessComplexity, validateHarnessGenome } from "../genome.ts";
import { projectGenomeSettings } from "../pi-projection.ts";
import { mergeManagedSettings } from "../settings-layer.ts";
import type { EvolutionComponentId } from "./components.ts";

/**
 * Evolution components mapped to the core component file that stores them.
 * `memory` and `policies` share `components/policies.json`; the compiler groups
 * them so one file is written with both fields.
 */
export const EVOLUTION_TO_CORE_COMPONENT: Record<
  EvolutionComponentId,
  { id: string; fields: string[] }
> = {
  instructions: {
    id: "instructions",
    fields: ["system_prompt", "append_system_prompt"],
  },
  skills: { id: "skills", fields: ["skills"] },
  tools: { id: "tools", fields: ["tools", "generated_tools"] },
  commands: { id: "commands", fields: ["prompt_templates"] },
  memory: { id: "policies", fields: ["memory"] },
  policies: { id: "policies", fields: ["policies"] },
  runtime: { id: "runtime", fields: ["runtime"] },
  integrations: { id: "integrations", fields: ["extensions", "mcp"] },
  model: { id: "model", fields: ["model", "model_options"] },
  appearance: { id: "appearance", fields: ["appearance"] },
  settings: { id: "settings", fields: ["settings"] },
  keybindings: { id: "keybindings", fields: ["keybindings"] },
  resources: { id: "resources", fields: ["resources"] },
};

/** Every core component id and the genome fields it owns. */
const CORE_COMPONENT_FIELDS: Record<string, string[]> = Object.fromEntries(
  Object.values(EVOLUTION_TO_CORE_COMPONENT).map(({ id, fields }) => [id, fields]),
);

export interface EvolutionCompileMetadata {
  created_at?: string;
  intent?: string;
  base_name?: string;
  base_content_hash?: string;
  evidence_hash?: string;
  patch_hash?: string;
  patch_id?: string;
  hypothesis?: string;
  operation_count?: number;
  model?: { profile?: string; id?: string };
  baseline_at?: string;
  baseline_source?: string;
}

export interface CompileEvolutionBundleOptions {
  /** Resolved base bundle directory (contains `genome.json`). */
  baseDirectory: string;
  /** Destination directory; must not exist yet. */
  outputDirectory: string;
  /** Working model produced by `applyEvolutionPatch`. */
  genome: Record<string, any>;
  changedComponents: readonly EvolutionComponentId[];
  assetWrites?: readonly { path: string; content: string }[];
  assetRemovals?: readonly string[];
  metadata: EvolutionCompileMetadata;
  /** Fail if the base bundle changed since the patch/proposal was made. */
  expectedBaseContentHash?: string;
}

export interface CompiledEvolutionBundle {
  directory: string;
  manifestPath: string;
  genome: Record<string, any>;
  components_written: string[];
  assets_written: string[];
  assets_removed: string[];
  complexity: ReturnType<typeof assertHarnessComplexity>;
}

interface ManifestComponent {
  id: string;
  source?: string;
  contract?: string;
  allowed_operations?: string[];
  config?: Record<string, any>;
  [key: string]: any;
}

function readJson(path: string, label: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} could not be read: ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function relativeInside(baseDirectory: string, value: string, label: string): string {
  const normalized = String(value).replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`${label} must be relative to the bundle: ${value}`);
  }
  const target = resolve(baseDirectory, normalized);
  const rel = relative(baseDirectory, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} escapes the bundle: ${value}`);
  }
  return rel.replace(/\\/g, "/");
}

/** Drop generated bookkeeping fields from resource entries before writing. */
function withoutEntryMetadata(value: unknown): unknown {
  if (!Array.isArray(value)) return cloneJson(value);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return cloneJson(entry);
    }
    const copy = cloneJson(entry);
    delete copy.component_id;
    delete copy.content_hash;
    return copy;
  });
}

function componentConfig(
  genome: Record<string, any>,
  fields: readonly string[],
): Record<string, any> {
  const config: Record<string, any> = {};
  for (const field of fields) {
    if (genome[field] !== undefined) {
      config[field] = withoutEntryMetadata(genome[field]);
    }
  }
  return config;
}

function writeComponentFile(path: string, componentId: string, config: Record<string, any>) {
  const existing = existsSync(path) ? readJson(path, `Component ${componentId}`) : undefined;
  const metadata =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? Object.fromEntries(
          Object.entries(existing).filter(([key]) => key !== "config"),
        )
      : {};
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        ...metadata,
        component_schema_version: metadata.component_schema_version ?? "1",
        component_id: metadata.component_id ?? componentId,
        config,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function assertRepoResource(
  staging: string,
  source: unknown,
  label: string,
): void {
  if (source === undefined) return;
  if (typeof source !== "string" || source.trim() === "") {
    throw new Error(`${label} requires a non-empty relative source.`);
  }
  const rel = relativeInside(staging, source, label);
  if (!existsSync(resolve(staging, rel))) {
    throw new Error(`${label} does not exist inside the new bundle: ${source}`);
  }
}

function assertBundleResources(staging: string, genome: Record<string, any>): void {
  for (const entry of genome.skills ?? []) {
    if (typeof entry === "string") {
      assertRepoResource(staging, entry, "Skill source");
    } else if (entry && typeof entry === "object") {
      assertRepoResource(staging, entry.source, `Skill "${entry.name ?? ""}" source`);
    }
  }
  for (const entry of genome.prompt_templates ?? []) {
    if (typeof entry === "string") {
      assertRepoResource(staging, entry, "Prompt template source");
    } else if (entry && typeof entry === "object") {
      assertRepoResource(
        staging,
        entry.source,
        `Prompt template "${entry.name ?? ""}" source`,
      );
    }
  }
  for (const entry of genome.extensions ?? []) {
    const source =
      typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.source : undefined;
    assertRepoResource(staging, source, "Extension source");
  }
  for (const [index, theme] of (genome.appearance?.themes ?? []).entries()) {
    assertRepoResource(staging, theme, `Appearance theme ${index}`);
  }
}

function assertGeneratedToolsUnchanged(
  baseGenome: Record<string, any>,
  nextGenome: Record<string, any>,
): void {
  const before = canonicalJson(baseGenome.generated_tools ?? []);
  const after = canonicalJson(nextGenome.generated_tools ?? []);
  if (before !== after) {
    throw new Error(
      "Generated tools cannot be added, removed, or changed by evolution.",
    );
  }
}

function firstDifferingKey(
  left: Record<string, any>,
  right: Record<string, any>,
): string | undefined {
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (canonicalJson(left[key]) !== canonicalJson(right[key])) return key;
  }
  return undefined;
}

function assertSemanticEquivalence(
  loaded: Record<string, any>,
  expected: Record<string, any>,
): void {
  const strip = (genome: Record<string, any>) => {
    const copy = cloneJson(genome);
    delete copy.component_manifest;
    return copy;
  };
  const left = strip(loaded);
  const right = strip(expected);
  if (canonicalJson(left) !== canonicalJson(right)) {
    const key = firstDifferingKey(left, right);
    const preview = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return text.length > 300 ? `${text.slice(0, 300)}...` : text;
    };
    throw new Error(
      `The materialized bundle does not load back to the working model; refusing to install it` +
        (key
          ? ` (first differing field: ${key}; loaded=${preview(left[key])} expected=${preview(right[key])}).`
          : "."),
    );
  }
}

/**
 * The next integer revision for an evolved Genome. The name never changes.
 * `patch_hash` is part of the id so two different changes at the same revision
 * cannot share an id.
 */
export function createEvolvedGenome(
  baseGenome: Record<string, any>,
  patchHash: string,
  version?: number,
): Record<string, any> {
  const next = cloneJson(baseGenome);
  const nextVersion =
    version === undefined
      ? Math.max(1, Number(baseGenome.version ?? 1)) + 1
      : Math.max(1, Math.floor(version));
  if (nextVersion <= Number(baseGenome.version ?? 0)) {
    throw new Error(
      `An evolved Genome must have a revision above its base (${String(baseGenome.version ?? 1)}).`,
    );
  }
  next.genome_schema_version = "2";
  next.version = nextVersion;
  next.parent_id = baseGenome.genome_id;
  next.genome_id = `harness:${contentHash({
    parent: next.parent_id,
    version: next.version,
    patch_hash: patchHash,
  }).slice(0, 16)}`;
  return validateHarnessGenome(next);
}

function processMetadata(
  options: CompileEvolutionBundleOptions,
  baseGenome: Record<string, any>,
): Record<string, any> {
  return {
    schema_version: "1",
    created_at: options.metadata.created_at ?? new Date().toISOString(),
    intent: options.metadata.intent ?? "",
    base_name: options.metadata.base_name ?? "",
    base_genome_id: baseGenome.genome_id,
    base_version: Number(baseGenome.version ?? 1),
    base_content_hash:
      options.metadata.base_content_hash ?? options.expectedBaseContentHash ?? "",
    evidence_hash: options.metadata.evidence_hash ?? "",
    patch_id: options.metadata.patch_id ?? "",
    patch_hash: options.metadata.patch_hash ?? "",
    hypothesis: options.metadata.hypothesis ?? "",
    model: options.metadata.model ?? {},
    baseline_at: options.metadata.baseline_at ?? "",
    baseline_source: options.metadata.baseline_source ?? "",
    changed_components: [...options.changedComponents].sort(),
    operation_count: Math.max(0, Math.floor(options.metadata.operation_count ?? 0)),
  };
}

export function compileEvolutionBundle(
  options: CompileEvolutionBundleOptions,
): CompiledEvolutionBundle {
  const baseDirectory = resolve(options.baseDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  const manifestSource = join(baseDirectory, GENOME_MANIFEST_NAME);
  if (!existsSync(manifestSource)) {
    throw new Error(`Base bundle has no ${GENOME_MANIFEST_NAME}: ${baseDirectory}`);
  }
  if (existsSync(outputDirectory)) {
    throw new Error(`Compile destination already exists: ${outputDirectory}`);
  }
  if (options.expectedBaseContentHash !== undefined) {
    const actual = genomeContentHash(baseDirectory);
    if (actual !== options.expectedBaseContentHash) {
      throw new Error(
        "The base bundle changed after this patch was proposed; re-scan before applying it.",
      );
    }
  }

  const base = loadHarnessGenomeFile(manifestSource);
  const baseManifest = readJson(manifestSource, "Genome manifest");
  if (baseManifest.genome_schema_version !== "3" || !Array.isArray(baseManifest.components)) {
    throw new Error("Only v3 directory bundles can be evolved.");
  }
  assertGeneratedToolsUnchanged(base.genome, options.genome);

  try {
    cpSync(baseDirectory, outputDirectory, { recursive: true, force: true });
    rmSync(join(outputDirectory, SEED_MARKER_NAME), { force: true });

    const manifest = readJson(
      join(outputDirectory, GENOME_MANIFEST_NAME),
      "Genome manifest",
    );
    const components = [...(manifest.components ?? [])] as ManifestComponent[];

    // A chained base or manifest overrides would keep participating at load
    // time and could win over the newly written component files. Fold them into
    // explicit components instead so the result is a self-contained snapshot.
    const materializeAll =
      (manifest.base !== undefined && manifest.base !== "default") ||
      (manifest.overrides !== undefined &&
        Object.keys(manifest.overrides ?? {}).length > 0);

    const componentFields = new Map<string, Set<string>>();
    for (const component of options.changedComponents) {
      const mapped = EVOLUTION_TO_CORE_COMPONENT[component];
      if (!mapped) {
        throw new Error(`Unknown evolution component "${component}".`);
      }
      const fields = componentFields.get(mapped.id) ?? new Set<string>();
      for (const field of mapped.fields) fields.add(field);
      componentFields.set(mapped.id, fields);
    }
    if (materializeAll) {
      for (const [id, fields] of Object.entries(CORE_COMPONENT_FIELDS)) {
        if (fields.some((field) => options.genome[field] !== undefined)) {
          const existing = componentFields.get(id) ?? new Set<string>();
          for (const field of fields) existing.add(field);
          componentFields.set(id, existing);
        }
      }
    }

    const componentsWritten: string[] = [];
    for (const [coreId, fields] of componentFields) {
      const config = componentConfig(options.genome, [...fields]);
      const index = components.findIndex((component) => component.id === coreId);
      if (index >= 0) {
        const descriptor = components[index];
        if (descriptor.source !== undefined) {
          const source = relativeInside(
            outputDirectory,
            descriptor.source,
            `Component "${coreId}" source`,
          );
          const path = resolve(outputDirectory, source);
          if (!existsSync(path)) {
            throw new Error(
              `Component "${coreId}" source does not exist in the new bundle: ${descriptor.source}`,
            );
          }
          writeComponentFile(path, coreId, config);
        } else {
          components[index] = { ...descriptor, config };
        }
      } else {
        const contract = `contracts/${coreId}.dev.md`;
        if (!existsSync(join(outputDirectory, contract))) {
          throw new Error(
            `A new "${coreId}" component needs ${contract} in the base bundle.`,
          );
        }
        const source = `components/${coreId}.json`;
        mkdirSync(join(outputDirectory, "components"), { recursive: true });
        writeComponentFile(join(outputDirectory, source), coreId, config);
        components.push({
          id: coreId,
          source: `./${source}`,
          contract: `./${contract}`,
          allowed_operations: componentOperations(coreId),
        });
      }
      componentsWritten.push(coreId);
    }

    const assetsRemoved: string[] = [];
    for (const path of options.assetRemovals ?? []) {
      const safe = relativeInside(outputDirectory, path, "Removed asset");
      const target = resolve(outputDirectory, safe);
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
        assetsRemoved.push(safe);
      }
    }
    const assetsWritten: string[] = [];
    for (const asset of options.assetWrites ?? []) {
      const safe = relativeInside(outputDirectory, asset.path, "Asset");
      const target = resolve(outputDirectory, safe);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, asset.content, "utf8");
      assetsWritten.push(safe);
    }

    const metadata = processMetadata(options, base.genome);
    const manifestOutput: Record<string, any> = {
      ...manifest,
      genome_schema_version: "3",
      genome_id: options.genome.genome_id,
      version: options.genome.version,
      parent_id: options.genome.parent_id ?? null,
      base: "default",
      components,
      evolution: metadata,
    };
    delete manifestOutput.overrides;
    writeFileSync(
      join(outputDirectory, GENOME_MANIFEST_NAME),
      `${JSON.stringify(manifestOutput, null, 2)}\n`,
      "utf8",
    );

    const loaded = loadHarnessGenomeFile(join(outputDirectory, GENOME_MANIFEST_NAME));
    assertSemanticEquivalence(loaded.genome, options.genome);
    assertBundleResources(outputDirectory, loaded.genome);

    const projection = projectGenomeSettings(loaded.genome);
    mergeManagedSettings({}, projection.settings, {});
    mergeManagedSettings({}, projection.keybindings, {});

    const complexity = assertHarnessComplexity(loaded.genome);

    return {
      directory: outputDirectory,
      manifestPath: join(outputDirectory, GENOME_MANIFEST_NAME),
      genome: loaded.genome,
      components_written: componentsWritten,
      assets_written: assetsWritten,
      assets_removed: assetsRemoved,
      complexity,
    };
  } catch (error) {
    // A failed compile must never leave a half-written candidate that a later
    // step could mistake for a valid bundle.
    rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Hash used for `patch_hash` and for the generated `genome_id`. */
export function evolutionPatchHash(patch: unknown): string {
  return contentHash(patch);
}
