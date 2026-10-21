/**
 * The evolution-owned patch vocabulary.
 *
 * This is intentionally separate from the core `HarnessPatch`. Evolution must
 * be able to change any component at entry/field/text granularity without
 * expanding the core patch enum, and the core must keep behaving exactly as it
 * does today. The final authority is still the core loader/validator after the
 * new bundle is materialized.
 */

import { isAbsolute } from "node:path";
import {
  EVOLUTION_COMPONENT_IDS,
  EVOLUTION_COMPONENT_META,
  evolutionComponentMeta,
  isEvolutionComponentId,
  isFieldAllowed,
  type EvolutionComponentId,
} from "./components.ts";

export const EVOLUTION_PATCH_SCHEMA_VERSION = "1";

/** Printed tools may be disabled but not removed. Kept local for decoupling. */
const PROTECTED_TOOL_NAMES = new Set([
  "read",
  "list",
  "ls",
  "grep",
  "find",
  "write",
  "edit",
  "bash",
  "powershell",
  "load_skill",
  "scratchpad",
]);

export interface EvolutionTarget {
  component: EvolutionComponentId;
  entry?: string;
  field?: string;
  asset?: string;
}

export type EvolutionOperation =
  | {
      op: "text.patch";
      target: EvolutionTarget;
      find: string;
      replace: string;
      expected_occurrences?: number;
    }
  | { op: "text.append"; target: EvolutionTarget; text: string }
  | { op: "text.set"; target: EvolutionTarget; text: string }
  | {
      op: "entry.update";
      target: EvolutionTarget;
      value: Record<string, unknown>;
    }
  | {
      op: "entry.upsert";
      target: EvolutionTarget;
      value: Record<string, unknown>;
    }
  | { op: "entry.remove"; target: EvolutionTarget }
  | {
      op: "asset.create";
      target: EvolutionTarget;
      content: string;
    }
  | { op: "asset.remove"; target: EvolutionTarget }
  | { op: "field.set"; target: EvolutionTarget; value: unknown }
  | { op: "component.set"; target: EvolutionTarget; value: Record<string, unknown> };

export interface EvolutionPatch {
  schema_version: typeof EVOLUTION_PATCH_SCHEMA_VERSION;
  patch_id?: string;
  base_genome_id: string;
  base_version?: number;
  base_content_hash?: string;
  hypothesis: string;
  evidence_refs: string[];
  operations: EvolutionOperation[];
  expected_effect: string;
  risks: string[];
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function validateAssetPath(path: string): string {
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`Evolution asset path must be relative: ${path}`);
  }
  const segments = path.split(/[\\/]+/);
  if (segments.includes("..")) {
    throw new Error(`Evolution asset path may not escape the bundle: ${path}`);
  }
  return path;
}

function validateTarget(raw: unknown): EvolutionTarget {
  const value = requireObject(raw, "Evolution target");
  if (!isEvolutionComponentId(value.component)) {
    throw new Error(
      `Unknown evolution component "${String(value.component)}". Expected one of ${EVOLUTION_COMPONENT_IDS.join(", ")}.`,
    );
  }
  const target: EvolutionTarget = { component: value.component };
  if (value.entry !== undefined) {
    target.entry = requireString(value.entry, "Evolution target.entry");
  }
  if (value.field !== undefined) {
    target.field = requireString(value.field, "Evolution target.field");
  }
  if (value.asset !== undefined) {
    target.asset = validateAssetPath(
      requireString(value.asset, "Evolution target.asset"),
    );
  }
  return target;
}

function requireTextTarget(target: EvolutionTarget) {
  const meta = EVOLUTION_COMPONENT_META[target.component];
  if (!meta.text) {
    throw new Error(
      `Evolution component "${target.component}" does not have patchable text.`,
    );
  }
  if (!target.field && !target.asset) {
    throw new Error(
      `Evolution text operation on "${target.component}" requires target.field or target.asset.`,
    );
  }
  if (target.field && !isFieldAllowed(target.component, target.field)) {
    throw new Error(
      `Field "${target.field}" is not editable on "${target.component}".`,
    );
  }
  if (meta.entries && !target.entry) {
    throw new Error(
      `Evolution text operation on "${target.component}" requires target.entry.`,
    );
  }
}

function requireEntryTarget(target: EvolutionTarget) {
  const meta = EVOLUTION_COMPONENT_META[target.component];
  if (!meta.entries) {
    throw new Error(
      `Evolution component "${target.component}" does not have named entries.`,
    );
  }
  if (!target.entry) {
    throw new Error(
      `Evolution entry operation on "${target.component}" requires target.entry.`,
    );
  }
}

function requireAssetTarget(target: EvolutionTarget) {
  const meta = EVOLUTION_COMPONENT_META[target.component];
  if (!meta.assets) {
    throw new Error(
      `Evolution component "${target.component}" does not own assets.`,
    );
  }
  if (!target.entry) {
    throw new Error(
      `Evolution asset operation on "${target.component}" requires target.entry.`,
    );
  }
  if (target.asset) validateAssetPath(target.asset);
}

function assertAllowedValueFields(
  component: EvolutionComponentId,
  value: Record<string, unknown>,
) {
  for (const field of Object.keys(value)) {
    // `source` selects the representation of a file-backed skill/template. It
    // is only meaningful on entry.upsert; field.set still rejects it because
    // `isFieldAllowed` drives that path.
    const representation =
      field === "source" &&
      (component === "skills" || component === "commands");
    if (!representation && !isFieldAllowed(component, field)) {
      throw new Error(
        `Field "${field}" is not editable on "${component}".`,
      );
    }
  }
}

function validateOperation(raw: unknown): EvolutionOperation {
  const value = requireObject(raw, "Evolution operation");
  const op = value.op;
  if (typeof op !== "string") {
    throw new Error("Evolution operation requires an op.");
  }
  const target = validateTarget(value.target);

  switch (op) {
    case "text.patch": {
      requireTextTarget(target);
      const find = requireString(value.find, "text.patch.find");
      if (typeof value.replace !== "string") {
        throw new Error("text.patch.replace must be a string.");
      }
      const occurrences =
        value.expected_occurrences === undefined
          ? 1
          : Number(value.expected_occurrences);
      if (!Number.isInteger(occurrences) || occurrences < 1) {
        throw new Error("text.patch.expected_occurrences must be a positive integer.");
      }
      return {
        op,
        target,
        find,
        replace: value.replace,
        expected_occurrences: occurrences,
      };
    }
    case "text.append": {
      requireTextTarget(target);
      return {
        op,
        target,
        text: requireString(value.text, "text.append.text"),
      };
    }
    case "text.set": {
      requireTextTarget(target);
      if (typeof value.text !== "string") {
        throw new Error("text.set.text must be a string.");
      }
      return { op, target, text: value.text };
    }
    case "entry.update":
    case "entry.upsert": {
      requireEntryTarget(target);
      const fields = requireObject(value.value, `${op}.value`);
      assertAllowedValueFields(target.component, fields);
      return { op, target, value: fields };
    }
    case "entry.remove": {
      requireEntryTarget(target);
      if (
        target.component === "tools" &&
        PROTECTED_TOOL_NAMES.has(target.entry as string)
      ) {
        throw new Error(
          `Protected tool "${target.entry}" can be disabled but not removed.`,
        );
      }
      return { op, target };
    }
    case "asset.create": {
      requireAssetTarget(target);
      return {
        op,
        target,
        content: requireString(value.content, "asset.create.content"),
      };
    }
    case "asset.remove": {
      requireAssetTarget(target);
      return { op, target };
    }
    case "field.set": {
      if (!target.field) {
        throw new Error("field.set requires target.field.");
      }
      if (!isFieldAllowed(target.component, target.field)) {
        throw new Error(
          `Field "${target.field}" is not editable on "${target.component}".`,
        );
      }
      return { op, target, value: value.value };
    }
    case "component.set": {
      if (target.entry || target.field || target.asset) {
        throw new Error(
          "component.set targets a whole component and may not set entry/field/asset.",
        );
      }
      return {
        op,
        target,
        value: requireObject(value.value, "component.set.value"),
      };
    }
    default:
      throw new Error(`Unknown evolution operation "${op}".`);
  }
}

export function validateEvolutionPatch(patch: unknown): EvolutionPatch {
  const value = requireObject(patch, "EvolutionPatch");
  if (value.schema_version !== EVOLUTION_PATCH_SCHEMA_VERSION) {
    throw new Error(
      `EvolutionPatch.schema_version must be "${EVOLUTION_PATCH_SCHEMA_VERSION}".`,
    );
  }
  if (value.patch_id !== undefined) {
    requireString(value.patch_id, "EvolutionPatch.patch_id");
  }
  const baseGenomeId = requireString(
    value.base_genome_id,
    "EvolutionPatch.base_genome_id",
  );
  if (
    value.base_version !== undefined &&
    (!Number.isInteger(value.base_version) || value.base_version < 1)
  ) {
    throw new Error("EvolutionPatch.base_version must be a positive integer.");
  }
  if (
    value.base_content_hash !== undefined &&
    typeof value.base_content_hash !== "string"
  ) {
    throw new Error("EvolutionPatch.base_content_hash must be a string.");
  }
  const hypothesis = requireString(value.hypothesis, "EvolutionPatch.hypothesis");
  if (!Array.isArray(value.evidence_refs)) {
    throw new Error("EvolutionPatch.evidence_refs must be an array.");
  }
  for (const ref of value.evidence_refs) {
    requireString(ref, "EvolutionPatch.evidence_refs[]");
  }
  if (
    !Array.isArray(value.operations) ||
    value.operations.length < 1 ||
    value.operations.length > 50
  ) {
    throw new Error("EvolutionPatch.operations must contain 1-50 items.");
  }
  if (!Array.isArray(value.risks) || value.risks.length > 20) {
    throw new Error("EvolutionPatch.risks must be an array of at most 20 items.");
  }
  for (const risk of value.risks) {
    requireString(risk, "EvolutionPatch.risks[]");
  }
  const expectedEffect = requireString(
    value.expected_effect,
    "EvolutionPatch.expected_effect",
  );

  return {
    schema_version: EVOLUTION_PATCH_SCHEMA_VERSION,
    patch_id: value.patch_id,
    base_genome_id: baseGenomeId,
    base_version: value.base_version,
    base_content_hash: value.base_content_hash,
    hypothesis,
    evidence_refs: [...value.evidence_refs],
    operations: value.operations.map(validateOperation),
    expected_effect: expectedEffect,
    risks: [...value.risks],
  };
}

/** Operations that replace or delete more than one field/entry. */
export function isWideEvolutionOperation(op: EvolutionOperation): boolean {
  switch (op.op) {
    case "text.set":
    case "component.set":
    case "entry.upsert":
    case "entry.remove":
    case "asset.remove":
      return true;
    case "field.set":
      return EVOLUTION_COMPONENT_META[op.target.component].reviewOnly === true;
    default:
      return false;
  }
}

function targetSchema(required: string[] = ["component"]) {
  return {
    type: "object",
    required,
    additionalProperties: false,
    properties: {
      component: { type: "string", enum: [...EVOLUTION_COMPONENT_IDS] },
      entry: { type: "string", minLength: 1 },
      field: { type: "string", minLength: 1 },
      asset: { type: "string", minLength: 1 },
    },
  };
}

/** JSON Schema for `ModelRuntime.generateStructured`. */
export function createEvolutionPatchSchema() {
  return {
    type: "object",
    required: [
      "schema_version",
      "base_genome_id",
      "hypothesis",
      "evidence_refs",
      "operations",
      "expected_effect",
      "risks",
    ],
    additionalProperties: false,
    properties: {
      schema_version: {
        type: "string",
        enum: [EVOLUTION_PATCH_SCHEMA_VERSION],
      },
      patch_id: { type: "string" },
      base_genome_id: { type: "string", minLength: 1 },
      base_version: { type: "integer", minimum: 1 },
      base_content_hash: { type: "string" },
      hypothesis: { type: "string", minLength: 1 },
      evidence_refs: {
        type: "array",
        items: { type: "string", minLength: 1 },
      },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          oneOf: [
            {
              type: "object",
              required: ["op", "target", "find", "replace"],
              additionalProperties: false,
              properties: {
                op: { type: "string", enum: ["text.patch"] },
                target: targetSchema(),
                find: { type: "string", minLength: 1 },
                replace: { type: "string" },
                expected_occurrences: {
                  type: "integer",
                  minimum: 1,
                  maximum: 1000,
                },
              },
            },
            {
              type: "object",
              required: ["op", "target", "text"],
              additionalProperties: false,
              properties: {
                op: { type: "string", enum: ["text.append", "text.set"] },
                target: targetSchema(),
                text: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["op", "target", "value"],
              additionalProperties: false,
              properties: {
                op: { type: "string", enum: ["entry.update", "entry.upsert"] },
                target: targetSchema(),
                value: { type: "object" },
              },
            },
            {
              type: "object",
              required: ["op", "target"],
              additionalProperties: false,
              properties: {
                op: { type: "string", enum: ["entry.remove", "asset.remove"] },
                target: targetSchema(),
              },
            },
            {
              type: "object",
              required: ["op", "target", "content"],
              additionalProperties: false,
              properties: {
                op: { type: "string", enum: ["asset.create"] },
                target: targetSchema(),
                content: { type: "string", minLength: 1 },
              },
            },
            {
              type: "object",
              required: ["op", "target", "value"],
              additionalProperties: false,
              properties: {
                op: { type: "string", enum: ["field.set", "component.set"] },
                target: targetSchema(),
                value: {},
              },
            },
          ],
        },
      },
      expected_effect: { type: "string", minLength: 1 },
      risks: {
        type: "array",
        maxItems: 20,
        items: { type: "string", minLength: 1 },
      },
    },
  };
}
