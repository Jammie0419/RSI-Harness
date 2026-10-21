import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const CONTRACTS = [
  "instructions",
  "skills",
  "commands",
  "policies",
  "tools",
  "model",
  "runtime",
  "integrations",
  "appearance",
  "settings",
  "keybindings",
  "resources",
];

/**
 * A small but complete v3 bundle: two file-backed skills, one inline template,
 * and an instructions component. Contracts exist for every core component so
 * the compiler can add a component the base does not declare.
 */
export function createEvolutionBundle(
  directory: string,
  options: { version?: number; genomeId?: string } = {},
): string {
  mkdirSync(join(directory, "components"), { recursive: true });
  mkdirSync(join(directory, "contracts"), { recursive: true });
  mkdirSync(join(directory, "skills", "alpha"), { recursive: true });
  mkdirSync(join(directory, "skills", "beta"), { recursive: true });

  for (const id of CONTRACTS) {
    writeFileSync(join(directory, "contracts", `${id}.dev.md`), `# ${id} contract\n`, "utf8");
  }

  writeJson(join(directory, "genome.json"), {
    genome_schema_version: "3",
    genome_id: options.genomeId ?? "harness:fixture",
    version: options.version ?? 1,
    base: "default",
    components: [
      {
        id: "instructions",
        source: "./components/instructions.json",
        contract: "./contracts/instructions.dev.md",
      },
      {
        id: "skills",
        source: "./components/skills.json",
        contract: "./contracts/skills.dev.md",
      },
      {
        id: "commands",
        source: "./components/commands.json",
        contract: "./contracts/commands.dev.md",
      },
    ],
  });

  writeJson(join(directory, "components", "instructions.json"), {
    component_schema_version: "1",
    component_id: "instructions",
    config: {
      append_system_prompt: "# Base mode\n\nKeep runs reproducible.\n",
    },
  });
  writeJson(join(directory, "components", "skills.json"), {
    component_schema_version: "1",
    component_id: "skills",
    config: {
      skills: [
        { source: "./skills/alpha", enabled: true },
        { source: "./skills/beta", enabled: true },
      ],
    },
  });
  writeJson(join(directory, "components", "commands.json"), {
    component_schema_version: "1",
    component_id: "commands",
    config: {
      prompt_templates: [
        {
          name: "run-status",
          description: "Inspect a run.",
          content: "Inspect the run and report observed facts.",
        },
      ],
    },
  });

  writeFileSync(
    join(directory, "skills", "alpha", "SKILL.md"),
    [
      "---",
      "name: alpha",
      "description: Alpha workflow.",
      "---",
      "",
      "# Alpha",
      "",
      "Alpha workflow",
      "",
      "step one",
      "step two",
      "Keep the rest.",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(directory, "skills", "beta", "SKILL.md"),
    "---\nname: beta\ndescription: Beta workflow.\n---\n\n# Beta\n\nbeta body\n",
    "utf8",
  );
  return directory;
}

/** A valid bundle with no components, for version/archive tests. */
export function writeMinimalBundle(
  directory: string,
  version: number,
  genomeId: string,
): string {
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, "genome.json"), {
    genome_schema_version: "3",
    genome_id: genomeId,
    version,
    parent_id: null,
    base: "default",
    components: [],
  });
  return directory;
}
