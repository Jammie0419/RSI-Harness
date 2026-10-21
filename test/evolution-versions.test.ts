import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  archiveActiveBundle,
  installEvolutionBundle,
  listEvolutionVersions,
  nextEvolutionVersion,
  rollbackEvolutionVersion,
} from "../src/harness/evolution/versions.ts";
import { writeMinimalBundle } from "./fixtures/evolution-bundle.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rsih-evolution-versions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const options = {
    homeDirectory: home,
    agentDirectory: join(home, ".rsih"),
  };
  return { root, home, options };
}

test("same-name upgrades archive the old revision and keep one visible genome", (t) => {
  const { root, options } = fixture(t);
  const v1 = writeMinimalBundle(join(root, "stage-v1"), 1, "harness:paperlab");
  const first = installEvolutionBundle("paperlab", v1, options);
  assert.equal(first.previousVersion, undefined);
  assert.equal(
    JSON.parse(readFileSync(join(first.activeDirectory, "genome.json"), "utf8")).version,
    1,
  );

  const v2 = writeMinimalBundle(join(root, "stage-v2"), 2, "harness:paperlab-v2");
  const second = installEvolutionBundle("paperlab", v2, options);
  assert.equal(second.previousVersion, 1);
  assert.equal(second.archived?.version, 1);

  const listed = listEvolutionVersions("paperlab", options);
  assert.equal(listed.active?.version, 2);
  assert.deepEqual(listed.versions.map((item) => item.version), [1]);
  assert.deepEqual(
    readdirSync(join(options.homeDirectory, ".rsih", "genomes")),
    ["paperlab"],
    "the active name must not gain a -v2 suffix",
  );
  assert.equal(
    JSON.parse(readFileSync(join(second.activeDirectory, "genome.json"), "utf8")).genome_id,
    "harness:paperlab-v2",
  );
});

test("rollback archives the current revision and restores the old bundle", (t) => {
  const { root, options } = fixture(t);
  installEvolutionBundle(
    "paperlab",
    writeMinimalBundle(join(root, "stage-v1"), 1, "harness:one"),
    options,
  );
  installEvolutionBundle(
    "paperlab",
    writeMinimalBundle(join(root, "stage-v2"), 2, "harness:two"),
    options,
  );

  const rollback = rollbackEvolutionVersion("paperlab", 1, options);
  assert.equal(rollback.fromVersion, 2);
  assert.equal(rollback.toVersion, 1);
  assert.equal(rollback.archivedCurrent?.version, 2);
  assert.equal(
    JSON.parse(readFileSync(join(rollback.activeDirectory, "genome.json"), "utf8")).genome_id,
    "harness:one",
  );

  const listed = listEvolutionVersions("paperlab", options);
  assert.equal(listed.active?.version, 1);
  assert.deepEqual(listed.versions.map((item) => item.version), [1, 2]);
  assert.ok(existsSync(join(listed.versions[0].path, "genome.json")));
  assert.ok(existsSync(join(listed.versions[1].path, "genome.json")));

  // The next evolution must not collide with the revision that is still in the
  // archive after rolling back.
  assert.equal(nextEvolutionVersion("paperlab", options), 3);
});

test("archiving the same revision with different bytes is refused", (t) => {
  const { root, options } = fixture(t);
  installEvolutionBundle(
    "paperlab",
    writeMinimalBundle(join(root, "stage-v1"), 1, "harness:one"),
    options,
  );

  const active = join(options.homeDirectory, ".rsih", "genomes", "paperlab");
  archiveActiveBundle("paperlab", options);
  const manifest = JSON.parse(readFileSync(join(active, "genome.json"), "utf8"));
  manifest.genome_id = "harness:hand-edited";
  writeFileSync(
    join(active, "genome.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  assert.throws(
    () => archiveActiveBundle("paperlab", options),
    /already archived with different content/,
  );
});

test("rollback refuses an unknown revision", (t) => {
  const { root, options } = fixture(t);
  installEvolutionBundle(
    "paperlab",
    writeMinimalBundle(join(root, "stage-v1"), 1, "harness:one"),
    options,
  );
  assert.throws(
    () => rollbackEvolutionVersion("paperlab", 9, options),
    /No archived version 9/,
  );
});
