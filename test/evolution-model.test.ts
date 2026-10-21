import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEvolutionModel } from "../src/harness/evolution/model.ts";

function temporary(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "rsih-evolution-model-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("createEvolutionModel resolves a mock profile without a network", (t) => {
  const directory = temporary(t);
  const configPath = join(directory, "providers.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mock: { kind: "mock", model: "mock-model" },
    }),
  );

  const model = createEvolutionModel({ configPath, loadEnv: false });
  assert.equal(model.profileId, "mock");
  assert.equal(model.runtime.getProfile("mock").model, "mock-model");
});

test("createEvolutionModel rejects missing config and unknown profiles", (t) => {
  const directory = temporary(t);
  assert.throws(
    () => createEvolutionModel({ loadEnv: false }),
    /requires a provider profile/,
  );

  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({ mock: { kind: "mock" } }));
  assert.throws(
    () => createEvolutionModel({ configPath, profileId: "missing", loadEnv: false }),
    /Unknown model profile/,
  );
});
