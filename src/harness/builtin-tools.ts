import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The shell a generated tool starts in.
 *
 * A Genome declares POSIX sh -- `/bin/sh`, or the shorter `sh` -- which every
 * POSIX system has. Windows has no `/bin/sh`, so both spellings resolve through
 * PATH there, where Git Bash supplies one: a Genome written on Linux runs
 * unchanged, and a host without any sh fails at spawn rather than running the
 * script under the wrong interpreter (validation admits nothing but these two
 * spellings).
 */
export function generatedToolShell(entrypoint = "/bin/sh") {
  return process.platform === "win32" ? "sh" : entrypoint;
}

/**
 * Genome `generated_tools` run as sandboxed POSIX sh scripts. Pi owns every
 * built-in tool (read, ls, grep, find, write, edit, bash, powershell); RSIH
 * never reimplements them.
 */
export function createGeneratedTools({ cwd, genome }) {
  return (genome.generated_tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(args, { signal } = {}) {
      const result = await execFileAsync(
        generatedToolShell(tool.container_script.entrypoint),
        ["-c", tool.container_script.script],
        {
          cwd,
          env: {
            ...process.env,
            HARNESS_TOOL_ARGS: JSON.stringify(args),
          },
          timeout: tool.timeout_ms ?? 60000,
          maxBuffer: tool.max_output_chars ?? 20000,
          signal,
        },
      );
      return [result.stdout, result.stderr].filter(Boolean).join("\n");
    },
  }));
}
