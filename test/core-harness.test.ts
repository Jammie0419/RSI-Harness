import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyHarnessPatch,
  canonicalJson,
  componentOperations,
  createArtifact,
  createDefaultHarnessGenome,
  createGeneratedTools,
  createHarnessGenome,
  createHarnessPatchSchema,
  ensureProjectIgnored,
  FileArtifactStore,
  loadHarnessGenomeFile,
  mergeHarnessGenomeOverrides,
  PROJECT_CONFIG_DIRECTORY,
  renderHarnessSystemPrompt,
  validateHarnessGenome,
  validateHarnessPatch,
  validateJsonSchema,
} from "../src/index.ts";
import { createMcpTools } from "../src/harness/mcp.ts";

test("Genome bundle composes contracted components", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsih-genome-bundle-"));
  const basePath = join(directory, "base.json");
  const contractPath = join(directory, "instructions.dev.md");
  const manifestPath = join(directory, "coding.json");
  await writeFile(
    basePath,
    JSON.stringify(
      createHarnessGenome({
        genome_id: "harness:base",
        system_prompt: "Base instructions.",
      }),
    ),
    "utf8",
  );
  await writeFile(contractPath, "# instructions\nAllowed: set_system_prompt\n", "utf8");
  await writeFile(
    manifestPath,
    JSON.stringify({
      genome_schema_version: "3",
      genome_id: "harness:bundle-test",
      base: "./base.json",
      components: [
        {
          id: "instructions",
          contract: "./instructions.dev.md",
          config: {
            system_prompt: "Bundle instructions.",
          },
        },
        {
          id: "runtime",
          contract: "./instructions.dev.md",
          config: {
            runtime: {
              max_turns: 12,
              thinking_level: "high",
            },
          },
        },
      ],
      overrides: {
        runtime: { max_turns: 7 },
      },
    }),
    "utf8",
  );

  const loaded = loadHarnessGenomeFile(manifestPath);
  assert.equal(loaded.genome.genome_id, "harness:bundle-test");
  assert.equal(loaded.genome.system_prompt, "Bundle instructions.");
  assert.equal(loaded.genome.runtime.max_turns, 7);
  assert.equal(loaded.components.length, 2);
  assert.match(loaded.components[0].documentation, /Allowed/);
});

test("Genome bundle rejects component operations outside its contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsih-genome-operations-"));
  const manifestPath = join(directory, "invalid.json");
  const contractPath = join(directory, "instructions.dev.md");
  await writeFile(contractPath, "# instructions\n", "utf8");
  await writeFile(
    manifestPath,
    JSON.stringify({
      genome_schema_version: "3",
      genome_id: "harness:invalid-operations",
      components: [
        {
          id: "instructions",
          contract: "./instructions.dev.md",
          allowed_operations: ["set_model"],
          config: { system_prompt: "must be rejected" },
        },
      ],
    }),
    "utf8",
  );

  assert.throws(
    () => loadHarnessGenomeFile(manifestPath),
    /has invalid allowed_operations/,
  );
});

test("a component-scoped patch schema only offers that component's operations", () => {
  const schema = createHarnessPatchSchema(componentOperations("instructions"));
  assert.deepEqual(schema.properties.operations.items.properties.op.enum, [
    "set_system_prompt",
    "append_system_prompt",
  ]);
});

test("an allowed patch operation applies to the Genome", () => {
  const candidate = applyHarnessPatch(createHarnessGenome(), {
    hypothesis: "Improve instructions.",
    expected_effect: "Clearer coding behavior.",
    risks: [],
    operations: [{ op: "set_system_prompt", value: "Improved instructions." }],
  });
  assert.equal(candidate.system_prompt, "Improved instructions.");
});

test("a patch operation outside the selected component is rejected", () => {
  assert.throws(
    () =>
      validateHarnessPatch(
        {
          hypothesis: "Change the model.",
          expected_effect: "Use a different model.",
          risks: [],
          operations: [{ op: "set_model", value: { profile: "local" } }],
        },
        { allowedOperations: componentOperations("instructions") },
      ),
    /is not allowed for this task/,
  );
});

test("Genome bundle rejects cross-component fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsih-genome-contract-"));
  const contractPath = join(directory, "tools.dev.md");
  const manifestPath = join(directory, "invalid.json");
  await writeFile(contractPath, "# tools\n", "utf8");
  await writeFile(
    manifestPath,
    JSON.stringify({
      genome_schema_version: "3",
      genome_id: "harness:invalid-bundle",
      components: [
        {
          id: "tools",
          contract: "./tools.dev.md",
          config: { system_prompt: "must be rejected" },
        },
      ],
    }),
    "utf8",
  );

  assert.throws(
    () => loadHarnessGenomeFile(manifestPath),
    /cannot configure "system_prompt"/,
  );
});

test("Genome patches every public Harness configuration surface", () => {
  const parent = createHarnessGenome();
  const candidate = applyHarnessPatch(parent, {
    hypothesis: "Exercise configurable surfaces.",
    expected_effect: "The candidate carries all requested settings.",
    risks: [],
    operations: [
      {
        op: "set_system_prompt",
        value: "Configured system prompt.",
      },
      {
        op: "append_system_prompt",
        value: "Configured suffix.",
      },
      {
        op: "upsert_tool",
        name: "external",
        value: {
          enabled: false,
          description: "Injected by the host.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
      {
        op: "set_tool_enabled",
        name: "external",
        value: false,
      },
      {
        op: "upsert_skill",
        name: "inspect",
        value: {
          description: "Inspect carefully.",
          content: "Read callers before editing.",
        },
      },
      {
        op: "upsert_prompt_template",
        name: "review",
        value: { content: "Review $1" },
      },
      {
        op: "upsert_generated_tool",
        name: "echo",
        value: {
          description: "Echo arguments.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          container_script: {
            entrypoint: "/bin/sh",
            script: `printf '%s' "$HARNESS_TOOL_ARGS"`,
          },
        },
      },
      {
        op: "set_compaction_policy",
        value: {
          enabled: true,
          reserveTokens: 20000,
          keepRecentTokens: 8000,
        },
      },
      {
        op: "set_tool_policy",
        value: {
          blocked_tools: ["external"],
          max_result_chars: 1000,
        },
      },
      {
        op: "set_scratchpad_policy",
        value: {
          enabled: true,
          max_entries: 8,
          max_value_chars: 500,
        },
      },
      {
        op: "set_memory_policy",
        value: { retrieve: true, top_k: 1 },
      },
      {
        op: "set_memory_entries",
        value: [{ kind: "knowledge", content: "Prefer small diffs." }],
      },
      {
        op: "set_runtime_policy",
        value: {
          tool_execution: "parallel",
          steering_mode: "all",
          follow_up_mode: "all",
          max_turns: 12,
          thinking_level: "medium",
        },
      },
      {
        op: "set_mcp_servers",
        value: [{ name: "optional", enabled: false }],
      },
      {
        op: "set_extensions",
        value: [{ source: "./extensions/example.ts", enabled: false }],
      },
      {
        op: "set_model",
        value: { profile: "local", id: "configured-model" },
      },
      {
        op: "set_model_options",
        value: {
          max_tokens: 1024,
          temperature: 0,
          chat_template_kwargs: { enable_thinking: true },
        },
      },
      {
        op: "set_appearance",
        value: {
          themes: ["./theme.json"],
          no_themes: true,
          theme: "dark",
        },
      },
      {
        op: "set_settings",
        value: {
          compaction: { reserveTokens: 30000 },
          treeFilterMode: "no-tools",
        },
      },
      {
        op: "set_keybindings",
        value: {
          "app.session.tree": ["ctrl+t"],
        },
      },
    ],
  });

  assert.equal(candidate.system_prompt, "Configured system prompt.");
  assert.equal(candidate.append_system_prompt, "Configured suffix.");
  assert.equal(candidate.tools.find((tool) => tool.name === "external").enabled, false);
  assert.equal(candidate.skills[0].name, "inspect");
  assert.equal(candidate.prompt_templates[0].content, "Review $1");
  assert.equal(candidate.generated_tools[0].name, "echo");
  assert.equal(candidate.policies.compaction.reserveTokens, 20000);
  assert.equal(candidate.settings.treeFilterMode, "no-tools");
  assert.deepEqual(candidate.keybindings["app.session.tree"], ["ctrl+t"]);
  assert.equal(candidate.appearance.theme, "dark");
  assert.deepEqual(candidate.policies.tool.blocked_tools, ["external"]);
  assert.equal(candidate.policies.scratchpad.enabled, true);
  assert.equal(candidate.memory.policy.retrieve, true);
  assert.equal(candidate.memory.snapshot.entries[0].content, "Prefer small diffs.");
  assert.equal(candidate.runtime.tool_execution, "parallel");
  assert.equal(candidate.mcp.servers[0].enabled, false);
  assert.equal(candidate.extensions[0].enabled, false);
  assert.equal(candidate.model.profile, "local");
  assert.equal(candidate.model.id, "configured-model");
  assert.equal(candidate.model_options.max_tokens, 1024);
  assert.deepEqual(candidate.appearance.themes, ["./theme.json"]);
  assert.equal(candidate.appearance.no_themes, true);
});

test("Genome fields are inherit-by-default", () => {
  const base = createHarnessGenome({
    genome_id: "harness:inherit-base",
    system_prompt: "Base prompt.",
    tools: [{ name: "bash", enabled: false }],
    runtime: { max_turns: 40, thinking_level: "high" },
  });

  // A component that only touches the model must not reset anything else.
  const modelOnly = mergeHarnessGenomeOverrides(base, {
    model: { profile: "openai", id: "gpt-5" },
  });
  assert.equal(modelOnly.system_prompt, "Base prompt.");
  assert.deepEqual(modelOnly.tools, [{ name: "bash", enabled: false }]);
  assert.equal(modelOnly.runtime.max_turns, 40);
  assert.equal(modelOnly.runtime.thinking_level, "high");

  // Nested objects merge instead of replacing wholesale.
  const partialRuntime = mergeHarnessGenomeOverrides(base, {
    runtime: { max_turns: 5 },
  });
  assert.equal(partialRuntime.runtime.max_turns, 5);
  assert.equal(partialRuntime.runtime.thinking_level, "high");

  // `null` is the explicit "hand this back to Pi" escape hatch.
  const reset = mergeHarnessGenomeOverrides(base, {
    system_prompt: null,
    tools: null,
  });
  assert.equal("system_prompt" in reset, false);
  assert.equal("tools" in reset, false);
  assert.equal(validateHarnessGenome(reset), reset);
});

test("the default Genome overrides nothing", () => {
  const genome = createDefaultHarnessGenome();
  assert.deepEqual(genome, {
    genome_schema_version: "2",
    genome_id: "harness:default-v0",
    parent_id: null,
    version: 1,
  });
  assert.equal(renderHarnessSystemPrompt(genome), "");
});

test("the system prompt only advertises load_skill for inline skills", () => {
  const rendered = renderHarnessSystemPrompt(
    createHarnessGenome({
      genome_id: "harness:skill-listing",
      skills: [
        { source: "./skills/review" },
        { name: "debugging", description: "Reproduce first.", content: "..." },
      ],
    }),
  );
  assert.match(rendered, /- debugging: Reproduce first\./);
  assert.doesNotMatch(rendered, /undefined/);
  assert.doesNotMatch(rendered, /review/);
});

test("Genome generated tools run as sandboxed scripts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsih-generated-tool-"));
  const genome = createHarnessGenome({
    genome_id: "harness:generated-tool-test",
    tools: [{ name: "echo_args", enabled: true }],
    generated_tools: [
      {
        name: "echo_args",
        description: "Echo the JSON tool arguments.",
        parameters: {
          type: "object",
          required: ["value"],
          additionalProperties: false,
          properties: { value: { type: "string" } },
        },
        container_script: {
          entrypoint: "/bin/sh",
          script: `printf '%s' "$HARNESS_TOOL_ARGS"`,
        },
      },
    ],
  });

  const [tool] = createGeneratedTools({ cwd: directory, genome });
  assert.equal(tool.name, "echo_args");
  assert.equal(await tool.execute({ value: "hello" }), '{"value":"hello"}');
});

test("Genome MCP servers expose real stdio tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsih-mcp-tool-"));
  const serverPath = join(directory, "echo-server.ts");
  const url = (path) => new URL(path, import.meta.url).href;
  await writeFile(
    serverPath,
    [
      `import { Server } from ${JSON.stringify(url("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js"))};`,
      `import { StdioServerTransport } from ${JSON.stringify(url("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"))};`,
      `import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(url("../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js"))};`,
      `const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });`,
      `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo arguments.", inputSchema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "string" } } } }] }));`,
      `server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: JSON.stringify(request.params.arguments) }] }));`,
      `await server.connect(new StdioServerTransport());`,
    ].join("\n"),
    "utf8",
  );

  const mcp = await createMcpTools({
    cwd: directory,
    genome: createHarnessGenome({
      genome_id: "harness:mcp-tool-test",
      mcp: {
        servers: [
          {
            name: "local",
            command: process.execPath,
            args: ["--experimental-strip-types", serverPath],
            tools: [{ name: "echo" }],
          },
        ],
      },
    }),
  });

  try {
    const [tool] = mcp.tools;
    assert.equal(tool.name, "local_echo");
    assert.equal(await tool.execute({ value: "hello" }), '{"value":"hello"}');
  } finally {
    await mcp.close();
  }
});

test("an MCP server that fails is isolated and reported, not fatal", async () => {
  // A Genome can name servers this machine cannot start, and one dead server
  // must not take the rest of the tools down with it: the healthy tools stay,
  // and the failures come back as `errors` data for the session to show.
  const directory = await mkdtemp(join(tmpdir(), "rsih-mcp-isolation-"));
  const goodPath = join(directory, "echo-server.ts");
  const boomPath = join(directory, "boom-server.ts");
  const url = (path) => new URL(path, import.meta.url).href;
  const serverSource = (handlers) => [
    `import { Server } from ${JSON.stringify(url("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js"))};`,
    `import { StdioServerTransport } from ${JSON.stringify(url("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"))};`,
    `import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(url("../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js"))};`,
    `const server = new Server({ name: "probe", version: "1.0.0" }, { capabilities: { tools: {} } });`,
    ...handlers,
    `await server.connect(new StdioServerTransport());`,
  ].join("\n");
  await writeFile(
    goodPath,
    serverSource([
      `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo.", inputSchema: { type: "object", properties: {} } }] }));`,
      `server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: JSON.stringify(request.params.arguments) }] }));`,
    ]),
    "utf8",
  );
  // Connects successfully, then fails the first request: the failing server's
  // client has to be closed again on the way out.
  await writeFile(
    boomPath,
    serverSource([
      `server.setRequestHandler(ListToolsRequestSchema, async () => { throw new Error("probe: listTools exploded"); });`,
      `server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));`,
    ]),
    "utf8",
  );

  const mcp = await createMcpTools({
    cwd: directory,
    genome: createHarnessGenome({
      genome_id: "harness:mcp-isolation",
      mcp: {
        servers: [
          {
            name: "good",
            command: process.execPath,
            args: ["--experimental-strip-types", goodPath],
          },
          { name: "missing", command: "definitely-not-a-command", args: [] },
          {
            name: "boom",
            command: process.execPath,
            args: ["--experimental-strip-types", boomPath],
          },
        ],
      },
    }),
  });

  try {
    assert.deepEqual(
      mcp.tools.map((tool) => tool.name),
      ["good_echo"],
    );
    assert.equal(mcp.errors.length, 2);
    assert.match(mcp.errors[0], /^missing: /);
    assert.match(mcp.errors[1], /^boom: /);
    assert.equal(await mcp.tools[0].execute({ value: "hello" }), '{"value":"hello"}');
  } finally {
    await mcp.close();
  }

  // With nothing healthy left the call still resolves: the failure is data,
  // not an exception thrown through Pi's extension startup.
  const broken = await createMcpTools({
    cwd: directory,
    genome: createHarnessGenome({
      genome_id: "harness:mcp-isolation-empty",
      mcp: {
        servers: [
          { name: "missing", command: "definitely-not-a-command", args: [] },
          {
            name: "boom",
            command: process.execPath,
            args: ["--experimental-strip-types", boomPath],
          },
        ],
      },
    }),
  });
  try {
    assert.equal(broken.tools.length, 0);
    assert.equal(broken.errors.length, 2);
  } finally {
    await broken.close();
  }
});

test("a project's RSIH directory is added to that project's ignore rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "rsih-project-ignore-"));
  const project = join(root, "project");
  const nested = join(project, "src", "deep");
  await mkdir(join(project, PROJECT_CONFIG_DIRECTORY), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(project, ".gitignore"), "node_modules/\n", "utf8");
  const ignorePath = join(project, ".gitignore");
  const read = () => readFile(ignorePath, "utf8");

  // Outside a repository there is nothing to keep out of git, even with a
  // `.gitignore` sitting in the directory.
  assert.equal(ensureProjectIgnored(project), undefined);
  assert.equal(await read(), "node_modules/\n");

  await mkdir(join(project, ".git"), { recursive: true });
  // A run in a subdirectory has to leave the entry at the work tree root, which
  // is the `.gitignore` git reads for the whole repository.
  assert.equal(ensureProjectIgnored(nested), ignorePath);
  assert.equal(await read(), `node_modules/\n${PROJECT_CONFIG_DIRECTORY}/\n`);

  // Idempotent: nothing left to say on the next run.
  assert.equal(ensureProjectIgnored(project), undefined);
  assert.equal(await read(), `node_modules/\n${PROJECT_CONFIG_DIRECTORY}/\n`);

  // A repository whose project layer was never created is left alone: RSIH does
  // not make a directory just to ignore it.
  const untouched = join(root, "untouched");
  await mkdir(join(untouched, ".git"), { recursive: true });
  await writeFile(join(untouched, ".gitignore"), "dist/\n", "utf8");
  assert.equal(ensureProjectIgnored(untouched), undefined);
  assert.equal(await readFile(join(untouched, ".gitignore"), "utf8"), "dist/\n");
});

test("the project ignore respects what the repository already has", async () => {
  const root = await mkdtemp(join(tmpdir(), "rsih-project-ignore-"));
  const read = (directory) => readFile(join(directory, ".gitignore"), "utf8");
  const prepare = async (name, { git = "dir", gitignore } = {}) => {
    const directory = join(root, name);
    await mkdir(join(directory, PROJECT_CONFIG_DIRECTORY), { recursive: true });
    if (git === "dir") {
      await mkdir(join(directory, ".git"), { recursive: true });
    } else if (git === "file") {
      // A worktree or submodule marks its root with a file, not a directory.
      await writeFile(join(directory, ".git"), "gitdir: ../elsewhere\n", "utf8");
    }
    if (gitignore !== undefined) {
      await writeFile(join(directory, ".gitignore"), gitignore, "utf8");
    }
    return directory;
  };

  // A leading slash anchors a pattern to the work tree root in git, so it does
  // not cover a config directory in a subdirectory: the entry has to be added.
  const anchored = await prepare("anchored", {
    gitignore: `/${PROJECT_CONFIG_DIRECTORY}/\n`,
  });
  assert.equal(ensureProjectIgnored(anchored), join(anchored, ".gitignore"));
  assert.equal(
    await read(anchored),
    `/${PROJECT_CONFIG_DIRECTORY}/\n${PROJECT_CONFIG_DIRECTORY}/\n`,
  );

  // A spelling that does cover every depth is left untouched.
  const covered = await prepare("covered", {
    gitignore: `**/${PROJECT_CONFIG_DIRECTORY}/\n`,
  });
  assert.equal(ensureProjectIgnored(covered), undefined);
  assert.equal(await read(covered), `**/${PROJECT_CONFIG_DIRECTORY}/\n`);

  // No `.gitignore`: RSIH does not create one. Dropping a new file into
  // someone's project is the pollution this is meant to prevent.
  const bare = await prepare("bare");
  assert.equal(ensureProjectIgnored(bare), undefined);
  assert.equal(existsSync(join(bare, ".gitignore")), false);

  // `.git` as a file is still a repository.
  const worktree = await prepare("worktree", { git: "file", gitignore: "dist/\n" });
  assert.equal(ensureProjectIgnored(worktree), join(worktree, ".gitignore"));
  assert.equal(await read(worktree), `dist/\n${PROJECT_CONFIG_DIRECTORY}/\n`);

  // The edited file keeps its own line endings.
  const windows = await prepare("windows", { gitignore: "node_modules/\r\n" });
  assert.equal(ensureProjectIgnored(windows), join(windows, ".gitignore"));
  assert.equal(
    await read(windows),
    `node_modules/\r\n${PROJECT_CONFIG_DIRECTORY}/\r\n`,
  );

  // A file without a trailing newline gains a line, not a joined one.
  const unterminated = await prepare("unterminated", { gitignore: "dist/" });
  assert.equal(ensureProjectIgnored(unterminated), join(unterminated, ".gitignore"));
  assert.equal(
    await read(unterminated),
    `dist/\n${PROJECT_CONFIG_DIRECTORY}/\n`,
  );
});

test("a generated tool cannot take a name Pi or RSIH already implements", () => {
  // The list spelled the directory tool `list` and missed `find` and
  // `powershell`, so a generated tool of one of those names would have replaced
  // Pi's own implementation instead of extending it.
  for (const name of ["ls", "find", "powershell", "read", "bash", "scratchpad"]) {
    assert.throws(
      () =>
        createHarnessGenome({
          genome_id: "harness:shadowing-tool",
          generated_tools: [
            {
              name,
              description: "Take over a tool that already exists.",
              parameters: { type: "object", properties: {} },
              container_script: { script: "echo shadowed" },
            },
          ],
        }),
      /protected tool/,
      name,
    );
  }
});

test("the thinking ladder accepts Pi's highest level", () => {
  assert.equal(
    createHarnessGenome({
      genome_id: "harness:thinking",
      runtime: { thinking_level: "max" },
    }).runtime.thinking_level,
    "max",
  );
  assert.throws(
    () =>
      createHarnessGenome({
        genome_id: "harness:thinking",
        runtime: { thinking_level: "ultra" },
      }),
    /thinking_level is invalid/,
  );
});

test("canonical hashing accepts JSON only", () => {
  // A Date used to canonicalize to `{}`, NaN to `null` and `undefined` in an
  // array to `null`, so two different payloads hashed alike and overwrote each
  // other in the artifact store.
  assert.throws(() => canonicalJson({ at: new Date(0) }), /JSON values only/);
  assert.throws(() => canonicalJson({ value: NaN }), /JSON values only/);
  assert.throws(() => canonicalJson([undefined]), /JSON values only/);
  assert.equal(
    canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] }),
    '{"a":[{"x":1,"y":2}],"b":1}',
  );
});

test("an artifact stays inside its store", async () => {
  const root = await mkdtemp(join(tmpdir(), "rsih-artifact-"));
  // The type reaches the file name, so it must not be able to leave the root.
  const artifact = createArtifact("../escaped", { ok: true });
  const store = new FileArtifactStore(join(root, "store"));
  await store.put(artifact);

  assert.deepEqual(await readdirSync(join(root, "store")), [
    `${artifact.artifact_id
      .replaceAll(":", "__")
      .replace(/[^A-Za-z0-9._-]+/g, "_")}.json`,
  ]);
  assert.deepEqual(readdirSync(root), ["store"]);
  assert.deepEqual((await store.get(artifact.artifact_id)).payload, { ok: true });
});

test("the components that own nested objects must be objects", () => {
  // A string or an array here used to pass validation and then either throw a
  // bare TypeError from inside a patch, or lose the written values on the next
  // serialization.
  for (const bad of ["oops", [], 5]) {
    assert.throws(
      () => createHarnessGenome({ genome_id: "harness:containers", policies: bad }),
      /policies must be an object/,
    );
  }
  assert.throws(
    () => createHarnessGenome({ genome_id: "harness:containers", runtime: [] }),
    /runtime must be an object/,
  );
});

test("a file-backed skill is addressed by the name Pi gives it", () => {
  // `./skills/genome-authoring` is the skill `genome-authoring`. Matching on the
  // `name` field alone made `remove_skill` a silent no-op and let `upsert_skill`
  // append a second copy under a name the first one already had.
  const genome = createHarnessGenome({
    genome_id: "harness:file-backed",
    skills: [{ source: "./skills/genome-authoring" }],
    prompt_templates: ["./prompts/review.md"],
  });

  const removed = applyHarnessPatch(genome, {
    hypothesis: "h",
    expected_effect: "e",
    risks: [],
    operations: [{ op: "remove_skill", name: "genome-authoring" }],
  });
  assert.deepEqual(removed.skills, []);

  const upserted = applyHarnessPatch(genome, {
    hypothesis: "h",
    expected_effect: "e",
    risks: [],
    operations: [
      {
        op: "upsert_skill",
        name: "genome-authoring",
        value: { description: "d", content: "c" },
      },
    ],
  });
  assert.deepEqual(
    upserted.skills.map((skill) => skill.name),
    ["genome-authoring"],
  );

  assert.throws(
    () =>
      createHarnessGenome({
        genome_id: "harness:file-backed",
        skills: [
          { source: "./skills/genome-authoring" },
          { name: "genome-authoring", description: "d", content: "c" },
        ],
      }),
    /Duplicate Harness Skill/,
  );
});

test("a flat Genome reads a top-level null as inherit", async () => {
  // A bundle documents `null` as "hand this back to the base"; the single-file
  // form used to reject it in some fields and keep the null in others.
  const directory = await mkdtemp(join(tmpdir(), "rsih-flat-genome-"));
  const path = join(directory, "flat.json");
  await writeFile(
    path,
    JSON.stringify({
      genome_schema_version: "2",
      genome_id: "harness:flat",
      parent_id: null,
      version: 1,
      system_prompt: null,
      settings: null,
      runtime: { thinking_level: "max" },
    }),
    "utf8",
  );

  const loaded = loadHarnessGenomeFile(path).genome;
  assert.equal("system_prompt" in loaded, false);
  assert.equal("settings" in loaded, false);
  assert.equal(loaded.runtime.thinking_level, "max");
});

test("the tool schema gate honours the standard keywords", () => {
  // This gate rejects a tool call that leaves its Genome contract, so every
  // keyword it ignores is narrowing a Genome believes it wrote.
  assert.deepEqual(validateJsonSchema(null, { type: ["string", "null"] }), []);
  assert.equal(validateJsonSchema(1, { type: ["string", "null"] }).length, 1);
  assert.equal(
    validateJsonSchema("zzz", { oneOf: [{ const: "a" }, { const: "b" }] }).length,
    1,
  );
  assert.equal(
    validateJsonSchema("a", { oneOf: [{ const: "a" }, { const: "b" }] }).length,
    0,
  );
  assert.equal(
    validateJsonSchema(false, { anyOf: [{ type: "string" }, { type: "number" }] })
      .length,
    1,
  );
  assert.equal(
    validateJsonSchema(5, { allOf: [{ type: "number" }, { minimum: 10 }] }).length,
    1,
  );
  assert.equal(validateJsonSchema("write", { const: "read" }).length, 1);
  assert.equal(
    validateJsonSchema(0, { type: "number", exclusiveMinimum: 1 }).length,
    1,
  );
  assert.equal(
    validateJsonSchema(10, { type: "number", exclusiveMaximum: 10 }).length,
    1,
  );
  assert.equal(validateJsonSchema("a", { not: { type: "string" } }).length, 1);
  assert.equal(
    validateJsonSchema(
      { a: "str" },
      { type: "object", additionalProperties: { type: "number" } },
    ).length,
    1,
  );
  assert.equal(
    validateJsonSchema(
      [1, "x"],
      { type: "array", items: [{ type: "number" }, { type: "number" }] },
    ).length,
    1,
  );
  assert.deepEqual(
    validateJsonSchema(
      { "x-1": 5 },
      {
        type: "object",
        patternProperties: { "^x-": { type: "number" } },
        additionalProperties: false,
      },
    ),
    [],
  );
});
