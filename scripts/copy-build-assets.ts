import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/**
 * Copy the non-TypeScript assets `tsc` leaves behind, so the npm bin entries in
 * package.json (`dist/src/cli.js` and `dist/src/gee/cli.js`) actually run.
 *
 * Both resolve PI_PACKAGE_DIR to `dist/`. Pi then reads `dist/package.json` for
 * its distribution identity (`piConfig`), looks for themes under
 * `<packageDir>/src/modes/interactive/theme` (because `dist/src` exists), hands
 * the model `README.md`, `docs/` and `examples/` as its own paths, and RSIH
 * looks for built-in Genomes under `<packageDir>/genomes`. None of these is a
 * `.ts` file, so none survives compilation on its own.
 *
 * `scripts/build-binary.ts` lays out the same assets for the Bun binary, which
 * uses a different layout (`dist/theme`, `dist/genomes`).
 */
const distDirectory = resolve("dist");

const themeTarget = join(distDirectory, "src", "modes", "interactive", "theme");
mkdirSync(themeTarget, { recursive: true });
cpSync(resolve("src", "modes", "interactive", "theme"), themeTarget, {
  recursive: true,
});
console.log(`Copied themes to ${themeTarget}`);

const genomesTarget = join(distDirectory, "genomes");
// Clear the target first: a plain cpSync would leave a Genome deleted from
// config/genomes haunting every later incremental build.
rmSync(genomesTarget, { recursive: true, force: true });
cpSync(resolve("config", "genomes"), genomesTarget, { recursive: true });
console.log(`Copied built-in Genomes to ${genomesTarget}`);

// Pi's HTML exporter reads its template from `<packageDir>/<src|dist>/core/export-html`,
// which for this layout is `dist/src/core/export-html`. Without it `--export`
// and the `/export` command fail with ENOENT.
const exportTemplateTarget = join(distDirectory, "src", "core", "export-html");
rmSync(exportTemplateTarget, { recursive: true, force: true });
cpSync(
  resolve(
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "core",
    "export-html",
  ),
  exportTemplateTarget,
  { recursive: true },
);
console.log(`Copied Pi's export templates to ${exportTemplateTarget}`);

// Pi reads `piConfig` from the package.json at PI_PACKAGE_DIR to learn which
// distribution it is. Without this copy a compiled `dist/` has no package.json,
// so Pi calls itself `pi`: the version reads 0.0.0 and the config directory
// becomes `~/.pi/agent` instead of `~/.rsih`.
//
// The `version` in this file is also the version Pi reports *about itself*: it
// goes into the User-Agent of every request to pi.dev, and pi.dev serves model
// catalogs only for versions it recognises. A distribution that stamped its own
// version here would answer "pi 0.1.0", be refused, and silently never see
// updated models. So this file describes the Pi that RSIH embeds; RSIH's own
// version lives in `RSIH_VERSION` and in the package root.
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const piVersion = JSON.parse(
  readFileSync(
    resolve("node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    "utf8",
  ),
).version;
const packageJsonTarget = join(distDirectory, "package.json");
writeFileSync(
  packageJsonTarget,
  `${JSON.stringify({ ...packageJson, version: piVersion }, null, 2)}\n`,
  "utf8",
);
console.log(`Copied package.json to ${packageJsonTarget} (pi ${piVersion})`);

// Pi's system prompt hands the model the README, docs and examples paths, and
// its "no models available" guidance sends the user to `docs/providers.md`.
// Those three resolve under PI_PACKAGE_DIR, so `dist/` has to carry them the
// way the binary build ships them next to the executable.
copyFileSync(resolve("README.md"), join(distDirectory, "README.md"));
console.log(`Copied README.md to ${join(distDirectory, "README.md")}`);

for (const asset of ["docs", "examples"]) {
  const target = join(distDirectory, asset);
  rmSync(target, { recursive: true, force: true });
  cpSync(
    resolve("node_modules", "@earendil-works", "pi-coding-agent", asset),
    target,
    { recursive: true },
  );
  console.log(`Copied Pi's ${asset} to ${target}`);
}
