/**
 * `rsih genome scan|plan|apply|diff|evolve|versions|rollback`.
 *
 * This module is loaded with a dynamic import from `genome-command.ts`, so a
 * normal `rsih` session never loads the evolution subsystem.
 */

import type { EvidenceDigest } from "../harness/evolution/digest.ts";
import type { EvolutionIO, EvolutionRunOptions, ProposalFile } from "../harness/evolution/evolve.ts";
import type { EvolutionVersionList } from "../harness/evolution/versions.ts";

const EVOLUTION_USAGE = `Usage: rsih genome <command>

  scan <base> [options]       Scan evidence and print the digest; writes nothing
  plan <base> [options]       Scan, propose, validate, and save a proposal
  apply <proposal>            Install a saved proposal without calling the model
  diff <base> --to <n>        Compare the active Genome with an archived revision
  diff <base> --proposal <f>  Compare the active Genome with a proposal
  evolve <base> [options]     Scan, propose, review, compile, validate, install
  versions <base>             List archived revisions
  rollback <base> --to <n>    Restore an archived revision under the same name

Options:
  --auto                 Evolve without questions (still shows the flow on a TTY)
  --intent <text>        What this evolution should improve
  --sources <list>       Evidence sources (default: rsih); comma-separated
  --workspaces <list>    Workspace roots to include; subdirectories count
  --since <timestamp>    Override the automatic evidence baseline
  --reset-watermark      Re-read every selected transcript from the start
  --profile <id>         Model profile for planning
  --config <file>        Provider profile file for planning
  --name <name>          Install as a parallel Genome instead of replacing <base>
  --to <version>         Archived revision for diff/rollback
  --json                 Print structured output
`;

const EVOLUTION_COMMANDS = new Set([
  "scan",
  "plan",
  "apply",
  "diff",
  "evolve",
  "versions",
  "rollback",
]);

const VALUE_OPTIONS = new Set([
  "since",
  "workspaces",
  "sources",
  "intent",
  "profile",
  "config",
  "name",
  "to",
  "proposal",
]);

const BOOLEAN_OPTIONS = new Set([
  "auto",
  "json",
  "reset-watermark",
  "help",
  "h",
]);

export interface EvolutionCommandContext {
  cwd?: string;
  homeDirectory?: string;
  agentDirectory?: string;
  packageDirectory?: string;
  io?: EvolutionIO;
  isTTY?: boolean;
}

interface ParsedEvolutionArgs {
  positionals: string[];
  options: Record<string, string | boolean>;
}

function parseEvolutionArgs(args: string[]): ParsedEvolutionArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }
    const withoutDashes = argument.replace(/^--?/, "");
    const equals = withoutDashes.indexOf("=");
    const key = equals < 0 ? withoutDashes : withoutDashes.slice(0, equals);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = equals < 0 ? true : withoutDashes.slice(equals + 1) !== "false";
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) {
      throw new Error(`Unknown evolution option "${argument}".\n\n${EVOLUTION_USAGE}`);
    }
    if (equals >= 0) {
      options[key] = withoutDashes.slice(equals + 1);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`Option "--${key}" requires a value.`);
    }
    options[key] = value;
    index += 1;
  }
  return { positionals, options };
}

function list(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function runOptions(parsed: ParsedEvolutionArgs, context: EvolutionCommandContext): EvolutionRunOptions {
  return {
    cwd: context.cwd,
    homeDirectory: context.homeDirectory,
    agentDirectory: context.agentDirectory,
    packageDirectory: context.packageDirectory,
    sources: list(parsed.options.sources),
    workspaces: list(parsed.options.workspaces),
    since: typeof parsed.options.since === "string" ? parsed.options.since : undefined,
    resetWatermark: parsed.options["reset-watermark"] === true,
    intent: typeof parsed.options.intent === "string" ? parsed.options.intent : undefined,
    configPath: typeof parsed.options.config === "string" ? parsed.options.config : undefined,
    profileId: typeof parsed.options.profile === "string" ? parsed.options.profile : undefined,
    name: typeof parsed.options.name === "string" ? parsed.options.name : undefined,
    auto: parsed.options.auto === true,
    json: parsed.options.json === true,
    io: context.io ?? console,
    isTTY: context.isTTY,
  };
}

function printDigest(
  result: { digest: EvidenceDigest },
  io: EvolutionIO,
  json: boolean,
): void {
  if (json) {
    io.log(JSON.stringify(result.digest, null, 2));
    return;
  }
  const digest = result.digest;
  const summary = digest.signals.strong;
  const weak = digest.signals.weak;
  io.log(`baseline: ${digest.baseline.at} (${digest.baseline.source})`);
  io.log(
    `sessions: ${digest.context.sessions.length} · strong outcomes ${summary.outcomes.ok} ok / ${summary.outcomes.fail} fail / ${summary.outcomes.unknown} unknown`,
  );
  io.log(
    `signals: ${summary.top_signatures.length} signatures · ${summary.corrections.length} corrections · ${summary.failure_retry.length} retries · ${summary.repeated_sequences.length} repeated sequences`,
  );
  io.log(
    `skills: ${
      [...summary.skill_usage, ...weak.skill_usage]
        .map((skill) => `${skill.skill}×${skill.loads}`)
        .join(", ") || "(none)"
    }`,
  );
  io.log(
    `commands: ${weak.command_usage_signal === "observed" ? weak.command_usage.map((command) => `${command.command}×${command.uses}`).join(", ") : "unknown (Pi expands templates before recording)"}`,
  );
  io.log(
    `provenance: ${digest.coverage.provenance.matched_events} matched · ${digest.coverage.provenance.other_genome_events} other genome · ${digest.coverage.provenance.unattributed_events} unattributed · ${digest.coverage.provenance.external_events} external`,
  );
  io.log(
    `coverage: ${digest.coverage.read}/${digest.coverage.files} files · ${digest.coverage.skipped.unchanged} unchanged · ${digest.coverage.skipped.before_since} before baseline`,
  );
  for (const note of digest.coverage.notes) io.log(`note: ${note}`);
  for (const error of digest.coverage.errors) {
    io.log(`error: ${error.session}: ${error.error}`);
  }
}

function printProposal(result: { proposal: ProposalFile; path?: string }, io: EvolutionIO, json: boolean): void {
  if (json) {
    io.log(JSON.stringify({ ...result.proposal, path: result.path }, null, 2));
    return;
  }
  if (result.path) io.log(`proposal: ${result.path}`);
  io.log(`decision: ${result.proposal.decision} — ${result.proposal.reason}`);
  if (result.proposal.weak_only) {
    io.log("warning: weak-only evidence (--auto would reject this).");
  }
  if (result.proposal.changed_components.length > 0) {
    io.log(`components: ${result.proposal.changed_components.join(", ")}`);
  }
  if (result.proposal.diff) {
    io.log("");
    io.log("changes:");
    io.log(result.proposal.diff);
  }
}

function requireBase(parsed: ParsedEvolutionArgs, command: string): string {
  const base = parsed.positionals[0];
  if (!base) throw new Error(`rsih genome ${command} requires a Genome name or path.`);
  return base;
}

function printVersions(
  versions: EvolutionVersionList,
  io: EvolutionIO,
  json: boolean,
): void {
  if (json) {
    io.log(JSON.stringify(versions, null, 2));
    return;
  }
  if (versions.active) {
    io.log(
      `active: v${versions.active.version} ${versions.active.genome_id}${versions.active.changed_components.length ? ` (${versions.active.changed_components.join(", ")})` : ""}`,
    );
  }
  if (versions.versions.length === 0) {
    io.log("no archived versions");
    return;
  }
  for (const version of versions.versions) {
    io.log(
      `v${version.version}  ${version.genome_id}  ${version.created_at ?? "(no timestamp)"}  ${version.changed_components.join(", ")}  ${version.path}`,
    );
  }
}

export async function runEvolutionCommand(
  command: string,
  args: string[],
  context: EvolutionCommandContext = {},
): Promise<boolean> {
  if (!EVOLUTION_COMMANDS.has(command)) return false;
  const io = context.io ?? console;
  const parsed = parseEvolutionArgs(args);
  if (parsed.options.help === true || parsed.options.h === true) {
    io.log(EVOLUTION_USAGE);
    return true;
  }
  const options = runOptions(parsed, context);

  if (command === "scan") {
    const { scanEvolution, digestSummary } = await import("../harness/evolution/evolve.ts");
    const base = requireBase(parsed, command);
    const result = await scanEvolution(base, options);
    if (options.json) {
      io.log(JSON.stringify({ summary: digestSummary(result.digest), digest: result.digest }, null, 2));
    } else {
      io.log(`Genome: ${result.context.base.name}`);
      printDigest(result, io, false);
    }
    return true;
  }

  if (command === "plan") {
    const { planEvolution } = await import("../harness/evolution/evolve.ts");
    const base = requireBase(parsed, command);
    const result = await planEvolution(base, options);
    printProposal(result, io, options.json === true);
    return true;
  }

  if (command === "evolve") {
    const { evolveEvolution } = await import("../harness/evolution/evolve.ts");
    const base = requireBase(parsed, command);
    const result = await evolveEvolution(base, options);
    if (options.json) {
      io.log(JSON.stringify(result, null, 2));
      return true;
    }
    if (result.status === "installed") {
      io.log(
        `Installed ${base} v${result.version} at ${result.activeDirectory}${
          result.archived ? ` (archived v${result.archived.version})` : ""
        }.`,
      );
    } else if (result.status === "proposal") {
      printProposal(result as any, io, false);
      io.log("No TTY and no --auto: wrote a proposal instead of installing it.");
    } else if (result.status === "saved" && result.proposalPath) {
      io.log(`Proposal saved to ${result.proposalPath}.`);
    } else if (result.status === "no_change") {
      io.log(result.proposal?.reason ?? "No change.");
    } else {
      io.log("Evolution cancelled.");
    }
    return true;
  }

  if (command === "apply") {
    const { applyProposalFile } = await import("../harness/evolution/evolve.ts");
    const path = parsed.positionals[0];
    if (!path) throw new Error("rsih genome apply requires a proposal file.");
    const result = applyProposalFile(path, options);
    if (options.json) {
      io.log(JSON.stringify(result, null, 2));
    } else {
      io.log(
        `Installed v${result.version} at ${result.activeDirectory}${
          result.archived ? ` (archived v${result.archived.version})` : ""
        }.`,
      );
    }
    return true;
  }

  if (command === "diff") {
    const { diffEvolution } = await import("../harness/evolution/evolve.ts");
    const base = requireBase(parsed, command);
    const to = parsed.options.to === undefined ? undefined : Number(parsed.options.to);
    if (to !== undefined && (!Number.isInteger(to) || to < 1)) {
      throw new Error("--to must be a positive integer revision.");
    }
    const proposal = typeof parsed.options.proposal === "string" ? parsed.options.proposal : undefined;
    if (to === undefined && !proposal) {
      throw new Error("rsih genome diff requires --to <version> or --proposal <file>.");
    }
    const result = diffEvolution(base, { ...options, to, proposal });
    if (options.json) {
      io.log(JSON.stringify(result, null, 2));
    } else {
      io.log(`${result.from} -> ${result.to}`);
      io.log(result.text);
    }
    return true;
  }

  if (command === "versions") {
    const { versionsEvolution } = await import("../harness/evolution/evolve.ts");
    const base = requireBase(parsed, command);
    printVersions(versionsEvolution(base, options), io, options.json === true);
    return true;
  }

  if (command === "rollback") {
    const { rollbackEvolution } = await import("../harness/evolution/evolve.ts");
    const base = requireBase(parsed, command);
    const to = Number(parsed.options.to);
    if (!Number.isInteger(to) || to < 1) {
      throw new Error("rsih genome rollback requires --to <version>.");
    }
    const result = rollbackEvolution(base, to, options);
    if (options.json) {
      io.log(JSON.stringify(result, null, 2));
    } else {
      io.log(
        `Rolled back ${base} from v${result.fromVersion ?? "?"} to v${result.toVersion} at ${result.activeDirectory}.`,
      );
    }
    return true;
  }

  return false;
}

export { EVOLUTION_COMMANDS, EVOLUTION_USAGE };
