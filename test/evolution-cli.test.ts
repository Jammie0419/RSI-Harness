import assert from "node:assert/strict";
import test from "node:test";
import { runEvolutionCommand } from "../src/cli/evolution-command.ts";
import { runGenomeCommand } from "../src/cli/genome-command.ts";

test("evolution help is available without a base", async () => {
  const lines: string[] = [];
  const handled = await runEvolutionCommand("scan", ["--help"], {
    io: { log: (line: string) => lines.push(String(line)) },
  });
  assert.equal(handled, true);
  assert.match(lines.join("\n"), /scan <base>/);
  assert.match(lines.join("\n"), /--auto/);
});

test("unknown evolution options fail before any work starts", async () => {
  await assert.rejects(
    () =>
      runEvolutionCommand("plan", ["paperlab", "--nope"], {
        io: { log() {} },
      }),
    /Unknown evolution option/,
  );
});

test("genome dispatch reports a missing base for evolution commands", async () => {
  await assert.rejects(
    () =>
      runGenomeCommand(["genome", "scan"], {
        io: { log() {} },
      }),
    /requires a Genome name or path/,
  );
});

test("genome dispatch still reports unknown commands", async () => {
  await assert.rejects(
    () => runGenomeCommand(["genome", "nope"], { io: { log() {} } }),
    /Unknown genome command/,
  );
});
