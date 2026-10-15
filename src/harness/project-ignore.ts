import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/**
 * The project layer of an RSIH install: the `.rsih` directory next to a
 * project's own files, as opposed to the one under the user's home.
 *
 * Pi owns the name -- it reads `piConfig.configDir` from the package.json RSIH
 * ships -- so the ignore this module writes is always about the directory RSIH
 * and Pi actually share.
 */
export const PROJECT_CONFIG_DIRECTORY = CONFIG_DIR_NAME;

/** Line added to a project's `.gitignore`. */
const IGNORE_LINE = `${PROJECT_CONFIG_DIRECTORY}/`;

/**
 * Spellings that already cover the directory. A trailing-only slash carries no
 * path separators, so git matches the pattern at any depth -- which is what the
 * appended line relies on, and what these are equivalent to.
 */
const COVERING_SPELLINGS = new Set([
  PROJECT_CONFIG_DIRECTORY,
  `${PROJECT_CONFIG_DIRECTORY}/`,
  `/${PROJECT_CONFIG_DIRECTORY}`,
  `/${PROJECT_CONFIG_DIRECTORY}/`,
  `**/${PROJECT_CONFIG_DIRECTORY}/`,
  `**/${PROJECT_CONFIG_DIRECTORY}`,
]);

/** The work tree root above `directory`, or undefined outside a repository. */
function workTreeRoot(directory) {
  let current = resolve(directory);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The work tree root above `directory`, but only when a config directory sits
 * between the two.
 *
 * The search is one walk rather than two because the interesting case is the
 * one in between: a `.rsih` at the repository root, with the run started in a
 * subdirectory. Walking from the run's own directory finds it either way, and
 * stops at the root so nothing outside the repository is ever considered.
 */
function rootWithConfigDirectory(directory) {
  let current = resolve(directory);
  let found = false;
  for (;;) {
    if (existsSync(join(current, PROJECT_CONFIG_DIRECTORY))) found = true;
    // `.git` is a directory in a clone and a file in a worktree or submodule;
    // either one marks the root.
    if (existsSync(join(current, ".git"))) return found ? current : undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Keep a project's `.rsih` out of git, by adding one line to the project's own
 * `.gitignore`.
 *
 * Three gates, because this edits a file someone else tracks:
 *
 * - a `.rsih` must already exist between the run's directory and the work tree
 *   root -- RSIH never creates that directory, so it never creates one just to
 *   ignore it;
 * - the run must happen inside a git work tree -- outside one, ignoring means
 *   nothing;
 * - there must be a `.gitignore` to add the line to. A repository that has none
 *   is left exactly as it is: dropping a new file into someone's project is the
 *   pollution this is meant to prevent.
 *
 * Returns the path it changed, or undefined when there was nothing to do.
 */
export function ensureProjectIgnored(cwd) {
  const root = rootWithConfigDirectory(cwd);
  if (!root) return undefined;

  // The entry goes in the work tree's own `.gitignore`, not each directory's:
  // a run in a subdirectory has to leave the ignore where git will look for it.
  const ignorePath = join(root, ".gitignore");
  if (!existsSync(ignorePath)) return undefined;

  let text;
  try {
    text = readFileSync(ignorePath, "utf8");
  } catch {
    return undefined;
  }
  if (
    text
      .split(/\r?\n/)
      .some((line) => COVERING_SPELLINGS.has(line.trim()))
  ) {
    return undefined;
  }

  // Keep the file's own line endings: a `.gitignore` written on Windows would
  // otherwise gain one odd line and show a noisy diff.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const separator = text === "" || text.endsWith("\n") ? "" : eol;
  try {
    writeFileSync(ignorePath, `${text}${separator}${IGNORE_LINE}${eol}`, "utf8");
    return ignorePath;
  } catch {
    // A read-only checkout is no reason to refuse to start.
    return undefined;
  }
}
