// Pi adapter: presents host-neutral tools (./tool.mjs) to Pi's `registerTool`.
// This is the only place that knows Pi's `execute(toolCallId, params, signal, onUpdate, ctx)` shape.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { missingDependencies } from "./dependencies.mjs";
import { describeToolCall, piGuardVerdict } from "../guard/pi.mjs";

export const MCP_SERVER_NAME = "pidelivery";

// One real startup check per server per process: seven registrations in one Pi session must not spawn seven.
const startupChecks = new Map();

/**
 * Why `node <serverPath> --check` fails, or undefined if the server can start. This loads the full module
 * graph, so it also catches what the direct-dependency check cannot: a missing transitive dependency, a Node
 * too old for the SDK, a syntax error, or no `node` on PATH (Pi launches the server with plain `node`).
 */
function startupProblem(serverPath, env) {
  if (startupChecks.has(serverPath)) return startupChecks.get(serverPath);
  const run = spawnSync("node", [serverPath, "--check"], {
    encoding: "utf8", timeout: 30000, windowsHide: true, env: { ...process.env, ...env }, cwd: path.dirname(serverPath),
  });
  let problem;
  if (run.error?.code === "ENOENT") problem = "`node` was not found on PATH";
  else if (run.error?.code === "ETIMEDOUT") problem = "the startup check timed out";
  else if (run.error) problem = run.error.message;
  else if (run.status !== 0) {
    const line = (run.stderr ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).find((l) => /error|cannot|missing|not installed/i.test(l))
      ?? (run.stderr ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    problem = line ? line.slice(0, 240) : `exit code ${run.status}`;
  }
  startupChecks.set(serverPath, problem);
  return problem;
}

/**
 * Whether the delivery MCP server can serve Pi. MCP is the only way Pi gets the delivery tools, so there is no native fallback: when the server cannot
 * start, `ok` is false and `warning` says why, and the extension reports it instead of registering a server
 * that would only show up disconnected. The server is actually started (`start.mjs --check`), which catches a
 * missing file, missing dependencies, a Node too old for the SDK, or no `node` on PATH. A server that dies later,
 * mid-session, is not covered: Pi shows it disconnected and reconnects on the next call.
 *
 * @returns {{ ok: boolean, serverPath: string, warning?: string }}
 */
export function deliveryServer({
  env = process.env,
  serverPath = env.PI_DELIVERY_MCP_SERVER || fileURLToPath(new URL("../../../mcp/start.mjs", import.meta.url)),
} = {}) {
  const unavailable = (why, fix = "") => ({ ok: false, serverPath, warning: `Delivery tools are unavailable: ${why}.${fix ? ` ${fix}` : ""}` });
  if (!existsSync(serverPath)) {
    return unavailable(`${serverPath} does not exist`, "Set PI_DELIVERY_MCP_SERVER to its location.");
  }
  let missing;
  try {
    missing = missingDependencies(path.dirname(serverPath));
  } catch (error) {
    return unavailable(`the MCP server could not be checked (${error.message})`);
  }
  if (missing.length) {
    return unavailable(`the MCP server's dependencies are not installed (${missing.join(", ")})`, `Run: npm ci --prefix "${path.dirname(path.dirname(serverPath))}"`);
  }
  const problem = startupProblem(serverPath, env);
  if (problem) return unavailable(`the MCP server could not start (${problem})`);
  return { ok: true, serverPath };
}

/**
 * The `mcpServers` entry Pi registers for the delivery server.
 *   exposure direct   Pi's default (codemode) hides tools from the model; delivery tools must be declared.
 *   timeout           Pi's 60 s default would cut off execute_and_review (workflows run up to 30 minutes).
 *   cwd "."           resolved by Pi against the session directory: the repository being delivered.
 */
export function deliveryMcpServerConfig(serverPath) {
  return {
    command: "node",
    args: [serverPath],
    cwd: ".",
    // CLAUDE_PROJECT_DIR is blanked so a value inherited from a Claude Code shell cannot redirect the server.
    env: { CLAUDE_PROJECT_DIR: "" },
    exposure: "direct",
    timeout: 3600,
    description: "Pi delivery pipeline: Scaffold task graph, execute_and_review, checkpoints, validation, recovery and review.",
  };
}

/**
 * The delivery guard's `tool_call` handler: `pi.on("tool_call", createToolCallGuard())` (pi/delivery-guard).
 *   deny -> { block: true, reason }       (the model reads the reason in the tool result and can adapt)
 *   ask  -> the user confirms in Pi's UI; no UI, a "no", a cancel or a crashed prompt all block
 *   pass -> undefined (Pi runs the tool; the guard never grants anything)
 * An unexpected error blocks the call: a guard that fails open is not a guard.
 */
export function createToolCallGuard({ env = process.env } = {}) {
  return async function toolCallGuard(event, ctx) {
    let verdict;
    try {
      verdict = piGuardVerdict(event, { cwd: ctx.cwd, env });
    } catch (error) {
      return { block: true, reason: `The delivery guard failed (${error?.message ?? error}); blocking the call.` };
    }
    if (verdict.decision === "pass") return undefined;
    if (verdict.decision === "deny") return { block: true, reason: verdict.reason };

    if (ctx.hasUI !== true) {
      return { block: true, reason: `${verdict.reason} Refused: there is no user interface to confirm it.` };
    }
    let confirmed = false;
    try {
      // Exactly `true` approves; a truthy non-boolean must not.
      confirmed = (await ctx.ui.confirm("Confirm this action?", `${describeToolCall(event)}\n\n${verdict.reason}`)) === true;
    } catch { /* a broken prompt is a refusal */ }
    return confirmed ? undefined : { block: true, reason: `The user did not confirm this action. ${verdict.reason}` };
  };
}
