#!/usr/bin/env node
// MCP server for the Pi delivery tools. Serves the same host-neutral definitions Pi registers
// (src/tools/*/tools.mjs) over MCP stdio, so Claude Code and VS Code can use them.
//
//   node mcp/server.mjs            runs in the current directory (the repository to deliver in)
//
// No tool opens a dialog: approvals are given in chat (see the approval tools' descriptions). See ../src/lib/host/mcp.mjs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";
import { Type } from "typebox";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpCaller, mcpToolList, projectDirectory } from "../src/lib/host/mcp.mjs";
import { createCheckpointTools } from "../src/tools/checkpoint/tools.mjs";
import { createExecuteAndReviewTools } from "../src/tools/execute-and-review/tools.mjs";
import { createExecutionRecoveryTools } from "../src/tools/execution-recovery/tools.mjs";
import { createFeatureValidationTools } from "../src/tools/feature-validation/tools.mjs";
import { createReviewTool } from "../src/tools/review/tool.mjs";
import { createScaffoldTools } from "../src/tools/scaffold/tools.mjs";

/** The plugin's version, from `.claude-plugin/plugin.json`, the single source of truth. */
export function pluginVersion() {
  try {
    const manifest = fileURLToPath(new URL("../.claude-plugin/plugin.json", import.meta.url));
    return JSON.parse(readFileSync(manifest, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** All delivery tools. */
export function deliveryTools() {
  return [
    ...createScaffoldTools(Type),
    ...createExecuteAndReviewTools(Type),
    ...createCheckpointTools(Type),
    ...createFeatureValidationTools(Type),
    ...createExecutionRecoveryTools(Type),
    createReviewTool(Type),
  ];
}

/** JSON Schema validation with a per-schema compile cache. `strict: false` tolerates TypeBox's extra keywords. */
export function createValidator() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const compiled = new WeakMap();
  return (schema, value) => {
    let check = compiled.get(schema);
    if (!check) compiled.set(schema, (check = ajv.compile(schema)));
    return check(value) ? true : check.errors ?? ["invalid"];
  };
}

export function createDeliveryServer({ cwd = process.cwd(), tools = deliveryTools(), heartbeatMs } = {}) {
  const server = new Server({ name: "pi-delivery", version: pluginVersion() }, { capabilities: { tools: {} } });
  const list = mcpToolList(tools);
  const call = createMcpCaller(tools, { cwd: path.resolve(cwd), validate: createValidator(), heartbeatMs });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: list }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Progress heartbeats only if the client asked for progress by sending a token.
    const token = request.params._meta?.progressToken;
    const progress = token === undefined ? undefined : (n, message) =>
      extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message } });
    return call(request.params.name, request.params.arguments, { signal: extra?.signal, progress });
  });
  return server;
}

/** Serve over stdio in the current directory. `start.mjs` calls this after checking dependencies. */
export async function main(env = process.env) {
  await createDeliveryServer({ cwd: projectDirectory(env) }).connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
