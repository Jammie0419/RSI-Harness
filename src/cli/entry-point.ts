import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Whether the file that called this is the program's entry point.
 *
 * Running the file is not the only way in: `npm link` and `npm install -g .`
 * reach these files through a symlink, and Node reports a module's URL as the
 * resolved path while `argv[1]` keeps the symlink. Comparing the raw strings
 * only would make a linked entry point a silent no-op -- the process starts,
 * does nothing and exits 0 -- so the realpath comparison is what lets a source
 * checkout be put on the PATH.
 *
 * `moduleUrl` is a parameter rather than `import.meta.url` read here, because
 * the comparison has to be against the caller's own file.
 */
export function isEntryPoint(moduleUrl: string, argv = process.argv): boolean {
  const entry = argv[1];
  if (!entry) return false;
  const resolved = resolve(entry);
  if (moduleUrl === pathToFileURL(resolved).href) return true;
  try {
    const self = realpathSync(fileURLToPath(moduleUrl));
    const real = realpathSync(resolved);
    return process.platform === "win32"
      ? real.toLowerCase() === self.toLowerCase()
      : real === self;
  } catch {
    // A Bun binary's module URL is a virtual path with nothing on disk.
    return false;
  }
}
