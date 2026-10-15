#!/usr/bin/env node

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandGenomeShorthand } from "./cli/genome-shorthand.ts";
import { isEntryPoint } from "./cli/entry-point.ts";

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDirectory = process.versions.bun
  ? dirname(process.execPath)
  : projectDirectory;
process.env.PI_PACKAGE_DIR ??= packageDirectory;
// `os.homedir()`, not `process.env.HOME`: cmd.exe and PowerShell set only
// USERPROFILE, and falling back to the package directory would put the config
// directory inside the install rather than in the user's home.
process.env.RSIH_CODING_AGENT_DIR ??= resolve(homedir(), ".rsih");
// RSIH is a standalone distribution, so Pi's upstream self-update check would
// compare the RSIH package version with Pi releases and advertise `rsih update`.
process.env.PI_SKIP_VERSION_CHECK ??= "1";

export async function runCli(argv = process.argv.slice(2)) {
  const { runPiCli } = await import("./pi-cli-runtime.ts");
  return runPiCli(expandGenomeShorthand(argv));
}

/**
 * Interactive runs go through a supervisor so `/switch-genome` can restart the
 * agent on the same session under a different Genome. See `cli/supervisor.ts`
 * for why that needs a process boundary. Everything else runs in-process.
 */
async function runLauncher(argv) {
  const { SUPERVISED_ENV, supervise, wantsInteractive } = await import(
    "./cli/supervisor.ts"
  );
  if (process.env[SUPERVISED_ENV] === "1" || !wantsInteractive(argv)) {
    return runCli(argv);
  }
  // The child is this same entry point. Under Bun the binary is the program;
  // under Node the script (and any loader flags) have to be repeated.
  const baseArgs = process.versions.bun
    ? []
    : [...process.execArgv, resolve(process.argv[1])];
  process.exitCode = await supervise({
    command: process.execPath,
    baseArgs,
    argv,
    agentDirectory: process.env.RSIH_CODING_AGENT_DIR,
  });
}

if (isEntryPoint(import.meta.url)) {
  // Expanded before the supervisor sees argv: a restart rebuilds the child's
  // arguments from the list it was given, so a Genome shorthand left in the
  // middle of that list would reach Pi as a message instead of naming a Genome.
  // `runCli` expands again, which is idempotent once the first argument is
  // already `--genome`.
  runLauncher(expandGenomeShorthand(process.argv.slice(2))).catch((error) => {
    console.error(`rsih: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
