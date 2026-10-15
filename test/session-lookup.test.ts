import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findSessionFile,
  piSessionDirectory,
} from "../src/pi-cli-runtime.ts";
import { PROJECT_CONFIG_DIRECTORY } from "../src/harness/project-ignore.ts";

function withAgentDirectory(agentDirectory, run) {
  const previous = {
    RSIH_CODING_AGENT_DIR: process.env.RSIH_CODING_AGENT_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.RSIH_CODING_AGENT_DIR = agentDirectory;
  // Without PI_PACKAGE_DIR the embedded Pi resolves its own name, so the
  // variable it reads in-process is the `PI_` one; the shipped CLI points both
  // spellings at the same directory.
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  const restore = () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    return run();
  } finally {
    restore();
  }
}

test("the session directory mirrors Pi: flags, env, project settings, then the default", () => {
  const agent = mkdtempSync(join(tmpdir(), "rsih-session-agent-"));
  const project = mkdtempSync(join(tmpdir(), "rsih-session-project-"));
  const bare = mkdtempSync(join(tmpdir(), "rsih-session-bare-"));
  try {
    withAgentDirectory(agent, () => {
      const projectSessions = join(agent, "project-sessions");
      mkdirSync(join(project, PROJECT_CONFIG_DIRECTORY), { recursive: true });
      writeFileSync(
        join(project, PROJECT_CONFIG_DIRECTORY, "settings.json"),
        JSON.stringify({ sessionDir: projectSessions }),
        "utf8",
      );

      // A project's own settings win over the global file, and `~` expands the
      // way Pi's own normalizePath expands it.
      assert.equal(piSessionDirectory(project, []), projectSessions);
      assert.equal(
        piSessionDirectory(project, ["--session-dir", "~/shared-sessions"]),
        join(homedir(), "shared-sessions"),
      );

      // The env variable sits between the flag and the settings file.
      process.env.RSIH_CODING_AGENT_SESSION_DIR = "env-sessions";
      try {
        assert.equal(
          piSessionDirectory(project, []),
          join(project, "env-sessions"),
        );
      } finally {
        delete process.env.RSIH_CODING_AGENT_SESSION_DIR;
      }

      // Without any setting, Pi's per-project default layout.
      const encoded = `--${bare.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
      assert.equal(
        piSessionDirectory(bare, []),
        join(agent, "sessions", encoded),
      );

      // The global file is the fallback when the project has none.
      writeFileSync(
        join(agent, "settings.json"),
        JSON.stringify({ sessionDir: join(agent, "global-sessions") }),
        "utf8",
      );
      assert.equal(
        piSessionDirectory(bare, []),
        join(agent, "global-sessions"),
      );
    });
  } finally {
    rmSync(agent, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("session lookup filters by project and follows --fork", () => {
  const agent = mkdtempSync(join(tmpdir(), "rsih-session-agent-"));
  const project = mkdtempSync(join(tmpdir(), "rsih-session-project-"));
  const other = mkdtempSync(join(tmpdir(), "rsih-session-other-"));
  const shared = join(agent, "shared");
  mkdirSync(shared, { recursive: true });
  try {
    const mine = join(shared, "mine.jsonl");
    const theirs = join(shared, "theirs.jsonl");
    // A torn last line (a session read mid-append) must not hide the header.
    writeFileSync(
      mine,
      `${JSON.stringify({ type: "session", id: "abc-mine", cwd: project })}\n{"torn":`,
      "utf8",
    );
    writeFileSync(
      theirs,
      `${JSON.stringify({ type: "session", id: "abc-theirs", cwd: other })}\n`,
      "utf8",
    );

    withAgentDirectory(agent, () => {
      // `--session-id` opens only this project's session; another project's id
      // is a miss, and Pi creates a fresh session for it.
      assert.equal(
        findSessionFile(["--session-id", "abc-mine"], shared, project),
        mine,
      );
      assert.equal(
        findSessionFile(["--session-id", "abc-theirs"], shared, project),
        undefined,
      );
      // `--session` prefers this project's session before falling back to
      // every project, the way Pi's own lookup does.
      assert.equal(
        findSessionFile(["--session", "abc"], shared, project),
        mine,
      );
      // `--fork` resolves its source session, by id or by path.
      assert.equal(
        findSessionFile(["--fork", "abc-theirs"], shared, project),
        theirs,
      );
      assert.equal(findSessionFile(["--fork", mine], shared, project), mine);
      // `--continue` continues this project's session, not the other one.
      assert.equal(findSessionFile(["--continue"], shared, project), mine);
      // `--resume` picks its session only after Pi starts, and `--no-session`
      // writes nothing: neither can name a stored Genome up front.
      assert.equal(findSessionFile(["--resume"], shared, project), undefined);
      assert.equal(findSessionFile(["--no-session"], shared, project), undefined);
    });
  } finally {
    rmSync(agent, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
