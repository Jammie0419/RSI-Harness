import { copyFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Copy the component contracts into every shipped Genome bundle.
 *
 * `docs/genome/components/*.dev.md` is the single source of truth, but a bundle
 * has to carry its own copy: `contract` is a required field on every component
 * and the path is resolved relative to the manifest, so a bundle that points
 * outside itself stops loading the moment it is installed elsewhere.
 *
 * `test/harness-rsi-genome.test.ts` fails when the copies drift, so run this
 * after editing any contract.
 */
const source = resolve("docs", "genome", "components");
const contracts = readdirSync(source).filter((name) => name.endsWith(".dev.md"));
if (contracts.length === 0) {
  throw new Error(`No contracts found in ${source}.`);
}

/**
 * Bundles that carry every contract. The seeds and their examples copies are
 * compared byte-for-byte by the tests, so all of them are synced here.
 */
const completeBundles = [
  resolve("config", "genomes", "paperlab"),
  resolve("config", "genomes", "harness-rsi"),
  resolve("examples", "genomes", "paperlab"),
];
for (const bundle of completeBundles) {
  const target = join(bundle, "contracts");
  for (const name of contracts) {
    copyFileSync(join(source, name), join(target, name));
  }
  console.log(`Synced ${contracts.length} contracts to ${target}`);
}

/**
 * Bundles that ship only the contracts their manifests reference; update what
 * is there rather than adding contracts the bundle does not use.
 */
const partialBundles = [resolve("examples", "genomes", "parallel-search")];
for (const bundle of partialBundles) {
  const target = join(bundle, "contracts");
  let shipped;
  try {
    shipped = readdirSync(target);
  } catch {
    continue;
  }
  let synced = 0;
  for (const name of shipped) {
    if (contracts.includes(name)) {
      copyFileSync(join(source, name), join(target, name));
      synced += 1;
    }
  }
  console.log(`Synced ${synced} referenced contracts to ${target}`);
}
