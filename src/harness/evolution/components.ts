/**
 * Evolution's own component map.
 *
 * This is deliberately local. The evolution subsystem must be able to change
 * components without extending the core HarnessPatch vocabulary, so it keeps
 * the target/field knowledge it needs here. A parity test checks that every
 * component the core ships is represented; the core remains the final
 * authority through `loadHarnessGenomeFile` / `validateHarnessGenome`.
 */

export const EVOLUTION_COMPONENT_IDS = [
  "instructions",
  "skills",
  "tools",
  "commands",
  "memory",
  "policies",
  "runtime",
  "integrations",
  "model",
  "appearance",
  "settings",
  "keybindings",
  "resources",
] as const;

export type EvolutionComponentId = (typeof EVOLUTION_COMPONENT_IDS)[number];

export interface EvolutionComponentMeta {
  /** The component is addressed by named entries (skills, tools, ...). */
  entries: boolean;
  /** The component can own files under the bundle (skills/, extension/, ...). */
  assets: boolean;
  /** The component has long text that can be patched with find/replace. */
  text: boolean;
  /** Fields that may be changed one at a time; `*` means the apply step decides. */
  fields: readonly string[] | "*";
  /** Configuration rather than learned behavior: always shown as wide. */
  reviewOnly?: boolean;
  /** Entry names that may not be removed (printed tools). */
  protectedRemoval?: boolean;
}

export const EVOLUTION_COMPONENT_META: Record<
  EvolutionComponentId,
  EvolutionComponentMeta
> = {
  instructions: {
    entries: false,
    assets: false,
    text: true,
    fields: ["system_prompt", "append_system_prompt"],
  },
  skills: {
    entries: true,
    assets: true,
    text: true,
    fields: ["description", "content", "enabled"],
  },
  tools: {
    entries: true,
    assets: false,
    text: false,
    fields: ["enabled", "description", "parameters"],
    protectedRemoval: true,
  },
  commands: {
    entries: true,
    assets: true,
    text: true,
    fields: ["description", "content", "enabled"],
  },
  memory: {
    entries: true,
    assets: false,
    text: true,
    fields: ["kind", "content"],
  },
  policies: {
    entries: false,
    assets: false,
    text: false,
    fields: ["compaction", "tool", "scratchpad", "memory"],
  },
  runtime: {
    entries: false,
    assets: false,
    text: false,
    fields: "*",
    reviewOnly: true,
  },
  integrations: {
    entries: true,
    assets: true,
    text: false,
    fields: "*",
    reviewOnly: true,
  },
  model: {
    entries: false,
    assets: false,
    text: false,
    fields: "*",
    reviewOnly: true,
  },
  appearance: {
    entries: false,
    assets: false,
    text: false,
    fields: "*",
    reviewOnly: true,
  },
  settings: {
    entries: false,
    assets: false,
    text: false,
    fields: "*",
    reviewOnly: true,
  },
  keybindings: {
    entries: false,
    assets: false,
    text: false,
    fields: "*",
    reviewOnly: true,
  },
  resources: {
    entries: false,
    assets: false,
    text: false,
    fields: "*",
    reviewOnly: true,
  },
};

export function isEvolutionComponentId(
  value: unknown,
): value is EvolutionComponentId {
  return (
    typeof value === "string" &&
    (EVOLUTION_COMPONENT_IDS as readonly string[]).includes(value)
  );
}

export function evolutionComponentMeta(
  id: string,
): EvolutionComponentMeta | undefined {
  return isEvolutionComponentId(id)
    ? EVOLUTION_COMPONENT_META[id]
    : undefined;
}

export function isFieldAllowed(
  component: EvolutionComponentId,
  field: string,
): boolean {
  const fields = EVOLUTION_COMPONENT_META[component].fields;
  return fields === "*" || fields.includes(field);
}
