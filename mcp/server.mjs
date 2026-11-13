#!/usr/bin/env node
// MCP server for the Pi delivery tools. Serves the same host-neutral definitions Pi registers
// (agent/extensions/*/tools.mjs) over MCP stdio, so Claude Code and VS Code can use them.
//
//   node mcp/server.mjs            runs in the current directory (the repository to deliver in)
//
// Approvals (`approve_feature_direction`, `approve_delivery_amendment`, `adopt_foreign_commits`) are asked
// through MCP elicitation, which the host shows to the human. A client without elicitation cannot approve:
// the tools fail closed. See ../agent/lib/host/mcp.mjs.
import path from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import { Type } from "typebox";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpCaller, mcpToolList, projectDirectory } from "../agent/lib/host/mcp.mjs";
import { createCheckpointTools } from "../agent/extensions/checkpoint/tools.mjs";
import { createExecuteAndReviewTools } from "../agent/extensions/execute-and-review/tools.mjs";
import { createExecutionRecoveryTools } from "../agent/extensions/execution-recovery/tools.mjs";
import { createFeatureValidationTools } from "../agent/extensions/feature-validation/tools.mjs";
import { createReviewTool } from "../agent/extensions/review/tool.mjs";
import { createScaffoldTools } from "../agent/extensions/scaffold/tools.mjs";

/** All delivery tools. `includeInteractive: false` omits the approval tools, for hosts that keep those native. */
export function deliveryTools({ includeInteractive = true } = {}) {
  const tools = [
    ...createScaffoldTools(Type),
    ...createExecuteAndReviewTools(Type),
    ...createCheckpointTools(Type),
    ...createFeatureValidationTools(Type),
    ...createExecutionRecoveryTools(Type),
    createReviewTool(Type),
  ];
  return includeInteractive ? tools : tools.filter((tool) => !tool.interactive);
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

// A person reading a design before approving it needs far longer than the SDK's 60 s default request timeout.
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Ask the human through the client. Resolves true only for an explicit accept with `approve: true`; every
 * other outcome throws an Error whose message says why, which the caller turns into a refusal plus a reason
 * (a bare `false` made "no elicitation support", "timed out" and "declined" indistinguishable).
 */
export function elicitApproval(server, { timeoutMs = APPROVAL_TIMEOUT_MS } = {}) {
  return async (title, message) => {
    if (!server.getClientCapabilities()?.elicitation)
      throw new Error("this MCP client does not advertise elicitation, so no approval prompt can be shown to the user");
    let answer;
    try {
      answer = await server.elicitInput({
        message: `${title}\n\n${message}`,
        requestedSchema: {
          type: "object",
          properties: { approve: { type: "boolean", title: "Approve", description: "Tick to approve, then submit" } },
          required: ["approve"],
        },
      }, { timeout: timeoutMs });
    } catch (error) {
      throw new Error(`the approval prompt could not be completed (${error instanceof Error ? error.message : String(error)})`);
    }
    if (answer.action === "decline") throw new Error("the user declined the approval prompt");
    if (answer.action !== "accept")
      throw new Error("the approval prompt was cancelled or dismissed (Claude Code cancels MCP prompts in non-interactive runs, and an Elicitation hook can cancel them automatically)");
    if (answer.content?.approve !== true) throw new Error("the approval prompt was submitted with Approve left unticked");
    return true;
  };
}

export function createDeliveryServer({ cwd = process.cwd(), tools = deliveryTools(), heartbeatMs } = {}) {
  const server = new Server({ name: "pi-delivery", version: "0.1.0" }, { capabilities: { tools: {} } });
  const list = mcpToolList(tools);
  const call = createMcpCaller(tools, { cwd: path.resolve(cwd), validate: createValidator(), confirm: elicitApproval(server), heartbeatMs });
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
  const tools = deliveryTools({ includeInteractive: env.PI_DELIVERY_MCP_OMIT_INTERACTIVE !== "1" });
  await createDeliveryServer({ tools, cwd: projectDirectory(env) }).connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
