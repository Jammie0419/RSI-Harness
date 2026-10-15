import { resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function resolveInside(root, path = ".") {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, path);
  if (
    absolutePath !== absoluteRoot &&
    !absolutePath.startsWith(`${absoluteRoot}${sep}`)
  ) {
    throw new Error(`MCP cwd escapes runtime root: ${path}`);
  }
  return absolutePath;
}

function toolText(result) {
  return (result.content ?? [])
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "resource") return JSON.stringify(item.resource);
      return JSON.stringify(item);
    })
    .join("\n");
}

function assertToolName(name, label) {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`${label} resolves to invalid Harness tool name "${name}".`);
  }
}

export async function createMcpTools({ cwd, genome }) {
  const tools = [];
  const clients = [];
  const errors = [];

  for (const server of genome.mcp?.servers ?? []) {
    if (server.enabled === false) continue;
    // One server that will not start -- a command this machine does not have,
    // say -- must not take the whole inline extension down with it: the tools
    // that did connect stay, and the failure is reported by the caller.
    const serverTools = [];
    let client;
    try {
      if (!server.command) {
        throw new Error("requires a command");
      }
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: server.env,
        cwd: resolveInside(cwd, server.cwd),
        stderr: "inherit",
      });
      client = new Client({ name: "rsih", version: "0.1.0" }, { capabilities: {} });
      await client.connect(transport);
      clients.push(client);
      const listed = await client.listTools();
      const configured = new Map(
        (server.tools ?? []).map((tool) => [tool.name, tool]),
      );

      for (const discovered of listed.tools) {
        const config = configured.get(discovered.name);
        if (server.tools && !config) continue;
        if (config?.enabled === false) continue;
        const name =
          config?.expose_as ?? `${server.name}_${discovered.name}`;
        assertToolName(name, `MCP tool "${server.name}.${discovered.name}"`);
        serverTools.push({
          name,
          source: "mcp",
          description: config?.description ?? discovered.description ?? "",
          parameters: config?.parameters ?? discovered.inputSchema,
          async execute(args, { signal } = {}) {
            const result = await client.callTool(
              {
                name: discovered.name,
                arguments: args,
              },
              undefined,
              { signal },
            );
            if (result.isError) {
              throw new Error(toolText(result) || `MCP tool ${discovered.name} failed.`);
            }
            return toolText(result);
          },
        });
      }
    } catch (error) {
      if (client && clients.includes(client)) {
        await Promise.allSettled([client.close()]);
        clients.splice(clients.indexOf(client), 1);
      }
      errors.push(
        `${server.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    tools.push(...serverTools);
  }

  return {
    tools,
    errors,
    close: () => Promise.allSettled(clients.map((client) => client.close())),
  };
}
